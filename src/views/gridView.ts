import { Debouncer, ItemView, Menu, Platform, WorkspaceLeaf, debounce, setIcon } from 'obsidian';
import type LinkhavenPlugin from '../main';
import { LongPressMenu, MenuAnchor } from '../longPressMenu';
import { BookmarkRecord, VIEW_TYPE_GRID } from '../types';
import { AddBookmarkModal, ConfirmModal, EditTagsModal, MoveToModal, iconButton } from '../modals';
import { deleteBookmarkCascade } from '../ops';
import { domainFromUrl } from '../utils';

const CHUNK_SIZE = 60;
const INITIAL_CAP = 300;

export class BookmarkGridView extends ItemView {
	private plugin: LinkhavenPlugin;
	private unsubscribe: (() => void) | null = null;
	private cardsEl: HTMLElement | null = null;
	private footerEl: HTMLElement | null = null;
	private labelEl: HTMLElement | null = null;
	private searchEl: HTMLInputElement | null = null;
	private toggleEl: HTMLElement | null = null;
	private query = '';
	private viewMode: 'grid' | 'list' = 'grid';
	private cardMenu: LongPressMenu | null = null;
	private shownCap = INITIAL_CAP;
	private renderToken = 0;
	private renderDebounced: Debouncer<[], void>;

	constructor(leaf: WorkspaceLeaf, plugin: LinkhavenPlugin) {
		super(leaf);
		this.plugin = plugin;
		this.renderDebounced = debounce(() => this.renderAll(false), 150, true);
	}

	getViewType(): string {
		return VIEW_TYPE_GRID;
	}

	getDisplayText(): string {
		return 'Bookmark grid';
	}

	getIcon(): string {
		return 'layout-grid';
	}

	async onOpen(): Promise<void> {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('lh-gridview');

		const toolbar = contentEl.createDiv({ cls: 'lh-toolbar' });
		this.labelEl = toolbar.createDiv({ cls: 'lh-toolbar-label' });
		this.searchEl = toolbar.createEl('input', {
			cls: 'lh-toolbar-search',
			attr: { type: 'text', placeholder: 'Search bookmarks' },
		});
		this.registerDomEvent(this.searchEl, 'input', () => {
			this.query = this.searchEl?.value ?? '';
			this.renderDebounced();
		});
		const addBtn = toolbar.createEl('button', { cls: 'lh-icon-btn clickable-icon' });
		addBtn.setAttribute('aria-label', 'Add bookmark');
		setIcon(addBtn, 'plus');
		this.registerDomEvent(addBtn, 'click', () => {
			new AddBookmarkModal(this.app, this.plugin).open();
		});
		const treeBtn = toolbar.createEl('button', { cls: 'lh-icon-btn clickable-icon' });
		treeBtn.setAttribute('aria-label', 'Open collection tree');
		setIcon(treeBtn, 'panel-left');
		this.registerDomEvent(treeBtn, 'click', () => void this.plugin.openTree());
		this.toggleEl = toolbar.createEl('button', { cls: 'lh-icon-btn clickable-icon' });
		this.toggleEl.setAttribute('aria-label', 'Toggle grid or list');
		setIcon(this.toggleEl, this.viewMode === 'grid' ? 'list' : 'layout-grid');
		this.registerDomEvent(this.toggleEl, 'click', () => {
			this.viewMode = this.viewMode === 'grid' ? 'list' : 'grid';
			if (this.toggleEl) setIcon(this.toggleEl, this.viewMode === 'grid' ? 'list' : 'layout-grid');
			this.renderAll(false);
		});

		this.cardsEl = contentEl.createDiv({ cls: 'lh-cards' });
		// Right-click (desktop) / long-press (mobile) context menu on cards.
		this.cardMenu = new LongPressMenu(this, this.cardsEl, '.lh-card', (card, anchor) =>
			this.showCardMenu(card, anchor)
		);
		this.registerDomEvent(this.cardsEl, 'click', (e: MouseEvent) => void this.onCardsClick(e));
		if (Platform.isDesktop) {
			// Drag source: the tree's collection rows and Inbox are the targets.
			this.registerDomEvent(this.cardsEl, 'dragstart', (e: DragEvent) => {
				const card = (e.target as HTMLElement).closest<HTMLElement>('.lh-card');
				const path = card?.dataset['path'];
				if (!card || !path || !e.dataTransfer) return;
				e.dataTransfer.setData('text/plain', path);
				e.dataTransfer.effectAllowed = 'move';
				card.addClass('lh-dragging');
			});
			this.registerDomEvent(this.cardsEl, 'dragend', (e: DragEvent) => {
				const card = (e.target as HTMLElement).closest<HTMLElement>('.lh-card');
				card?.removeClass('lh-dragging');
			});
		}
		this.footerEl = contentEl.createDiv({ cls: 'lh-footer' });

		this.unsubscribe = this.plugin.store.subscribe(this.renderDebounced);
		this.renderAll(false);
	}

	async onClose(): Promise<void> {
		this.unsubscribe?.();
		this.unsubscribe = null;
		this.cardMenu?.unload();
		this.renderDebounced.cancel();
		this.renderToken++;
	}

	/** Called by the plugin when the active filter changes. */
	refresh(): void {
		this.renderAll(true);
	}

	/** Called by the plugin when the tree forwards its filter text. */
	setExternalQuery(query: string): void {
		this.query = query;
		if (this.searchEl) this.searchEl.value = query;
		this.renderDebounced();
	}

	private currentRecords(): BookmarkRecord[] {
		const filter = this.plugin.filter;
		return this.plugin.store.filter(filter).filter((r) => this.plugin.store.matches(r, filter, this.query));
	}

	private renderAll(resetCap: boolean): void {
		if (!this.cardsEl || !this.contentEl.isConnected) return;
		if (resetCap) this.shownCap = INITIAL_CAP;
		this.renderLabel();
		const records = this.currentRecords();
		this.renderCards(records);
	}

	private renderLabel(): void {
		if (!this.labelEl) return;
		this.labelEl.empty();
		const f = this.plugin.filter;
		switch (f.kind) {
			case 'all':
				this.labelEl.createSpan({ text: 'All bookmarks' });
				break;
			case 'smart':
				this.labelEl.createSpan({
					text: f.id.charAt(0).toUpperCase() + f.id.slice(1),
				});
				break;
			case 'tag':
				this.labelEl.createSpan({ text: `#${f.tag}` });
				break;
			case 'collection': {
				// Prepend the assigned collection icon when one is set.
				const iconId = this.plugin.settings.collectionIcons[f.path];
				if (iconId) {
					const iconEl = this.labelEl.createSpan({ cls: 'lh-breadcrumb-icon' });
					iconEl.setAttribute('aria-hidden', 'true');
					setIcon(iconEl, iconId);
				}
				const parts = f.path.split('/');
				parts.forEach((part, i) => {
					if (i > 0) this.labelEl?.createSpan({ cls: 'lh-breadcrumb-sep', text: '/' });
					this.labelEl?.createSpan({ cls: 'lh-breadcrumb', text: part });
				});
				break;
			}
		}
	}

	private renderCards(records: BookmarkRecord[]): void {
		const cards = this.cardsEl;
		if (!cards) return;
		const token = ++this.renderToken;
		cards.empty();
		cards.toggleClass('lh-grid', this.viewMode === 'grid');
		cards.toggleClass('lh-list', this.viewMode === 'list');

		if (records.length === 0) {
			this.renderEmpty(cards);
			this.renderFooter(0, 0);
			return;
		}

		const cap = Math.min(records.length, this.shownCap);
		let index = 0;
		const step = (): void => {
			if (token !== this.renderToken || !this.cardsEl) return;
			const end = Math.min(index + CHUNK_SIZE, cap);
			for (; index < end; index++) {
				const record = records[index];
				if (record) this.cardsEl.appendChild(this.buildCard(record));
			}
			if (index < cap) {
				window.requestAnimationFrame(step);
			} else {
				this.renderFooter(records.length, cap);
			}
		};
		window.requestAnimationFrame(step);
	}

	private renderFooter(total: number, shown: number): void {
		if (!this.footerEl) return;
		this.footerEl.empty();
		if (total > shown) {
			this.footerEl.createSpan({ text: `Showing ${shown} of ${total}` });
			const more = this.footerEl.createEl('button', { text: 'Show more' });
			// Element-attached handler: dies with the element on re-render,
			// unlike registerDomEvent which would accumulate listeners.
			more.onclick = () => {
				this.shownCap += INITIAL_CAP;
				this.renderAll(false);
			};
		}
	}

	private renderEmpty(cards: HTMLElement): void {
		// Truly zero bookmarks (not a filtered- or search-empty): show the
		// first-run CTA. Also covers the known-collections-only state —
		// collections without links still mean nothing is saved yet.
		if (this.plugin.store.all().length > 0) {
			cards.createDiv({ cls: 'lh-empty', text: this.emptyText() });
			return;
		}
		const empty = cards.createDiv({ cls: 'lh-empty' });
		empty.createEl('p', { cls: 'lh-empty-title', text: 'No bookmarks yet' });
		const cta = empty.createEl('button', { cls: 'mod-cta', text: 'Add your first bookmark' });
		// Element-attached handler: dies with the element on re-render.
		cta.onclick = () => new AddBookmarkModal(this.app, this.plugin).open();
		empty.createDiv({
			cls: 'lh-empty-hint',
			text: 'Save from your browser with the Web Clipper, or share to Obsidian on mobile.',
		});
	}

	private emptyText(): string {
		if (this.query.trim()) return 'No matches';
		const f = this.plugin.filter;
		switch (f.kind) {
			case 'all':
				return 'No bookmarks yet';
			case 'collection':
				return 'No bookmarks in this collection';
			case 'tag':
				return 'No bookmarks with this tag';
			case 'smart':
				switch (f.id) {
					case 'inbox':
						return 'Inbox is clear';
					case 'pinned':
						return 'No pinned bookmarks';
					case 'unread':
						return 'Nothing unread';
					case 'recent':
						return 'Nothing recent';
				}
		}
	}

	private buildCard(record: BookmarkRecord): HTMLElement {
		const card = createDiv({ cls: 'lh-card' });
		card.dataset['path'] = record.path;
		// No HTML5 drag and drop on touch; the Move-to modal is the touch path.
		if (Platform.isDesktop) card.setAttribute('draggable', 'true');

		const cover = card.createDiv({ cls: 'lh-card-cover' });
		const coverFile = record.cover ? this.app.vault.getFileByPath(record.cover) : null;
		const faviconFile = record.favicon ? this.app.vault.getFileByPath(record.favicon) : null;
		if (coverFile) {
			cover.createEl('img', {
				cls: 'lh-card-img',
				attr: { src: this.app.vault.getResourcePath(coverFile), alt: '', loading: 'lazy' },
			});
		} else if (faviconFile) {
			const tile = cover.createDiv({ cls: 'lh-favicon-tile' });
			tile.createEl('img', {
				attr: { src: this.app.vault.getResourcePath(faviconFile), alt: '', loading: 'lazy' },
			});
		} else {
			const domain = domainFromUrl(record.url);
			cover.createDiv({
				cls: 'lh-letter-tile',
				text: (domain.charAt(0) || '?').toUpperCase(),
			});
		}

		const body = card.createDiv({ cls: 'lh-card-body' });
		body.createDiv({
			cls: 'lh-card-title',
			text: record.title || domainFromUrl(record.url) || record.url,
		});
		const meta = body.createDiv({ cls: 'lh-card-meta' });
		if (record.status === 'unread') {
			const dot = meta.createSpan({ cls: 'lh-status-dot' });
			dot.setAttribute('aria-label', 'Unread');
		}
		if (record.pinned) {
			const pin = meta.createSpan({ cls: 'lh-pin' });
			pin.setAttribute('aria-label', 'Pinned');
			setIcon(pin, 'pin');
		}
		meta.createSpan({ cls: 'lh-card-domain', text: domainFromUrl(record.url) });
		if (record.created) meta.createSpan({ cls: 'lh-card-date', text: record.created });

		if (record.tags.length > 0) {
			const tags = body.createDiv({ cls: 'lh-card-tags' });
			for (const tag of record.tags.slice(0, 4)) {
				tags.createSpan({ cls: 'lh-tag-chip', text: tag });
			}
		}

		const actions = body.createDiv({ cls: 'lh-card-actions' });
		this.actionButton(actions, 'open-note', record.path, 'file-text', 'Open note');
		if (record.readable) {
			this.actionButton(actions, 'open-readable', record.path, 'book-open', 'Open readable copy');
		}
		this.actionButton(
			actions,
			'toggle-read',
			record.path,
			record.status === 'read' ? 'mail' : 'check',
			record.status === 'read' ? 'Mark as unread' : 'Mark as read'
		);
		this.actionButton(
			actions,
			'toggle-pin',
			record.path,
			record.pinned ? 'pin-off' : 'pin',
			record.pinned ? 'Unpin' : 'Pin'
		);
		this.actionButton(actions, 'edit-tags', record.path, 'tags', 'Edit tags');
		this.actionButton(actions, 'move', record.path, 'folder-input', 'Move to collection');
		this.actionButton(actions, 'trash', record.path, 'trash-2', 'Move to trash');
		return card;
	}

	private actionButton(
		parent: HTMLElement,
		action: string,
		path: string,
		icon: string,
		label: string
	): void {
		const btn = iconButton(parent, icon, label);
		btn.dataset['lhAction'] = action;
		btn.dataset['path'] = path;
	}

	private async onCardsClick(e: MouseEvent): Promise<void> {
		// A long-press just opened the card menu; swallow the synthetic click.
		if (this.cardMenu?.swallowClick(e)) return;
		const target = e.target as HTMLElement;
		const actionEl = target.closest<HTMLElement>('[data-lh-action]');
		if (actionEl) {
			e.preventDefault();
			e.stopPropagation();
			await this.handleAction(actionEl.dataset['lhAction'] ?? '', actionEl.dataset['path'] ?? '');
			return;
		}
		const card = target.closest<HTMLElement>('.lh-card');
		const path = card?.dataset['path'];
		if (!path) return;
		const record = this.plugin.store.all().find((r) => r.path === path);
		if (record) window.open(record.url, '_external');
	}

	/**
	 * Card context menu (right-click / long-press). Every item delegates to the
	 * same handlers as the card's action buttons — no duplicated logic.
	 */
	private showCardMenu(card: HTMLElement, anchor: MenuAnchor): void {
		const path = card.dataset['path'] ?? '';
		if (!path) return;
		const record = this.plugin.store.all().find((r) => r.path === path);
		if (!record) return;
		const menu = new Menu();
		menu.addItem((item) =>
			item
				.setTitle('Open link')
				.setIcon('external-link')
				.onClick(() => window.open(record.url, '_external'))
		);
		menu.addItem((item) =>
			item
				.setTitle('Open note')
				.setIcon('file-text')
				.onClick(() => void this.handleAction('open-note', path))
		);
		if (record.readable) {
			menu.addItem((item) =>
				item
					.setTitle('Open readable copy')
					.setIcon('book-open')
					.onClick(() => void this.handleAction('open-readable', path))
			);
		}
		menu.addSeparator();
		menu.addItem((item) =>
			item
				.setTitle(record.status === 'read' ? 'Mark as unread' : 'Mark as read')
				.setIcon(record.status === 'read' ? 'circle' : 'check')
				.onClick(() => void this.handleAction('toggle-read', path))
		);
		menu.addItem((item) =>
			item
				.setTitle(record.pinned ? 'Unpin' : 'Pin')
				.setIcon('pin')
				.onClick(() => void this.handleAction('toggle-pin', path))
		);
		menu.addItem((item) =>
			item
				.setTitle('Edit tags…')
				.setIcon('tags')
				.onClick(() => void this.handleAction('edit-tags', path))
		);
		menu.addItem((item) =>
			item
				.setTitle('Move to collection…')
				.setIcon('folder-input')
				.onClick(() => void this.handleAction('move', path))
		);
		menu.addSeparator();
		// Routes through the same ConfirmModal + cascade delete as the trash button.
		menu.addItem((item) =>
			item
				.setTitle('Delete bookmark')
				.setIcon('trash')
				.onClick(() => void this.handleAction('trash', path))
		);
		if (anchor instanceof MouseEvent) {
			menu.showAtMouseEvent(anchor);
		} else {
			menu.showAtPosition(anchor);
		}
	}

	private async handleAction(action: string, path: string): Promise<void> {
		const file = this.app.vault.getFileByPath(path);
		if (!file) return;
		switch (action) {
			case 'open-note':
				await this.app.workspace.getLeaf('tab').openFile(file);
				break;
			case 'open-readable': {
				const record = this.plugin.store.all().find((r) => r.path === path);
				const readableFile = record?.readable ? this.app.vault.getFileByPath(record.readable) : null;
				if (readableFile) await this.app.workspace.getLeaf('tab').openFile(readableFile);
				break;
			}
			case 'toggle-read':
				await this.app.fileManager.processFrontMatter(file, (m: Record<string, unknown>) => {
					m['status'] = m['status'] === 'read' ? 'unread' : 'read';
				});
				break;
			case 'toggle-pin':
				await this.app.fileManager.processFrontMatter(file, (m: Record<string, unknown>) => {
					m['pinned'] = m['pinned'] !== true;
				});
				break;
			case 'edit-tags': {
				const record = this.plugin.store.all().find((r) => r.path === path);
				new EditTagsModal(this.app, this.plugin.store, file, record?.tags ?? []).open();
				break;
			}
			case 'move':
				new MoveToModal(this.app, this.plugin, file).open();
				break;
			case 'trash': {
				const record = this.plugin.store.all().find((r) => r.path === path);
				// Name only the artifacts that actually exist in the vault.
				const artifacts: string[] = [];
				if (record?.cover && this.app.vault.getFileByPath(record.cover))
					artifacts.push('cover');
				// A favicon shared with other bookmarks (per-domain cache) is
				// kept, so it is not listed among the removed artifacts.
				if (
					record?.favicon &&
					this.app.vault.getFileByPath(record.favicon) &&
					!this.plugin.store.all().some((r) => r.path !== path && r.favicon === record.favicon)
				)
					artifacts.push('favicon');
				if (record?.readable && this.app.vault.getFileByPath(record.readable))
					artifacts.push('archive copy');
				let message = 'Delete this bookmark?';
				if (artifacts.length > 0) {
					const last = artifacts[artifacts.length - 1] ?? '';
					const list =
						artifacts.length === 1
							? last
							: artifacts.length === 2
								? `${artifacts[0] ?? ''} and ${last}`
								: `${artifacts.slice(0, -1).join(', ')}, and ${last}`;
					message = `Delete this bookmark? Its ${list} will also be removed.`;
				}
				new ConfirmModal(
					this.app,
					message,
					() => {
						void deleteBookmarkCascade(this.app, this.plugin.settings, file, this.plugin.store);
					},
					{ destructive: true }
				).open();
				break;
			}
		}
	}
}
