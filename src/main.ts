import { Notice, Plugin, TFile, normalizePath } from 'obsidian';
import { EnrichQueue, createBookmarkNote } from './enrich';
import { AddBookmarkModal, DuplicateModal, ImportModal } from './modals';
import { LinkhavenSettings, LinkhavenSettingTab, DEFAULT_SETTINGS } from './settings';
import { BookmarkStore } from './store';
import { Filter, VIEW_TYPE_GRID, VIEW_TYPE_TREE } from './types';
import { sanitizeCollectionPart } from './utils';
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
			() => this.settings.knownCollections
		);
		this.addChild(this.store);
		await this.store.init();
		for (const record of this.store.all()) this.knownPaths.add(record.path);

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
			id: 'import-linkwarden',
			name: 'Import bookmarks from Linkwarden export',
			callback: () => new ImportModal(this.app, this).open(),
		});

		this.registerObsidianProtocolHandler('bookmark-add', (params) => {
			void this.handleProtocolAdd(params);
		});

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
			const { file, created } = await createBookmarkNote(this.app, this.settings, {
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

	async loadSettings(): Promise<void> {
		const data = (await this.loadData()) as Partial<LinkhavenSettings> | null;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
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

	private notifyViews(): void {
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
