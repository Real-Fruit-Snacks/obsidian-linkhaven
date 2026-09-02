import { Debouncer, ItemView, WorkspaceLeaf, debounce, setIcon } from 'obsidian';
import type LinkhavenPlugin from '../main';
import { Filter, SmartId, VIEW_TYPE_TREE } from '../types';

interface TreeNode {
	name: string;
	path: string;
	children: Map<string, TreeNode>;
	count: number;
}

const SMART_ROWS: { id: SmartId; label: string; icon: string }[] = [
	{ id: 'inbox', label: 'Inbox', icon: 'inbox' },
	{ id: 'pinned', label: 'Pinned', icon: 'pin' },
	{ id: 'unread', label: 'Unread', icon: 'mail' },
	{ id: 'recent', label: 'Recent', icon: 'clock' },
];

export class CollectionTreeView extends ItemView {
	private plugin: LinkhavenPlugin;
	private unsubscribe: (() => void) | null = null;
	private listsEl: HTMLElement | null = null;
	private query = '';
	private renderDebounced: Debouncer<[], void>;

	constructor(leaf: WorkspaceLeaf, plugin: LinkhavenPlugin) {
		super(leaf);
		this.plugin = plugin;
		this.renderDebounced = debounce(() => this.renderLists(), 150, true);
	}

	getViewType(): string {
		return VIEW_TYPE_TREE;
	}

	getDisplayText(): string {
		return 'Bookmark collections';
	}

	getIcon(): string {
		return 'bookmark';
	}

	async onOpen(): Promise<void> {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('lh-tree');

		const header = contentEl.createDiv({ cls: 'lh-tree-header' });
		const input = header.createEl('input', {
			cls: 'lh-tree-filter',
			attr: { type: 'text', placeholder: 'Filter bookmarks' },
		});
		this.registerDomEvent(input, 'input', () => {
			this.query = input.value;
			this.plugin.setGridQuery(input.value);
			this.renderDebounced();
		});

		this.listsEl = contentEl.createDiv({ cls: 'lh-tree-lists' });
		this.registerDomEvent(this.listsEl, 'click', (e: MouseEvent) => {
			const el = (e.target as HTMLElement).closest<HTMLElement>('[data-lh-action]');
			if (!el) return;
			const action = el.dataset['bnAction'];
			if (action === 'toggle') {
				void this.toggleCollapsed(el.dataset['path'] ?? '');
			} else if (action === 'filter') {
				this.applyRowFilter(el);
			}
		});

		this.unsubscribe = this.plugin.store.subscribe(this.renderDebounced);
		this.renderLists();
	}

	async onClose(): Promise<void> {
		this.unsubscribe?.();
		this.unsubscribe = null;
		this.renderDebounced.cancel();
	}

	/** Called by the plugin when the active filter changes. */
	refresh(): void {
		this.renderLists();
	}

	private applyRowFilter(el: HTMLElement): void {
		const kind = el.dataset['kind'];
		let filter: Filter = { kind: 'all' };
		if (kind === 'collection') filter = { kind: 'collection', path: el.dataset['value'] ?? '' };
		else if (kind === 'smart') filter = { kind: 'smart', id: (el.dataset['value'] ?? 'inbox') as SmartId };
		else if (kind === 'tag') filter = { kind: 'tag', tag: el.dataset['value'] ?? '' };
		this.plugin.setFilter(filter);
		void this.plugin.openGrid();
	}

	private async toggleCollapsed(path: string): Promise<void> {
		const collapsed = this.plugin.settings.collapsedNodes;
		const i = collapsed.indexOf(path);
		if (i >= 0) collapsed.splice(i, 1);
		else collapsed.push(path);
		await this.plugin.saveSettings();
		this.renderLists();
	}

	private filterLabel(): string {
		const f = this.plugin.filter;
		switch (f.kind) {
			case 'all':
				return 'all';
			case 'collection':
				return `collection:${f.path}`;
			case 'smart':
				return `smart:${f.id}`;
			case 'tag':
				return `tag:${f.tag}`;
		}
	}

	private row(
		parent: HTMLElement,
		label: string,
		iconName: string,
		count: number | null,
		kind: string,
		value: string,
		extraCls?: string
	): void {
		const row = parent.createDiv({ cls: `lh-tree-row${extraCls ? ` ${extraCls}` : ''}` });
		row.dataset['bnAction'] = 'filter';
		row.dataset['kind'] = kind;
		row.dataset['value'] = value;
		if (this.filterLabel() === `${kind}:${value}` || (kind === 'all' && this.plugin.filter.kind === 'all')) {
			row.addClass('is-active');
		}
		const icon = row.createSpan({ cls: 'lh-tree-icon' });
		icon.setAttribute('aria-hidden', 'true');
		setIcon(icon, iconName);
		row.createSpan({ cls: 'lh-tree-label', text: label });
		if (count !== null) row.createSpan({ cls: 'lh-tree-count', text: String(count) });
	}

	private renderLists(): void {
		const lists = this.listsEl;
		if (!lists || !this.contentEl.isConnected) return;
		lists.empty();
		const store = this.plugin.store;
		const q = this.query.trim().toLowerCase();

		if (store.all().length === 0) {
			const empty = lists.createDiv({ cls: 'lh-empty' });
			empty.createEl('p', { text: 'No bookmarks yet' });
			empty.createEl('p', {
				text: 'Save a link with the add bookmark command, the Obsidian:// uri, or the web clipper.',
				cls: 'lh-muted',
			});
			return;
		}

		// Views section
		const views = lists.createDiv({ cls: 'lh-tree-section' });
		views.createDiv({ cls: 'lh-tree-heading', text: 'Views' });
		this.row(views, 'All bookmarks', 'bookmark', store.all().length, 'all', '');
		for (const smart of SMART_ROWS) {
			const count =
				smart.id === 'recent'
					? null
					: store.filter({ kind: 'smart', id: smart.id }).length;
			this.row(views, smart.label, smart.icon, count, 'smart', smart.id);
		}

		// Collections section
		const root = this.buildCollectionTree(q);
		const collSection = lists.createDiv({ cls: 'lh-tree-section' });
		collSection.createDiv({ cls: 'lh-tree-heading', text: 'Collections' });
		if (root.children.size === 0) {
			collSection.createDiv({
				cls: 'lh-muted lh-tree-none',
				text: q ? 'No collections match' : 'No collections yet',
			});
		} else {
			for (const node of this.sortedChildren(root)) {
				this.renderCollectionNode(collSection, node);
			}
		}

		// Tags section
		const tags = store.tags().filter((t) => !q || t.toLowerCase().includes(q));
		const tagSection = lists.createDiv({ cls: 'lh-tree-section' });
		tagSection.createDiv({ cls: 'lh-tree-heading', text: 'Tags' });
		if (tags.length === 0) {
			tagSection.createDiv({
				cls: 'lh-muted lh-tree-none',
				text: q ? 'No tags match' : 'No tags yet',
			});
		} else {
			for (const tag of tags) {
				const count = store.filter({ kind: 'tag', tag }).length;
				this.row(tagSection, tag, 'tag', count, 'tag', tag);
			}
		}
	}

	private buildCollectionTree(query: string): TreeNode {
		const store = this.plugin.store;
		const counts = new Map<string, number>();
		for (const record of store.all()) {
			if (!record.collection) continue;
			const parts = record.collection.split('/');
			for (let i = 1; i <= parts.length; i++) {
				const prefix = parts.slice(0, i).join('/');
				counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
			}
		}
		const root: TreeNode = { name: '', path: '', children: new Map(), count: 0 };
		const visible = new Set<string>();
		if (query) {
			for (const path of counts.keys()) {
				if (!path.toLowerCase().includes(query)) continue;
				const parts = path.split('/');
				for (let i = 1; i <= parts.length; i++) visible.add(parts.slice(0, i).join('/'));
			}
		}
		for (const path of counts.keys()) {
			if (query && !visible.has(path)) continue;
			const parts = path.split('/');
			let node = root;
			for (let i = 0; i < parts.length; i++) {
				const partPath = parts.slice(0, i + 1).join('/');
				const partName = parts[i] ?? '';
				let child = node.children.get(partName);
				if (!child) {
					child = { name: partName, path: partPath, children: new Map(), count: 0 };
					node.children.set(partName, child);
				}
				child.count = counts.get(partPath) ?? 0;
				node = child;
			}
		}
		return root;
	}

	private sortedChildren(node: TreeNode): TreeNode[] {
		return Array.from(node.children.values()).sort((a, b) => a.name.localeCompare(b.name));
	}

	private renderCollectionNode(parent: HTMLElement, node: TreeNode): void {
		const collapsed = this.plugin.settings.collapsedNodes.includes(node.path);
		const hasChildren = node.children.size > 0;
		const wrap = parent.createDiv({ cls: 'lh-tree-node' });
		const row = wrap.createDiv({ cls: 'lh-tree-row lh-tree-collection' });
		row.dataset['bnAction'] = 'filter';
		row.dataset['kind'] = 'collection';
		row.dataset['value'] = node.path;
		if (this.filterLabel() === `collection:${node.path}`) row.addClass('is-active');

		if (hasChildren) {
			const arrow = row.createSpan({ cls: 'lh-tree-arrow' });
			arrow.dataset['bnAction'] = 'toggle';
			arrow.dataset['path'] = node.path;
			arrow.setAttribute('aria-label', collapsed ? 'Expand' : 'Collapse');
			setIcon(arrow, collapsed ? 'chevron-right' : 'chevron-down');
		} else {
			row.createSpan({ cls: 'lh-tree-arrow lh-tree-arrow-empty' });
		}
		row.createSpan({ cls: 'lh-tree-label', text: node.name });
		row.createSpan({ cls: 'lh-tree-count', text: String(node.count) });

		if (hasChildren && !collapsed) {
			const childrenEl = wrap.createDiv({ cls: 'lh-tree-children' });
			for (const child of this.sortedChildren(node)) {
				this.renderCollectionNode(childrenEl, child);
			}
		}
	}
}
