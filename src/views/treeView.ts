import { Debouncer, ItemView, Menu, Notice, WorkspaceLeaf, debounce, setIcon } from 'obsidian';
import type LinkhavenPlugin from '../main';
import { ConfirmModal, IconPickerModal, TextInputModal, iconButton } from '../modals';
import {
	addCollection,
	addTagToBookmark,
	deleteCollection,
	removeTag,
	renameCollection,
	renameTag,
} from '../ops';
import { LongPressMenu } from '../longPressMenu';
import { Filter, SmartId, VIEW_TYPE_TREE } from '../types';
import { sanitizeCollectionPart } from '../utils';

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
	private longPressMenu: LongPressMenu | null = null;
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
		// Right-click / long-press context menus on collection and tag rows.
		this.longPressMenu = new LongPressMenu(this, this.listsEl, '[data-lh-menu]', (row, anchor) =>
			this.showRowMenu(row, anchor)
		);
		this.registerDomEvent(this.listsEl, 'click', (e: MouseEvent) => {
			// A long-press just opened a menu; swallow the synthetic click.
			if (this.longPressMenu?.swallowClick(e)) return;
			const el = (e.target as HTMLElement).closest<HTMLElement>('[data-lh-action]');
			if (!el) return;
			const action = el.dataset['lhAction'];
			if (action === 'toggle') {
				void this.toggleCollapsed(el.dataset['path'] ?? '');
			} else if (action === 'filter') {
				this.applyRowFilter(el);
			} else if (action === 'new-collection') {
				this.promptNewCollection('');
			}
		});
		// Drag-and-drop filing: cards from the grid are dropped onto collection
		// rows (data-lh-drop = collection path), the Inbox row (empty string),
		// or tag rows (data-lh-drop-tag = tag, adds the tag to the bookmark).
		this.registerDomEvent(this.listsEl, 'dragover', (e: DragEvent) => {
			const row = (e.target as HTMLElement).closest<HTMLElement>(
				'[data-lh-drop], [data-lh-drop-tag]'
			);
			// Only offer the drop affordance for in-app drags (note paths), so
			// OS file drags don't light up rows they can't use.
			if (!row || !e.dataTransfer || !e.dataTransfer.types.includes('text/plain')) return;
			e.preventDefault();
			e.dataTransfer.dropEffect = 'move';
			this.clearDropTargets(row);
			row.addClass('lh-drop-target');
		});
		this.registerDomEvent(this.listsEl, 'dragleave', (e: DragEvent) => {
			const row = (e.target as HTMLElement).closest<HTMLElement>(
				'[data-lh-drop], [data-lh-drop-tag]'
			);
			if (!row) return;
			const related = e.relatedTarget as Node | null;
			if (related && row.contains(related)) return;
			row.removeClass('lh-drop-target');
		});
		// Esc-cancelled drags don't reliably fire dragleave on the hovered row.
		// dragend fires on the drag source (a grid card, outside listsEl), so
		// listen globally and sweep any stale highlight.
		this.registerDomEvent(document, 'dragend', () => this.clearDropTargets());
		this.registerDomEvent(this.listsEl, 'drop', (e: DragEvent) => {
			const row = (e.target as HTMLElement).closest<HTMLElement>(
				'[data-lh-drop], [data-lh-drop-tag]'
			);
			if (!row || !e.dataTransfer) return;
			e.preventDefault();
			row.removeClass('lh-drop-target');
			const notePath = e.dataTransfer.getData('text/plain');
			const tag = row.dataset['lhDropTag'];
			if (tag !== undefined) {
				void this.handleTagDrop(tag, notePath);
			} else {
				void this.handleDrop(row.dataset['lhDrop'] ?? '', notePath);
			}
		});

		this.unsubscribe = this.plugin.store.subscribe(this.renderDebounced);
		this.renderLists();
	}

	async onClose(): Promise<void> {
		this.unsubscribe?.();
		this.unsubscribe = null;
		this.longPressMenu?.unload();
		this.renderDebounced.cancel();
	}

	/** Remove the drop-target highlight from every row except `except`. */
	private clearDropTargets(except?: HTMLElement): void {
		if (!this.listsEl) return;
		this.listsEl.querySelectorAll<HTMLElement>('.lh-drop-target').forEach((el) => {
			if (el !== except) el.removeClass('lh-drop-target');
		});
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
	): HTMLElement {
		const row = parent.createDiv({ cls: `lh-tree-row${extraCls ? ` ${extraCls}` : ''}` });
		row.dataset['lhAction'] = 'filter';
		row.dataset['kind'] = kind;
		row.dataset['value'] = value;
		// Only the Inbox smart row is a drop target; other smart rows are not.
		if (kind === 'smart' && value === 'inbox') row.dataset['lhDrop'] = '';
		if (kind === 'tag') {
			row.dataset['lhMenu'] = 'tag';
			// Tag rows are drop targets: dropping a card adds the tag.
			row.dataset['lhDropTag'] = value;
		}
		if (this.filterLabel() === `${kind}:${value}` || (kind === 'all' && this.plugin.filter.kind === 'all')) {
			row.addClass('is-active');
		}
		const icon = row.createSpan({ cls: 'lh-tree-icon' });
		icon.setAttribute('aria-hidden', 'true');
		setIcon(icon, iconName);
		row.createSpan({ cls: 'lh-tree-label', text: label });
		if (count !== null) row.createSpan({ cls: 'lh-tree-count', text: String(count) });
		return row;
	}

	private renderLists(): void {
		const lists = this.listsEl;
		if (!lists || !this.contentEl.isConnected) return;
		lists.empty();
		const store = this.plugin.store;
		const q = this.query.trim().toLowerCase();

		if (store.all().length === 0 && this.plugin.settings.knownCollections.length === 0) {
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

		// Collections section (with a "+" button for new root collections)
		const root = this.buildCollectionTree(q);
		const collSection = lists.createDiv({ cls: 'lh-tree-section' });
		const collHeading = collSection.createDiv({ cls: 'lh-tree-heading lh-tree-heading-row' });
		collHeading.createSpan({ text: 'Collections' });
		const addBtn = iconButton(collHeading, 'plus', 'New collection');
		addBtn.dataset['lhAction'] = 'new-collection';
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
		// Union note-derived paths with known (possibly empty) collections.
		const allPaths = new Set<string>([...counts.keys(), ...store.collections()]);
		const visible = new Set<string>();
		if (query) {
			for (const path of allPaths) {
				if (!path.toLowerCase().includes(query)) continue;
				const parts = path.split('/');
				for (let i = 1; i <= parts.length; i++) visible.add(parts.slice(0, i).join('/'));
			}
		}
		for (const path of allPaths) {
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
		row.dataset['lhAction'] = 'filter';
		row.dataset['kind'] = 'collection';
		row.dataset['value'] = node.path;
		row.dataset['lhMenu'] = 'collection';
		row.dataset['lhDrop'] = node.path;
		if (this.filterLabel() === `collection:${node.path}`) row.addClass('is-active');

		if (hasChildren) {
			const arrow = row.createSpan({ cls: 'lh-tree-arrow' });
			arrow.dataset['lhAction'] = 'toggle';
			arrow.dataset['path'] = node.path;
			arrow.setAttribute('aria-label', collapsed ? 'Expand' : 'Collapse');
			setIcon(arrow, collapsed ? 'chevron-right' : 'chevron-down');
		} else {
			row.createSpan({ cls: 'lh-tree-arrow lh-tree-arrow-empty' });
		}
		// Assigned collection icon (settings.collectionIcons) replaces the
		// default folder icon.
		const iconEl = row.createSpan({ cls: 'lh-tree-icon' });
		iconEl.setAttribute('aria-hidden', 'true');
		setIcon(iconEl, this.plugin.settings.collectionIcons[node.path] ?? 'folder');
		row.createSpan({ cls: 'lh-tree-label', text: node.name });
		row.createSpan({ cls: 'lh-tree-count', text: String(node.count) });

		if (hasChildren && !collapsed) {
			const childrenEl = wrap.createDiv({ cls: 'lh-tree-children' });
			for (const child of this.sortedChildren(node)) {
				this.renderCollectionNode(childrenEl, child);
			}
		}
	}

	/* ---------- Context menus (right-click / long-press) ---------- */

	private showRowMenu(row: HTMLElement, anchor: MouseEvent | { x: number; y: number }): void {
		const kind = row.dataset['lhMenu'];
		const value = row.dataset['value'] ?? '';
		let menu: Menu | null = null;
		if (kind === 'collection') menu = this.collectionMenu(value);
		else if (kind === 'tag') menu = this.tagMenu(value);
		if (!menu) return;
		if (anchor instanceof MouseEvent) {
			menu.showAtMouseEvent(anchor);
		} else {
			menu.showAtPosition(anchor);
		}
	}

	private collectionMenu(path: string): Menu {
		const menu = new Menu()
			.addItem((item) =>
				item
					.setTitle('New subcollection')
					.setIcon('folder-plus')
					.onClick(() => this.promptNewCollection(path))
			)
			.addItem((item) =>
				item
					.setTitle('Change icon')
					.setIcon('smile')
					.onClick(() => this.promptCollectionIcon(path))
			);
		// "Remove icon" only appears while an icon is assigned.
		if (this.plugin.settings.collectionIcons[path]) {
			menu.addItem((item) =>
				item
					.setTitle('Remove icon')
					.setIcon('folder')
					.onClick(() => void this.setCollectionIcon(path, null))
			);
		}
		return menu
			.addItem((item) =>
				item
					.setTitle('Rename')
					.setIcon('pencil')
					.onClick(() => this.promptRenameCollection(path))
			)
			.addItem((item) =>
				item
					.setTitle('Delete')
					.setIcon('trash')
					.onClick(() => this.confirmDeleteCollection(path))
			);
	}

	private tagMenu(tag: string): Menu {
		return new Menu()
			.addItem((item) =>
				item
					.setTitle('Rename tag')
					.setIcon('pencil')
					.onClick(() => this.promptRenameTag(tag))
			)
			.addItem((item) =>
				item
					.setTitle('Remove tag everywhere')
					.setIcon('trash')
					.onClick(() => this.confirmRemoveTag(tag))
			);
	}

	/* ---------- Collection management ---------- */

	private promptNewCollection(parent: string): void {
		new TextInputModal(this.app, {
			title: parent ? 'New subcollection' : 'New collection',
			placeholder: parent ? 'Name' : 'Dev/Tools',
			cta: 'Create',
			validate: (value) => this.validateCollectionInput(value, parent),
			onSubmit: (value) => void this.createCollection(parent, value),
		}).open();
	}

	private async createCollection(parent: string, value: string): Promise<void> {
		const parts = value
			.split('/')
			.map((part) => part.trim())
			.filter((part) => part.length > 0);
		const path = parent ? `${parent}/${parts.join('/')}` : parts.join('/');
		await addCollection(this.plugin.settings, path);
		await this.plugin.saveSettings();
		this.renderLists();
	}

	private promptCollectionIcon(path: string): void {
		new IconPickerModal(
			this.app,
			this.plugin.settings.collectionIcons[path] ?? null,
			(icon) => void this.setCollectionIcon(path, icon)
		).open();
	}

	/** Assign (or clear, when null) a collection's icon, persist, re-render. */
	private async setCollectionIcon(path: string, icon: string | null): Promise<void> {
		if (icon) {
			this.plugin.settings.collectionIcons[path] = icon;
		} else {
			delete this.plugin.settings.collectionIcons[path];
		}
		await this.plugin.saveSettings();
		this.renderLists();
	}

	private promptRenameCollection(path: string): void {
		const lastSegment = path.split('/').pop() ?? path;
		new TextInputModal(this.app, {
			title: 'Rename collection',
			placeholder: 'Name',
			value: lastSegment,
			cta: 'Rename',
			validate: (value) => this.validateCollectionInput(value, parentPathOf(path), path),
			onSubmit: (value) => {
				const parent = parentPathOf(path);
				const to = parent ? `${parent}/${value}` : value;
				void this.runCollectionOp(() =>
					renameCollection(this.app, this.plugin.store, this.plugin.settings, path, to)
				);
			},
		}).open();
	}

	private confirmDeleteCollection(path: string): void {
		const count = this.plugin.store.filter({ kind: 'collection', path }).length;
		new ConfirmModal(
			this.app,
			`Delete collection "${path}"? ${count} bookmarks move to Inbox. Notes are not deleted.`,
			() =>
				void this.runCollectionOp(() =>
					deleteCollection(this.app, this.plugin.store, this.plugin.settings, path)
				),
			{ confirmText: 'Delete', destructive: true }
		).open();
	}

	/** Shared tail for collection ops: persist knownCollections, re-render. */
	private async runCollectionOp(
		op: () => Promise<{ updated: number; failed: number }>
	): Promise<void> {
		await op();
		await this.plugin.saveSettings();
		this.renderLists();
	}

	/**
	 * Validate a collection name input: non-empty, every segment passes
	 * sanitizeCollectionPart unchanged, and the resulting path (with the
	 * optional parent prefix) is not a duplicate.
	 */
	private validateCollectionInput(value: string, parent: string, allowPath?: string): string | null {
		const parts = value
			.split('/')
			.map((part) => part.trim())
			.filter((part) => part.length > 0);
		if (parts.length === 0) return 'Enter a collection name';
		if (parts.some((part) => sanitizeCollectionPart(part) !== part)) {
			return 'Collection names cannot contain \\ : * ? " < > | # [ ] ^';
		}
		const full = parent ? `${parent}/${parts.join('/')}` : parts.join('/');
		if (allowPath !== undefined && full === allowPath) return 'Name is unchanged';
		if (this.plugin.store.collections().includes(full)) {
			return 'Collection already exists';
		}
		return null;
	}

	/* ---------- Tag management ---------- */

	private promptRenameTag(tag: string): void {
		new TextInputModal(this.app, {
			title: 'Rename tag',
			placeholder: 'Name',
			value: tag,
			cta: 'Rename',
			validate: (value) => {
				if (!value) return 'Enter a tag name';
				if (value === tag) return 'Name is unchanged';
				if (this.plugin.store.tags().includes(value)) return 'Tag already exists';
				return null;
			},
			onSubmit: (value) => {
				void renameTag(this.app, this.plugin.store, tag, value).then(() =>
					this.renderLists()
				);
			},
		}).open();
	}

	private confirmRemoveTag(tag: string): void {
		const count = this.plugin.store.filter({ kind: 'tag', tag }).length;
		new ConfirmModal(
			this.app,
			`Remove tag "${tag}" from ${count} bookmarks?`,
			() => {
				void removeTag(this.app, this.plugin.store, tag).then(() => this.renderLists());
			},
			{ confirmText: 'Remove', destructive: true }
		).open();
	}

	/* ---------- Drag-and-drop filing ---------- */

	private async handleDrop(collection: string, notePath: string): Promise<void> {
		if (!notePath) return;
		const file = this.app.vault.getFileByPath(notePath);
		const record = this.plugin.store.all().find((r) => r.path === notePath);
		if (!file || !record || record.collection === collection) return;
		await this.app.fileManager.processFrontMatter(file, (m: Record<string, unknown>) => {
			if (collection) {
				m['collection'] = collection;
			} else {
				delete m['collection'];
			}
		});
		new Notice(collection ? `Moved to ${collection}` : 'Moved to Inbox');
	}

	/** Drop target: a tag row. Adds the tag to the dragged bookmark. */
	private async handleTagDrop(tag: string, notePath: string): Promise<void> {
		if (!notePath || !tag) return;
		const file = this.app.vault.getFileByPath(notePath);
		if (!file) return;
		await addTagToBookmark(this.app, this.plugin.store, file, tag);
	}
}

function parentPathOf(path: string): string {
	const i = path.lastIndexOf('/');
	return i > 0 ? path.slice(0, i) : '';
}
