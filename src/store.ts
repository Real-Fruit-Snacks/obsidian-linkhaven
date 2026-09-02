import { App, Component, TAbstractFile, TFile, debounce, normalizePath } from 'obsidian';
import type { BookmarkRecord, Filter } from './types';

const NOTIFY_DEBOUNCE_MS = 200;

function asString(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function asStringList(value: unknown): string[] {
	if (Array.isArray(value)) {
		return value
			.map((v) => (typeof v === 'string' ? v.trim() : ''))
			.filter((v) => v.length > 0);
	}
	const single = asString(value);
	return single ? [single] : [];
}

/**
 * Vault-folder-backed data store. One Markdown note per bookmark; the
 * frontmatter cache is the index. Emits one debounced change per vault burst.
 */
export class BookmarkStore extends Component {
	private app: App;
	private getFolder: () => string;
	private getKnownCollections: () => string[];
	private records = new Map<string, BookmarkRecord>();
	private listeners = new Set<() => void>();
	private recentCache: Set<string> | null = null;
	private emitDebounced: () => void;

	constructor(app: App, getFolder: () => string, getKnownCollections: () => string[] = () => []) {
		super();
		this.app = app;
		this.getFolder = getFolder;
		this.getKnownCollections = getKnownCollections;
		this.emitDebounced = debounce(() => this.emit(), NOTIFY_DEBOUNCE_MS, true);
	}

	/**
	 * Wire all vault/metadata listeners. Called eagerly on plugin load so no
	 * vault event is missed while the initial scan is deferred.
	 */
	registerEvents(): void {
		this.registerEvent(
			this.app.metadataCache.on('changed', (file) => {
				this.updateFile(file);
				this.emitDebounced();
			})
		);
		// Self-healing: 'resolved' fires when the cache finishes its initial
		// indexing pass (and after bulk vault changes). If the deferred
		// startup scan ran before indexing, this picks up every bookmark.
		this.registerEvent(
			this.app.metadataCache.on('resolved', () => {
				this.scan();
				this.emitDebounced();
			})
		);
		this.registerEvent(
			this.app.metadataCache.on('deleted', (file) => {
				this.records.delete(file.path);
				this.recentCache = null;
				this.emitDebounced();
			})
		);
		this.registerEvent(
			this.app.vault.on('create', (file) => {
				if (file instanceof TFile) {
					this.updateFile(file);
					this.emitDebounced();
				}
			})
		);
		this.registerEvent(
			this.app.vault.on('rename', (file, oldPath) => {
				this.records.delete(oldPath);
				this.recentCache = null;
				if (file instanceof TFile) this.updateFile(file);
				this.emitDebounced();
			})
		);
		this.registerEvent(
			this.app.vault.on('delete', (file: TAbstractFile) => {
				this.records.delete(file.path);
				this.recentCache = null;
				this.emitDebounced();
			})
		);
	}

	/** Combined convenience: eager event wiring + immediate scan. */
	async init(): Promise<void> {
		this.registerEvents();
		this.scan();
	}

	/** Full rescan of the vault (used when the folder setting changes). */
	async rescan(): Promise<void> {
		this.scan();
		this.emit();
	}

	private inFolder(path: string): boolean {
		const folder = normalizePath(this.getFolder());
		if (!folder) return true;
		return path === folder || path.startsWith(`${folder}/`);
	}

	/**
	 * Full scan of the bookmarks folder. Idempotent: rebuilds the record map
	 * from the metadata cache. Files not yet indexed (null cache) are skipped
	 * — the 'resolved' rescan picks them up once indexing finishes.
	 */
	scan(): void {
		this.records.clear();
		this.recentCache = null;
		for (const file of this.app.vault.getMarkdownFiles()) {
			if (!this.inFolder(file.path)) continue;
			if (!this.app.metadataCache.getFileCache(file)) continue;
			const record = this.readRecord(file);
			if (record) this.records.set(file.path, record);
		}
	}

	private updateFile(file: TFile): void {
		if (file.extension !== 'md') return;
		this.recentCache = null;
		if (!this.inFolder(file.path)) {
			this.records.delete(file.path);
			return;
		}
		// Not yet indexed (cold start / mid-reindex): skip rather than build
		// or keep a broken record; the 'resolved' rescan picks the file up.
		if (!this.app.metadataCache.getFileCache(file)) return;
		const record = this.readRecord(file);
		if (record) {
			this.records.set(file.path, record);
		} else {
			// No url in frontmatter: never keep a url-less record.
			this.records.delete(file.path);
		}
	}

	private readRecord(file: TFile): BookmarkRecord | null {
		const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
		if (!fm) return null;
		const url = asString(fm['url']);
		if (!url) return null;
		const record: BookmarkRecord = {
			path: file.path,
			url,
			title: asString(fm['title']) ?? '',
			collection: asString(fm['collection']) ?? '',
			tags: asStringList(fm['tags']),
			status: fm['status'] === 'read' ? 'read' : 'unread',
			pinned: fm['pinned'] === true,
			created: asString(fm['created']) ?? '',
		};
		const cover = asString(fm['cover']);
		if (cover) record.cover = cover;
		const favicon = asString(fm['favicon']);
		if (favicon) record.favicon = favicon;
		const readable = asString(fm['readable']);
		if (readable) record.readable = readable;
		const description = asString(fm['description']);
		if (description) record.description = description;
		return record;
	}

	all(): BookmarkRecord[] {
		return Array.from(this.records.values());
	}

	byUrl(url: string): BookmarkRecord | undefined {
		for (const record of this.records.values()) {
			if (record.url === url) return record;
		}
		return undefined;
	}

	/** Distinct sorted collection paths: notes' collections ∪ knownCollections. */
	collections(): string[] {
		const set = new Set<string>();
		for (const path of this.getKnownCollections()) {
			if (path) set.add(path);
		}
		for (const record of this.records.values()) {
			if (record.collection) set.add(record.collection);
		}
		return Array.from(set).sort((a, b) => a.localeCompare(b));
	}

	tags(): string[] {
		const set = new Set<string>();
		for (const record of this.records.values()) {
			for (const tag of record.tags) set.add(tag);
		}
		return Array.from(set).sort((a, b) => a.localeCompare(b));
	}

	filter(f: Filter): BookmarkRecord[] {
		let out = this.all().filter((r) => this.matches(r, f));
		out.sort((a, b) => {
			if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
			return b.created.localeCompare(a.created) || a.path.localeCompare(b.path);
		});
		if (f.kind === 'smart' && f.id === 'recent') out = out.slice(0, 30);
		return out;
	}

	subscribe(cb: () => void): () => void {
		this.listeners.add(cb);
		return () => {
			this.listeners.delete(cb);
		};
	}

	private emit(): void {
		for (const cb of this.listeners) {
			try {
				cb();
			} catch (e) {
				console.error('Linkhaven: subscriber failed', e);
			}
		}
	}

	matches(r: BookmarkRecord, f: Filter, query?: string): boolean {
		if (!this.matchesFilter(r, f)) return false;
		const q = query?.trim().toLowerCase();
		if (!q) return true;
		const haystack = [r.title, r.url, r.description ?? '', ...r.tags].join('\n').toLowerCase();
		return q
			.split(/\s+/)
			.filter((word) => word.length > 0)
			.every((word) => haystack.includes(word));
	}

	private matchesFilter(r: BookmarkRecord, f: Filter): boolean {
		switch (f.kind) {
			case 'all':
				return true;
			case 'collection':
				return r.collection === f.path || r.collection.startsWith(`${f.path}/`);
			case 'tag':
				return r.tags.includes(f.tag);
			case 'smart':
				switch (f.id) {
					case 'inbox':
						return r.collection === '';
					case 'pinned':
						return r.pinned;
					case 'unread':
						return r.status === 'unread';
					case 'recent':
						return this.recentPaths().has(r.path);
				}
		}
	}

	private recentPaths(): Set<string> {
		// Computed once per mutation burst (cache invalidated on any record
		// change), so smart 'recent' filtering is not O(n² log n).
		if (this.recentCache) return this.recentCache;
		const sorted = this.all().sort(
			(a, b) => b.created.localeCompare(a.created) || a.path.localeCompare(b.path)
		);
		this.recentCache = new Set(sorted.slice(0, 30).map((r) => r.path));
		return this.recentCache;
	}
}
