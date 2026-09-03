import {
	Debouncer,
	DropdownComponent,
	ItemView,
	Menu,
	Notice,
	Platform,
	WorkspaceLeaf,
	debounce,
	setIcon,
} from 'obsidian';
import type LinkhavenPlugin from '../main';
import { LongPressMenu, MenuAnchor } from '../longPressMenu';
import { BookmarkRecord, GridSort, LH_BULK_MIME, VIEW_TYPE_GRID } from '../types';
import {
	AddBookmarkModal,
	ConfirmModal,
	EditTagsModal,
	MoveToModal,
	TextInputModal,
	iconButton,
} from '../modals';
import {
	bulkAddTag,
	bulkDeleteCascade,
	bulkSetStatus,
	deleteBookmarkCascade,
	setStatusForPath,
} from '../ops';
import { domainFromUrl, sortRecords } from '../utils';
import { isIgnoredDomain, waybackLookupUrl } from '../wayback';

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
	private selectToggleEl: HTMLElement | null = null;
	private bulkBarEl: HTMLElement | null = null;
	private query = '';
	private viewMode: 'grid' | 'list' = 'grid';
	private cardMenu: LongPressMenu | null = null;
	private shownCap = INITIAL_CAP;
	private renderToken = 0;
	private renderDebounced: Debouncer<[], void>;
	/** View-local selection (note paths); never persisted, survives re-renders. */
	private selection = new Set<string>();
	/** Shift-click range anchor: the last plain-clicked/toggled card. */
	private selectionAnchor: string | null = null;
	/** Toolbar-toggled selection mode (tap-to-toggle, menus suspended). */
	private selectionMode = false;
	private bulkRefetching = false;
	private bulkWaybacking = false;

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
		// Sort dropdown before the search input: persists the setting and
		// re-renders; ordering is applied after filter + search in the pipeline.
		const sortDropdown = new DropdownComponent(toolbar)
			.addOptions({
				newest: 'Newest first',
				oldest: 'Oldest first',
				title: 'Title',
				domain: 'Domain',
			})
			.setValue(this.plugin.settings.gridSort)
			.onChange(async (value) => {
				this.plugin.settings.gridSort = value as GridSort;
				await this.plugin.saveSettings();
				this.renderAll(false);
			});
		sortDropdown.selectEl.addClass('lh-toolbar-sort');
		sortDropdown.selectEl.setAttribute('aria-label', 'Sort bookmarks');
		this.searchEl = toolbar.createEl('input', {
			cls: 'lh-toolbar-search',
			attr: { type: 'text', placeholder: 'Search bookmarks' },
		});
		this.registerDomEvent(this.searchEl, 'input', () => {
			this.query = this.searchEl?.value ?? '';
			// A search change redefines the visible set: drop the selection.
			this.clearSelection(false);
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
		// Selection mode toggle (tap-to-toggle; the touch path to multi-select,
		// since Ctrl/Shift-click does not exist on mobile).
		this.selectToggleEl = toolbar.createEl('button', { cls: 'lh-icon-btn clickable-icon' });
		this.selectToggleEl.setAttribute('aria-label', 'Select bookmarks');
		setIcon(this.selectToggleEl, 'list-checks');
		this.registerDomEvent(this.selectToggleEl, 'click', () => {
			this.setSelectionMode(!this.selectionMode);
		});

		// Bulk action bar: rendered (and hidden) by renderBulkBar.
		this.bulkBarEl = contentEl.createDiv({ cls: 'lh-bulk-bar lh-hidden' });

		this.cardsEl = contentEl.createDiv({ cls: 'lh-cards' });
		// Right-click (desktop) / long-press (mobile) context menu on cards.
		// Suspended while selection mode is on: taps (and long-presses) toggle.
		this.cardMenu = new LongPressMenu(
			this,
			this.cardsEl,
			'.lh-card',
			(card, anchor) => this.showCardMenu(card, anchor),
			() => this.selectionMode
		);
		this.registerDomEvent(this.cardsEl, 'click', (e: MouseEvent) => void this.onCardsClick(e));
		if (Platform.isDesktop) {
			// Drag source: the tree's collection rows and Inbox are the targets.
			this.registerDomEvent(this.cardsEl, 'dragstart', (e: DragEvent) => {
				const card = (e.target as HTMLElement).closest<HTMLElement>('.lh-card');
				const path = card?.dataset['path'];
				if (!card || !path || !e.dataTransfer) return;
				// Dragging a card that is IN the selection drags the whole
				// selection: custom mime carries the JSON array of all selected
				// paths; text/plain keeps the dragged path for backward compat.
				if (this.selection.has(path)) {
					e.dataTransfer.setData(LH_BULK_MIME, JSON.stringify(Array.from(this.selection)));
				}
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
		// A filter change redefines the visible set: drop the selection.
		this.selection.clear();
		this.selectionAnchor = null;
		this.renderAll(true);
	}

	/** Called by the plugin when the tree forwards its filter text. */
	setExternalQuery(query: string): void {
		this.query = query;
		if (this.searchEl) this.searchEl.value = query;
		// A search change redefines the visible set: drop the selection.
		this.clearSelection(false);
		this.renderDebounced();
	}

	private currentRecords(): BookmarkRecord[] {
		const filter = this.plugin.filter;
		const records = this.plugin.store
			.filter(filter)
			.filter((r) => this.plugin.store.matches(r, filter, this.query));
		// Sort last: it governs display order for every filter incl. smart views.
		return sortRecords(records, this.plugin.settings.gridSort);
	}

	private renderAll(resetCap: boolean): void {
		if (!this.cardsEl || !this.contentEl.isConnected) return;
		if (resetCap) this.shownCap = INITIAL_CAP;
		// Re-renders preserve the selection; only paths whose notes are gone
		// (e.g. after a bulk delete) are pruned.
		const alive = new Set(this.plugin.store.all().map((r) => r.path));
		for (const path of Array.from(this.selection)) {
			if (!alive.has(path)) this.selection.delete(path);
		}
		if (this.selectionAnchor && !alive.has(this.selectionAnchor)) this.selectionAnchor = null;
		this.renderLabel();
		this.renderBulkBar();
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
		// Re-renders preserve the selection: re-apply the highlight.
		if (this.selection.has(record.path)) card.addClass('lh-selected');
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
		if (!card || !path) return;
		// Selection gestures take precedence over the plain "open link" click:
		// Ctrl/Cmd toggles, Shift range-selects from the anchor, and once the
		// selection is non-empty (or selection mode is on) every plain click
		// toggles too — selection mode is effectively on.
		if (e.shiftKey && this.selectionAnchor) {
			e.preventDefault();
			this.selectRange(path);
			return;
		}
		if (e.ctrlKey || e.metaKey || this.selectionMode || this.selection.size > 0) {
			e.preventDefault();
			this.toggleSelect(path);
			return;
		}
		// Plain click: behaves as today (open the link) and becomes the anchor.
		this.selectionAnchor = path;
		const record = this.plugin.store.all().find((r) => r.path === path);
		if (record) this.openExternalLink(record);
	}

	/** Open the external link; mark-read-on-open applies (never to Open note). */
	private openExternalLink(record: BookmarkRecord): void {
		window.open(record.url, '_external');
		void this.markReadOnOpen(record.path);
	}

	/**
	 * markReadOnOpen setting: opening the link or the readable copy silently
	 * sets status='read' when the bookmark is currently unread. No Notice.
	 */
	private async markReadOnOpen(path: string): Promise<void> {
		if (!this.plugin.settings.markReadOnOpen) return;
		const record = this.plugin.store.all().find((r) => r.path === path);
		if (!record || record.status !== 'unread') return;
		try {
			await setStatusForPath(this.app, path, 'read');
		} catch {
			// Silent by design: a failed status write must not interrupt opening.
		}
	}

	/**
	 * Manual "Save to Wayback Machine" capture via the queue path (same
	 * throttle and fm.wayback write as auto-archiving); Notices per step.
	 */
	private async saveToWayback(path: string): Promise<void> {
		const file = this.app.vault.getFileByPath(path);
		if (!file) return;
		new Notice('Archiving…');
		const result = await this.plugin.enrichQueue.archiveToWayback(file);
		if (result.archivedUrl) {
			new Notice('Archived to Wayback');
		} else {
			new Notice(`Wayback capture failed: ${result.error ?? 'unknown error'}`);
		}
	}

	private async copyLink(url: string): Promise<void> {
		try {
			await navigator.clipboard.writeText(url);
			new Notice('Link copied');
		} catch {
			new Notice('Copy failed');
		}
	}

	/** Toggle one card in/out of the selection and make it the range anchor. */
	private toggleSelect(path: string): void {
		if (this.selection.has(path)) {
			this.selection.delete(path);
		} else {
			this.selection.add(path);
		}
		this.selectionAnchor = path;
		this.applySelectionClasses();
		this.renderBulkBar();
	}

	/** Shift-click: add every card between the anchor and `path` (inclusive)
	 * to the selection, in the current record order. */
	private selectRange(path: string): void {
		const records = this.currentRecords();
		const anchorIndex = records.findIndex((r) => r.path === this.selectionAnchor);
		const targetIndex = records.findIndex((r) => r.path === path);
		if (targetIndex < 0) return;
		if (anchorIndex < 0) {
			// Anchor scrolled out of the visible set: fall back to a toggle.
			this.toggleSelect(path);
			return;
		}
		const lo = Math.min(anchorIndex, targetIndex);
		const hi = Math.max(anchorIndex, targetIndex);
		for (let i = lo; i <= hi; i++) {
			const record = records[i];
			if (record) this.selection.add(record.path);
		}
		this.applySelectionClasses();
		this.renderBulkBar();
	}

	/** Re-apply .lh-selected to the rendered cards from the selection set. */
	private applySelectionClasses(): void {
		if (!this.cardsEl) return;
		this.cardsEl.querySelectorAll<HTMLElement>('.lh-card').forEach((card) => {
			card.toggleClass('lh-selected', this.selection.has(card.dataset['path'] ?? ''));
		});
	}

	/** Clear the selection; the bulk Clear action also exits selection mode
	 * (per-tap deselection down to zero does not). */
	private clearSelection(exitMode: boolean): void {
		this.selection.clear();
		this.selectionAnchor = null;
		if (exitMode && this.selectionMode) {
			this.setSelectionMode(false);
			return; // setSelectionMode already refreshed classes and the bar
		}
		this.applySelectionClasses();
		this.renderBulkBar();
	}

	/** Toolbar-toggled selection mode (mobile tap-to-toggle). */
	private setSelectionMode(on: boolean): void {
		this.selectionMode = on;
		this.selectToggleEl?.toggleClass('is-active', on);
		if (!on) {
			this.selection.clear();
			this.selectionAnchor = null;
		}
		this.applySelectionClasses();
		this.renderBulkBar();
	}

	/* ---------- Bulk action bar ---------- */

	/** Rebuild the bulk action bar; visible only while the selection is non-empty. */
	private renderBulkBar(): void {
		const bar = this.bulkBarEl;
		if (!bar) return;
		bar.empty();
		const count = this.selection.size;
		bar.toggleClass('lh-hidden', count === 0);
		if (count === 0) return;

		bar.createSpan({ cls: 'lh-bulk-count', text: `${count} selected` });

		const selectAll = bar.createEl('button', { text: 'Select all' });
		selectAll.onclick = () => {
			for (const record of this.currentRecords()) this.selection.add(record.path);
			this.applySelectionClasses();
			this.renderBulkBar();
		};
		const clear = bar.createEl('button', { text: 'Clear' });
		clear.onclick = () => this.clearSelection(true);

		const move = bar.createEl('button', { text: 'Move to…' });
		move.onclick = () => new MoveToModal(this.app, this.plugin, Array.from(this.selection)).open();

		const tag = bar.createEl('button', { text: 'Add tag…' });
		tag.onclick = () => {
			const paths = Array.from(this.selection);
			new TextInputModal(this.app, {
				title: 'Add tag',
				placeholder: 'Tag name',
				cta: 'Add tag',
				validate: (value) => (value.trim().length > 0 ? null : 'Enter a tag name'),
				onSubmit: (value) => void this.runBulkAddTag(paths, value),
			}).open();
		};

		const refetch = bar.createEl('button', { text: 'Refetch' });
		refetch.disabled = this.bulkRefetching;
		refetch.onclick = () => void this.runBulkRefetch(refetch);

		const wayback = bar.createEl('button', { text: 'Wayback' });
		wayback.disabled = this.bulkWaybacking;
		wayback.onclick = () => void this.runBulkWayback(wayback);

		const markRead = bar.createEl('button', { text: 'Mark read' });
		markRead.onclick = () => void this.runBulkSetStatus('read');
		const markUnread = bar.createEl('button', { text: 'Mark unread' });
		markUnread.onclick = () => void this.runBulkSetStatus('unread');

		const del = bar.createEl('button', { text: 'Delete', cls: 'mod-warning' });
		del.onclick = () => this.confirmBulkDelete();
	}

	private async runBulkAddTag(paths: string[], tag: string): Promise<void> {
		const canonical =
			this.plugin.store.tags().find((t) => t.toLowerCase() === tag.toLowerCase()) ?? tag;
		const updated = await bulkAddTag(this.app, this.plugin.store, paths, canonical);
		new Notice(
			updated === paths.length
				? `Tagged ${updated} bookmarks with #${canonical}`
				: `${updated} of ${paths.length} updated`
		);
	}

	private async runBulkRefetch(button: HTMLButtonElement): Promise<void> {
		const paths = Array.from(this.selection);
		if (paths.length === 0 || this.bulkRefetching) return;
		this.bulkRefetching = true;
		button.disabled = true;
		try {
			// Sequential on purpose: each refetch awaits the queue's throttle gap,
			// so requests stay polite instead of fanning out in parallel.
			let ok = 0;
			for (const path of paths) {
				const file = this.app.vault.getFileByPath(path);
				if (!file) continue;
				if (await this.plugin.enrichQueue.refetch(file)) ok++;
			}
			new Notice(
				ok === paths.length ? `Refetched ${ok} bookmarks` : `Refetched ${ok} of ${paths.length} bookmarks`
			);
		} finally {
			this.bulkRefetching = false;
			button.disabled = false;
		}
	}

	private async runBulkWayback(button: HTMLButtonElement): Promise<void> {
		if (this.bulkWaybacking) return;
		// Skip bookmarks already captured or on an ignored domain.
		const candidates = Array.from(this.selection)
			.map((path) => this.plugin.store.all().find((r) => r.path === path))
			.filter(
				(r): r is BookmarkRecord =>
					!!r &&
					!r.wayback &&
					!isIgnoredDomain(r.url, this.plugin.settings.waybackIgnoredDomains)
			);
		if (candidates.length === 0) {
			new Notice('Nothing to archive — already captured or ignored');
			return;
		}
		this.bulkWaybacking = true;
		button.disabled = true;
		try {
			// Sequential on purpose: each capture awaits the queue's throttle gap,
			// so requests stay polite instead of fanning out in parallel.
			let ok = 0;
			for (const record of candidates) {
				const file = this.app.vault.getFileByPath(record.path);
				if (!file) continue;
				const result = await this.plugin.enrichQueue.archiveToWayback(file);
				if (result.archivedUrl) ok++;
			}
			new Notice(
				ok === candidates.length
					? `Archived ${ok} bookmarks to Wayback`
					: `Archived ${ok} of ${candidates.length} bookmarks to Wayback`
			);
		} finally {
			this.bulkWaybacking = false;
			button.disabled = false;
		}
	}

	private async runBulkSetStatus(status: 'read' | 'unread'): Promise<void> {
		const paths = Array.from(this.selection);
		if (paths.length === 0) return;
		const updated = await bulkSetStatus(this.app, this.plugin.store, paths, status);
		new Notice(
			updated === paths.length
				? `Marked ${updated} bookmarks as ${status}`
				: `${updated} of ${paths.length} updated`
		);
	}

	private confirmBulkDelete(): void {
		const paths = Array.from(this.selection);
		if (paths.length === 0) return;
		new ConfirmModal(
			this.app,
			`Delete ${paths.length} bookmarks? Their covers, favicons, and archive copies will also be removed.`,
			() => void this.runBulkDelete(paths),
			{ confirmText: 'Delete', destructive: true }
		).open();
	}

	private async runBulkDelete(paths: string[]): Promise<void> {
		const updated = await bulkDeleteCascade(
			this.app,
			this.plugin.settings,
			this.plugin.store,
			paths
		);
		// Deleted notes leave the vault: the selection no longer applies.
		this.clearSelection(true);
		new Notice(
			updated === paths.length
				? `Deleted ${updated} bookmarks and their files`
				: `${updated} of ${paths.length} updated`
		);
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
				.onClick(() => this.openExternalLink(record))
		);
		menu.addItem((item) =>
			item
				.setTitle('Open archived version')
				.setIcon('archive')
				.onClick(() => {
					window.open(record.wayback ?? waybackLookupUrl(record.url), '_external');
					void this.markReadOnOpen(path);
				})
		);
		if (!record.wayback) {
			menu.addItem((item) =>
				item
					.setTitle('Save to Wayback Machine')
					.setIcon('archive')
					.onClick(() => void this.saveToWayback(path))
			);
		}
		menu.addItem((item) =>
			item
				.setTitle('Copy link')
				.setIcon('copy')
				.onClick(() => void this.copyLink(record.url))
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
		menu.addItem((item) =>
			item
				.setTitle('Refetch page')
				.setIcon('rotate-cw')
				.onClick(() => void this.handleAction('refetch', path))
		);
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
				if (readableFile) {
					await this.app.workspace.getLeaf('tab').openFile(readableFile);
					await this.markReadOnOpen(path);
				}
				break;
			}
			case 'refetch':
				// Existing Notices ("Refreshed {title}" / "Refetch failed") cover feedback.
				await this.plugin.enrichQueue.refetch(file);
				break;
			case 'toggle-read': {
				// Same single-item write the bulk status op loops over.
				const current = this.plugin.store.all().find((r) => r.path === path)?.status;
				await setStatusForPath(this.app, path, current === 'read' ? 'unread' : 'read');
				break;
			}
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
				new MoveToModal(this.app, this.plugin, [path]).open();
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
