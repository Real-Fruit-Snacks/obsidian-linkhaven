import { Editor, Notice, Plugin, TFile, normalizePath, requireApiVersion } from 'obsidian';
import { EnrichQueue, createBookmarkNote } from './enrich';
import { AddBookmarkModal, DuplicateModal, ImportModal } from './modals';
import { setStatusForPath } from './ops';
import { LinkhavenSettings, LinkhavenSettingTab, DEFAULT_SETTINGS } from './settings';
import { BookmarkLauncher } from './launcher';
import { BookmarkStore } from './store';
import { BookmarkRecord, Filter, VIEW_TYPE_GRID, VIEW_TYPE_TREE } from './types';
import { sanitizeCollectionPart } from './utils';
import { runDeadLinkCheck } from './watchdog';
import { BookmarkGridView } from './views/gridView';
import { CollectionTreeView } from './views/treeView';

export default class LinkhavenPlugin extends Plugin {
	settings: LinkhavenSettings = Object.assign({}, DEFAULT_SETTINGS);
	store!: BookmarkStore;
	enrichQueue!: EnrichQueue;
	filter: Filter = { kind: 'all' };
	private knownPaths = new Set<string>();
	private protocolInFlight = new Set<string>();
	private unsubscribeStore: (() => void) | null = null;

	async onload(): Promise<void> {
		await this.loadSettings();
		this.filter = this.settings.lastFilter ?? { kind: 'all' };

		this.store = new BookmarkStore(
			this.app,
			() => this.settings.bookmarksFolder,
			() => this.settings.knownCollections,
			() => this.settings.deadLinks
		);
		this.addChild(this.store);
		// Wire listeners eagerly so no vault event is missed, but defer the
		// first scan until layout/vault load: on a cold start the metadata
		// cache has not indexed the vault yet during onload, so an immediate
		// scan would see no frontmatter. The store's 'resolved' listener
		// rescans once initial indexing completes.
		this.store.registerEvents();
		this.app.workspace.onLayoutReady(() => {
			void this.store.scan();
			for (const record of this.store.all()) this.knownPaths.add(record.path);
			// Startup dead-link check: one-shot per session, 30 s after layout so
			// it never competes with vault indexing. registerInterval on the
			// timeout id keeps it cleanup-safe (cleared on unload if pending).
			if (this.settings.deadLinkCheck) {
				this.registerInterval(
					window.setTimeout(() => {
						void this.checkDeadLinks().then(() => this.notifyViews());
					}, 30_000)
				);
			}
		});

		this.enrichQueue = new EnrichQueue(this.app, () => this.settings, this.store);
		this.enrichQueue.retryFailed();

		// Web Clipper / URI / manual drops: any new bookmark note in the folder
		// is enriched automatically (zero-prompt save flow).
		this.unsubscribeStore = this.store.subscribe(() => {
			for (const record of this.store.all()) {
				if (this.knownPaths.has(record.path)) continue;
				this.knownPaths.add(record.path);
				const file = this.app.vault.getFileByPath(record.path);
				if (file) this.enrichQueue.enqueue(file);
			}
		});

		this.registerView(VIEW_TYPE_TREE, (leaf) => new CollectionTreeView(leaf, this));
		this.registerView(VIEW_TYPE_GRID, (leaf) => new BookmarkGridView(leaf, this));

		this.addRibbonIcon('bookmark', 'Open bookmark grid', () => {
			void this.openGrid();
		});

		this.addCommand({
			id: 'open-grid',
			name: 'Open bookmark grid',
			callback: () => void this.openGrid(),
		});
		this.addCommand({
			id: 'open-tree',
			name: 'Open collection tree',
			callback: () => void this.openTree(),
		});
		this.addCommand({
			id: 'open-launcher',
			name: 'Open bookmark launcher',
			callback: () => new BookmarkLauncher(this.app, this).open(),
		});
		this.addCommand({
			id: 'add-bookmark',
			name: 'Add bookmark from URL',
			callback: () => new AddBookmarkModal(this.app, this).open(),
		});
		this.addCommand({
			id: 'capture-readable',
			name: 'Capture readable copy for active bookmark',
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!file || !this.bookmarkUrlFor(file)) return false;
				if (checking) return true;
				void this.captureReadableCommand(file);
				return true;
			},
		});
		this.addCommand({
			id: 'open-random-unread',
			name: 'Open a random unread bookmark',
			callback: () => {
				const unread = this.store.filter({ kind: 'smart', id: 'unread' });
				const pick = unread[Math.floor(Math.random() * unread.length)];
				if (!pick) {
					new Notice('No unread bookmarks');
					return;
				}
				this.openBookmarkLink(pick);
			},
		});
		this.addCommand({
			id: 'import-linkwarden',
			name: 'Import bookmarks from Linkwarden export',
			callback: () => new ImportModal(this.app, this).open(),
		});
		this.addCommand({
			id: 'check-dead-links',
			name: 'Check for dead links',
			callback: () => {
				void this.checkDeadLinks({ manual: true }).then(() => this.notifyViews());
			},
		});
		this.addCommand({
			id: 'retry-failed',
			name: 'Retry failed enrichments',
			callback: () => {
				const count = this.enrichQueue.retryFailed();
				new Notice(
					count > 0 ? `Retrying ${count} failed enrichments` : 'No failed enrichments to retry'
				);
			},
		});

		this.registerObsidianProtocolHandler('bookmark-add', (params) => {
			void this.handleProtocolAdd(params);
		});

		// Editor context menu: offer to save the URL under the cursor or in
		// the selection. No URL on the line/selection -> no menu item.
		this.registerEvent(
			this.app.workspace.on('editor-menu', (menu, editor) => {
				const url = this.urlAtCursor(editor);
				if (!url) return;
				menu.addItem((item) =>
					item
						.setTitle('Save to Linkhaven')
						.setIcon('bookmark')
						.onClick(() => void this.saveBookmarkFromUrl(url))
				);
			})
		);

		this.addSettingTab(new LinkhavenSettingTab(this.app, this));
	}

	onunload(): void {
		this.unsubscribeStore?.();
		this.unsubscribeStore = null;
		// Views and store are unloaded automatically; no leaf detachment here.
	}

	/** URL frontmatter when `file` is a bookmark note inside the bookmarks folder. */
	private bookmarkUrlFor(file: TFile): string {
		const folder = normalizePath(this.settings.bookmarksFolder);
		if (folder && !(file.path === folder || file.path.startsWith(`${folder}/`))) return '';
		const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
		return typeof fm?.['url'] === 'string' ? fm['url'] : '';
	}

	/** Run the dead-link watchdog over all bookmarks (or opts.paths). */
	private checkDeadLinks(opts?: { paths?: string[]; manual?: boolean }): Promise<{ checked: number; dead: number }> {
		return runDeadLinkCheck(
			this.app,
			this.store,
			this.settings,
			() => this.saveSettings(),
			opts
		);
	}

	private async captureReadableCommand(file: TFile): Promise<void> {
		const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
		const existing = typeof fm?.['readable'] === 'string' ? fm['readable'] : '';
		if (existing && this.app.vault.getFileByPath(existing)) {
			new Notice('Already captured');
			return;
		}
		const ok = await this.enrichQueue.captureReadableNow(file);
		if (ok) {
			new Notice('Readable copy captured');
		} else {
			new Notice('Readable capture failed for this page');
		}
	}

	private async handleProtocolAdd(params: Record<string, string>): Promise<void> {
		const url = params['url']?.trim() ?? '';
		if (!/^https?:\/\//.test(url)) {
			new Notice('No valid URL provided');
			return;
		}
		if (this.protocolInFlight.has(url)) return; // double-submit guard
		this.protocolInFlight.add(url);
		try {
			const tags = params['tags']
				?.split(',')
				.map((t) => t.trim())
				.filter((t) => t.length > 0)
				.map((t) => sanitizeCollectionPart(t));
			// Same per-segment sanitization as the modals.
			const collection = (params['collection'] ?? '')
				.split('/')
				.map((part) => part.trim())
				.filter((part) => part.length > 0)
				.map((part) => sanitizeCollectionPart(part))
				.join('/');
			const { file, created } = await createBookmarkNote(this.app, this.settings, this.store, {
				url,
				collection: collection || undefined,
				tags: tags && tags.length > 0 ? tags : undefined,
			});
			if (created) {
				this.enrichQueue.enqueue(file);
				new Notice(collection ? `Saved to ${collection}` : 'Saved to Inbox');
			} else {
				// Interactive duplicate: offer refetch / open instead of a bare notice.
				new DuplicateModal(this.app, this, file).open();
			}
		} finally {
			this.protocolInFlight.delete(url);
		}
	}

	/**
	 * First http(s) URL in the editor selection, else on the cursor's line.
	 * Trailing sentence punctuation and unbalanced closing parens are trimmed
	 * so prose like "(see https://example.com/a)." saves the bare URL.
	 */
	private urlAtCursor(editor: Editor): string {
		const text = editor.getSelection() || editor.getLine(editor.getCursor().line);
		const match = /https?:\/\/[^\s)\]<>"']+/.exec(text);
		let url = match?.[0] ?? '';
		if (!url) return '';
		url = url.replace(/[.,;:!?]+$/, '');
		// Defensive: the match regex already stops at ')', but keep the trim
		// symmetric with the punctuation pass for any future widening.
		const opens = url.split('(').length - 1;
		let closes = url.split(')').length - 1;
		while (url.endsWith(')') && closes > opens) {
			url = url.slice(0, -1);
			closes--;
		}
		return url;
	}

	/**
	 * Interactive save shared by the editor context menu and the grid's
	 * drop-to-save: enqueue enrichment on create, offer the duplicate modal
	 * (refetch / open) when the URL is already saved.
	 */
	async saveBookmarkFromUrl(url: string): Promise<void> {
		const { file, created } = await createBookmarkNote(this.app, this.settings, this.store, {
			url,
		});
		if (created) {
			this.enrichQueue.enqueue(file);
			new Notice('Saved to Inbox');
		} else {
			new DuplicateModal(this.app, this, file).open();
		}
	}

	/**
	 * The single open path for bookmark links: Obsidian's web viewer when the
	 * setting is on and the app supports it (1.9.10+), else the system
	 * browser. markReadOnOpen applies here and never to Open note.
	 */
	openBookmarkLink(record: BookmarkRecord): void {
		if (this.settings.openInWebViewer && requireApiVersion('1.9.10')) {
			window.open(record.url);
		} else {
			window.open(record.url, '_external');
		}
		void this.markReadOnOpen(record);
	}

	/**
	 * markReadOnOpen setting: opening the link (or its readable/archived copy)
	 * silently sets status='read' when the bookmark is currently unread.
	 * No Notice. The single implementation — gridView and the launcher call
	 * this rather than duplicating the gate.
	 */
	async markReadOnOpen(record: BookmarkRecord): Promise<void> {
		if (!this.settings.markReadOnOpen) return;
		if (record.status !== 'unread') return;
		try {
			await setStatusForPath(this.app, record.path, 'read');
		} catch {
			// Silent by design: a failed status write must not interrupt opening.
		}
	}

	async loadSettings(): Promise<void> {
		const data = (await this.loadData()) as Partial<LinkhavenSettings> | null;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
		// Object.assign shallow-merges: on a fresh install the record fields
		// would alias the DEFAULT_SETTINGS objects, so mutating settings would
		// corrupt the defaults. Deep-merge these two records instead.
		this.settings.deadLinks = { ...DEFAULT_SETTINGS.deadLinks, ...(data?.deadLinks ?? {}) };
		this.settings.cardButtons = { ...DEFAULT_SETTINGS.cardButtons, ...(data?.cardButtons ?? {}) };
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	setFilter(f: Filter): void {
		this.filter = f;
		this.settings.lastFilter = f;
		void this.saveSettings();
		this.notifyViews();
	}

	setGridQuery(query: string): void {
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_GRID)) {
			if (leaf.view instanceof BookmarkGridView) leaf.view.setExternalQuery(query);
		}
	}

	notifyViews(): void {
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_TREE)) {
			if (leaf.view instanceof CollectionTreeView) leaf.view.refresh();
		}
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_GRID)) {
			if (leaf.view instanceof BookmarkGridView) leaf.view.refresh();
		}
	}

	async openGrid(): Promise<void> {
		const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_GRID)[0];
		if (existing) {
			await this.app.workspace.revealLeaf(existing);
			return;
		}
		const leaf = this.app.workspace.getLeaf('tab');
		await leaf.setViewState({ type: VIEW_TYPE_GRID, active: true });
		await this.app.workspace.revealLeaf(leaf);
	}

	async openTree(): Promise<void> {
		const leaf = await this.app.workspace.ensureSideLeaf(VIEW_TYPE_TREE, 'left', {
			active: true,
			reveal: true,
		});
		await this.app.workspace.revealLeaf(leaf);
	}
}
