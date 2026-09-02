import { App, Notice, TFile, normalizePath, requestUrl } from 'obsidian';
import { pathInsideFolder, trashManagedFile } from './ops';
import { ReadableResult, extractReadableMarkdown } from './readable';
import type { LinkhavenSettings } from './settings';
import type { BookmarkStore } from './store';
import type { NewBookmarkInput } from './types';
import {
	canonicalizeUrl,
	domainFromUrl,
	ensureFolder,
	sanitizeFileName,
	sleep,
	todayString,
	uniquePathForAsset,
	uniquePathForNote,
} from './utils';

const REQUEST_GAP_MS = 250;
const CONCURRENCY = 2;

function yamlScalar(value: string): string {
	// JSON string syntax is a valid YAML double-quoted scalar.
	return JSON.stringify(value);
}

function buildNoteContent(input: NewBookmarkInput): string {
	const lines: string[] = ['---'];
	lines.push(`url: ${yamlScalar(input.url)}`);
	if (input.title && input.title.trim()) lines.push(`title: ${yamlScalar(input.title.trim())}`);
	if (input.collection && input.collection.trim())
		lines.push(`collection: ${yamlScalar(input.collection.trim())}`);
	const tags = (input.tags ?? []).map((t) => t.trim()).filter((t) => t.length > 0);
	if (tags.length > 0) {
		lines.push('tags:');
		for (const tag of tags) lines.push(`  - ${yamlScalar(tag)}`);
	}
	lines.push('status: unread');
	lines.push(`pinned: ${input.pinned === true ? 'true' : 'false'}`);
	lines.push(`created: ${yamlScalar(input.created ?? todayString())}`);
	if (input.description && input.description.trim())
		lines.push(`description: ${yamlScalar(input.description.trim())}`);
	lines.push('---', '');
	if (input.description && input.description.trim()) {
		lines.push(`> ${input.description.trim()}`, '');
	}
	lines.push('## Notes', '');
	return lines.join('\n');
}

/** Cache-lag fallback for store.byUrl; compares canonical URLs. */
function findExistingByUrl(app: App, folder: string, canonical: string): TFile | null {
	const dir = normalizePath(folder);
	for (const file of app.vault.getMarkdownFiles()) {
		if (dir && !(file.path === dir || file.path.startsWith(`${dir}/`))) continue;
		const fm = app.metadataCache.getFileCache(file)?.frontmatter;
		if (fm && typeof fm['url'] === 'string' && canonicalizeUrl(fm['url']) === canonical) return file;
	}
	return null;
}

/**
 * Create a one-note-per-bookmark Markdown file. Dedupes on the canonical URL
 * via store.byUrl (with a canonicalized vault scan as a cache-lag fallback);
 * `created` is false when an existing note was returned instead of writing a
 * new one.
 */
export async function createBookmarkNote(
	app: App,
	s: LinkhavenSettings,
	store: BookmarkStore,
	input: NewBookmarkInput
): Promise<{ file: TFile; created: boolean }> {
	const folder = normalizePath(s.bookmarksFolder);
	await ensureFolder(app, folder);
	const existing = store.byUrl(input.url);
	const existingFile = existing ? app.vault.getFileByPath(existing.path) : null;
	if (existingFile) {
		// Silent: interactive callers surface DuplicateModal, the importer
		// silently counts the skip.
		return { file: existingFile, created: false };
	}
	// The store can lag behind the metadata cache (e.g. during an import);
	// fall back to a direct canonicalized scan before writing a duplicate.
	const fallback = findExistingByUrl(app, folder, canonicalizeUrl(input.url));
	if (fallback) return { file: fallback, created: false };
	const title = input.title?.trim() ?? '';
	const base = title || domainFromUrl(input.url) || 'Bookmark';
	const path = await uniquePathForNote(app, folder, base);
	return { file: await app.vault.create(path, buildNoteContent(input)), created: true };
}

interface PageMeta {
	title: string;
	description: string;
	image: string;
	icon: string;
}

function resolveUrl(href: string, base: string): string {
	try {
		return new URL(href, base).href;
	} catch {
		return href;
	}
}

function extractMeta(doc: Document, pageUrl: string): PageMeta {
	const pick = (selector: string): string =>
		doc.querySelector(selector)?.getAttribute('content')?.trim() ?? '';
	const title =
		pick('meta[property="og:title"]') ||
		doc.querySelector('title')?.textContent?.trim() ||
		'';
	const description = pick('meta[property="og:description"]') || pick('meta[name="description"]');
	let image = pick('meta[property="og:image"]');
	if (image) image = resolveUrl(image, pageUrl);
	let icon = doc.querySelector('link[rel~="icon"]')?.getAttribute('href')?.trim() ?? '';
	if (icon) {
		icon = resolveUrl(icon, pageUrl);
	} else {
		try {
			icon = new URL('/favicon.ico', pageUrl).href;
		} catch {
			icon = '';
		}
	}
	return { title, description, image, icon };
}

function extFromResponse(url: string, contentType: string, fallback: string): string {
	const type = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
	const byType: Record<string, string> = {
		'image/png': 'png',
		'image/jpeg': 'jpg',
		'image/gif': 'gif',
		'image/webp': 'webp',
		'image/svg+xml': 'svg',
		'image/x-icon': 'ico',
		'image/vnd.microsoft.icon': 'ico',
	};
	if (byType[type]) return byType[type];
	try {
		const tail = new URL(url).pathname.split('.').pop() ?? '';
		if (/^[a-zA-Z0-9]{2,5}$/.test(tail)) return tail.toLowerCase();
	} catch {
		// fall through
	}
	return fallback;
}

/**
 * Serial-ish enrichment queue: concurrency 2 with a global 250 ms gap between
 * consecutive network requests. Never throws out; failures are tracked
 * in-memory for retry.
 */
export class EnrichQueue {
	private app: App;
	private getSettings: () => LinkhavenSettings;
	private store: BookmarkStore;
	private queue: TFile[] = [];
	private queued = new Set<string>();
	private failed = new Set<string>();
	private active = 0;
	private lastRequestAt = 0;

	constructor(app: App, s: () => LinkhavenSettings, store: BookmarkStore) {
		this.app = app;
		this.getSettings = s;
		this.store = store;
	}

	enqueue(file: TFile): void {
		if (this.queued.has(file.path)) return;
		this.queued.add(file.path);
		this.queue.push(file);
		this.pump();
	}

	/**
	 * Re-enqueue every note whose last enrichment failed. Returns the number
	 * re-queued (surfaced by the "Retry failed enrichments" command).
	 */
	retryFailed(): number {
		let count = 0;
		for (const path of Array.from(this.failed)) {
			const file = this.app.vault.getFileByPath(path);
			if (file) {
				this.enqueue(file);
				count++;
			}
		}
		return count;
	}

	isFailed(path: string): boolean {
		return this.failed.has(path);
	}

	private pump(): void {
		while (this.active < CONCURRENCY && this.queue.length > 0) {
			const file = this.queue.shift();
			if (!file) break;
			this.active++;
			void this.run(file)
				.catch((e: unknown) => {
					console.warn('Linkhaven: enrichment failed', e);
					this.failed.add(file.path);
				})
				.finally(() => {
					this.active--;
					// Processing settled (success or failure): allow re-enqueue.
					this.queued.delete(file.path);
					this.pump();
				});
		}
	}

	private async run(file: TFile): Promise<void> {
		await this.throttle();
		await this.enrichOne(file);
		this.failed.delete(file.path);
	}

	/**
	 * Reserve the next request slot so consecutive network requests are ≥250 ms
	 * apart globally (shared across workers, not per-worker).
	 */
	private async throttle(): Promise<void> {
		const now = Date.now();
		const slot = Math.max(now, this.lastRequestAt + REQUEST_GAP_MS);
		this.lastRequestAt = slot;
		const wait = slot - now;
		if (wait > 0) await sleep(wait);
	}

	private async downloadAsset(url: string, folder: string, baseName: string): Promise<string | undefined> {
		try {
			await this.throttle();
			const res = await requestUrl({ url, throw: false });
			if (res.status >= 400) return undefined;
			const contentType = res.headers['content-type'] ?? '';
			if (contentType && !contentType.toLowerCase().startsWith('image/')) return undefined;
			const ext = extFromResponse(url, contentType, 'png');
			const path = await uniquePathForAsset(this.app, folder, baseName, ext);
			await this.app.vault.createBinary(path, res.arrayBuffer);
			return path;
		} catch (e) {
			console.warn('Linkhaven: asset download failed', e);
			return undefined;
		}
	}

	/** Folder that holds the favicons shared across all bookmarks of a domain. */
	private faviconFolder(s: LinkhavenSettings): string {
		return normalizePath(`${s.coversFolder}/favicons`);
	}

	/** Existing shared favicon for a domain, when one is already cached. */
	private findDomainFavicon(folder: string, domain: string): string | undefined {
		const dir = this.app.vault.getFolderByPath(folder);
		if (!dir) return undefined;
		for (const child of dir.children) {
			if (child instanceof TFile && child.basename === domain) return child.path;
		}
		return undefined;
	}

	/**
	 * Favicons are shared per domain: reuse
	 * `coversFolder/favicons/{domain}.{ext}` when it already exists (skips the
	 * download entirely — no throttle slot consumed); otherwise download once
	 * and cache it there for every bookmark of the domain.
	 */
	private async ensureDomainFavicon(
		iconUrl: string,
		pageUrl: string,
		s: LinkhavenSettings
	): Promise<string | undefined> {
		const domain = sanitizeFileName(domainFromUrl(pageUrl));
		if (!domain) return undefined;
		const folder = this.faviconFolder(s);
		const cached = this.findDomainFavicon(folder, domain);
		if (cached) return cached;
		try {
			await this.throttle();
			const res = await requestUrl({ url: iconUrl, throw: false });
			if (res.status >= 400) return undefined;
			const contentType = res.headers['content-type'] ?? '';
			if (contentType && !contentType.toLowerCase().startsWith('image/')) return undefined;
			const ext = extFromResponse(iconUrl, contentType, 'png');
			await ensureFolder(this.app, folder);
			const path = normalizePath(`${folder}/${domain}.${ext}`);
			// Another enrichment may have stored it while the request was in flight.
			if (this.app.vault.getFileByPath(path)) return path;
			await this.app.vault.createBinary(path, res.arrayBuffer);
			return path;
		} catch (e) {
			console.warn('Linkhaven: favicon download failed', e);
			return undefined;
		}
	}

	/** True when another bookmark record still references this favicon path. */
	private faviconInUseElsewhere(path: string, exceptNotePath: string): boolean {
		for (const record of this.store.all()) {
			if (record.path !== exceptNotePath && record.favicon === path) return true;
		}
		return false;
	}

	/**
	 * Rename a domain-named note to the fetched page title and keep its
	 * per-bookmark assets in name-correspondence (no orphans): cover/favicon
	 * files named `${oldBasename}-cover`/`-favicon` and a readable archive note
	 * named exactly `${oldBasename}` follow the new basename. Shared per-domain
	 * favicons (`favicons/{domain}.{ext}`) never match those prefixes and stay
	 * put. Each asset rename is isolated: on failure the old path is kept, so
	 * the frontmatter link is never lost.
	 */
	private async renameNoteToTitle(
		file: TFile,
		title: string,
		s: LinkhavenSettings,
		assets: { cover?: string; favicon?: string; readable?: string }
	): Promise<{ cover?: string; favicon?: string; readable?: string }> {
		const out = { ...assets };
		const oldBasename = file.basename;
		const newName = sanitizeFileName(title);
		if (newName === oldBasename) return out;
		try {
			const target = await uniquePathForNote(this.app, s.bookmarksFolder, newName);
			await this.app.fileManager.renameFile(file, target);
		} catch (e) {
			console.warn('Linkhaven: rename to page title failed', e);
			return out;
		}
		// renameFile fired a vault rename event — the store already re-keyed the
		// record and this same TFile now carries the new path, so the frontmatter
		// batch in enrichOne lands on the renamed note (no stale path).
		const newBase = file.basename;
		const renameAsset = async (
			path: string | undefined,
			kind: 'cover' | 'favicon' | 'readable'
		): Promise<string | undefined> => {
			if (!path) return undefined;
			const asset = this.app.vault.getFileByPath(normalizePath(path));
			if (!asset) return path;
			const folder = kind === 'readable' ? s.archiveFolder : s.coversFolder;
			if (!pathInsideFolder(path, folder)) return path;
			const matchesNote =
				kind === 'readable'
					? asset.basename === oldBasename
					: asset.basename.startsWith(`${oldBasename}-${kind}`);
			if (!matchesNote) return path;
			try {
				const next =
					kind === 'readable'
						? await uniquePathForNote(this.app, folder, newBase)
						: await uniquePathForAsset(this.app, folder, `${newBase}-${kind}`, asset.extension);
				await this.app.fileManager.renameFile(asset, next);
				return next;
			} catch (e) {
				console.warn('Linkhaven: asset rename failed', e);
				return path;
			}
		};
		out.cover = await renameAsset(out.cover, 'cover');
		out.favicon = await renameAsset(out.favicon, 'favicon');
		out.readable = await renameAsset(out.readable, 'readable');
		return out;
	}

	private async enrichOne(file: TFile): Promise<void> {
		const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
		const url = typeof fm?.['url'] === 'string' ? fm['url'] : '';
		if (!url) return;
		const s = this.getSettings();
		const hasCover = typeof fm?.['cover'] === 'string' && fm['cover'];
		const hasFavicon = typeof fm?.['favicon'] === 'string' && fm['favicon'];
		const currentTitle = typeof fm?.['title'] === 'string' ? fm['title'].trim() : '';
		const titleIsAuto =
			currentTitle.length === 0 || currentTitle === url || currentTitle === domainFromUrl(url);
		const wantReadable = s.captureReadable && !fm?.['readable'];
		if (hasCover && hasFavicon && !titleIsAuto && !wantReadable) return;

		const res = await requestUrl({ url, throw: false });
		if (res.status >= 400) throw new Error(`HTTP ${res.status} for ${url}`);
		const doc = new DOMParser().parseFromString(res.text, 'text/html');
		const meta = extractMeta(doc, url);

		const oldCover = typeof fm?.['cover'] === 'string' ? fm['cover'] : '';
		const oldFavicon = typeof fm?.['favicon'] === 'string' ? fm['favicon'] : '';
		const oldReadable = typeof fm?.['readable'] === 'string' ? fm['readable'] : '';

		let coverPath: string | undefined;
		if (meta.image && !hasCover) {
			coverPath = await this.downloadAsset(meta.image, s.coversFolder, `${file.basename}-cover`);
		}
		let faviconPath: string | undefined;
		if (meta.icon && !hasFavicon) {
			faviconPath = await this.ensureDomainFavicon(meta.icon, url, s);
		}

		let nextCover = coverPath ?? (oldCover || undefined);
		let nextFavicon = faviconPath ?? (oldFavicon || undefined);
		let nextReadable = oldReadable || undefined;

		// Rename notes that still carry an auto-derived domain file name
		// (`domain` or `domain-N`) to the fetched page title. Web Clipper notes
		// have real titles, so titleIsAuto is false and they stay untouched.
		const domain = domainFromUrl(url);
		const basenameIsAuto =
			domain.length > 0 &&
			(file.basename === domain ||
				(file.basename.startsWith(`${domain}-`) &&
					/^\d+$/.test(file.basename.slice(domain.length + 1))));
		if (s.renameNotesToTitle && titleIsAuto && basenameIsAuto && meta.title.trim().length > 0) {
			const renamed = await this.renameNoteToTitle(file, meta.title, s, {
				cover: nextCover,
				favicon: nextFavicon,
				readable: nextReadable,
			});
			nextCover = renamed.cover;
			nextFavicon = renamed.favicon;
			nextReadable = renamed.readable;
		}

		await this.app.fileManager.processFrontMatter(file, (m: Record<string, unknown>) => {
			if (meta.title && titleIsAuto) m['title'] = meta.title;
			if (meta.description && !m['description']) m['description'] = meta.description;
			if (nextCover && nextCover !== oldCover) m['cover'] = nextCover;
			if (nextFavicon && nextFavicon !== oldFavicon) m['favicon'] = nextFavicon;
			if (nextReadable && nextReadable !== oldReadable) m['readable'] = nextReadable;
		});

		if (wantReadable) {
			await this.captureReadable(file, res.text, url, s);
		}
	}

	/**
	 * Manual, user-visible full re-enrichment (duplicate-add "Refetch page"):
	 * re-fetches the page, overwrites title/description, re-downloads cover and
	 * favicon — trashing each replaced asset only after its replacement is
	 * stored (folder-safety rule applies) — and re-captures the readable copy
	 * when captureReadable is enabled. Returns true on success; a Notice is
	 * shown either way.
	 */
	async refetch(file: TFile): Promise<boolean> {
		const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
		const url = typeof fm?.['url'] === 'string' ? fm['url'] : '';
		const oldTitle = typeof fm?.['title'] === 'string' ? fm['title'] : '';
		if (!url) {
			new Notice('Refetch failed');
			return false;
		}
		try {
			await this.throttle();
			const res = await requestUrl({ url, throw: false });
			if (res.status >= 400) throw new Error(`HTTP ${res.status} for ${url}`);
			const doc = new DOMParser().parseFromString(res.text, 'text/html');
			const meta = extractMeta(doc, url);
			const s = this.getSettings();

			const oldCover = typeof fm?.['cover'] === 'string' ? fm['cover'] : '';
			const oldFavicon = typeof fm?.['favicon'] === 'string' ? fm['favicon'] : '';
			let coverPath: string | undefined;
			if (meta.image) {
				coverPath = await this.downloadAsset(meta.image, s.coversFolder, `${file.basename}-cover`);
			}
			let faviconPath: string | undefined;
			if (meta.icon) {
				faviconPath = await this.ensureDomainFavicon(meta.icon, url, s);
			}

			// Trash replaced assets only after their replacements downloaded.
			if (coverPath && oldCover && oldCover !== coverPath) {
				await trashManagedFile(this.app, oldCover, s.coversFolder);
			}
			// Favicons are shared per domain: never trash one another bookmark
			// still references.
			if (
				faviconPath &&
				oldFavicon &&
				oldFavicon !== faviconPath &&
				!this.faviconInUseElsewhere(oldFavicon, file.path)
			) {
				await trashManagedFile(this.app, oldFavicon, s.coversFolder);
			}

			await this.app.fileManager.processFrontMatter(file, (m: Record<string, unknown>) => {
				if (meta.title) m['title'] = meta.title;
				if (meta.description) m['description'] = meta.description;
				if (coverPath) m['cover'] = coverPath;
				if (faviconPath) m['favicon'] = faviconPath;
			});

			if (s.captureReadable) {
				await this.refreshReadable(file, res.text, url, s);
			}

			this.failed.delete(file.path);
			new Notice(`Refreshed ${meta.title || oldTitle || file.basename}`);
			return true;
		} catch (e) {
			console.warn('Linkhaven: refetch failed', e);
			new Notice('Refetch failed');
			return false;
		}
	}

	/**
	 * Manual capture path for the "capture-readable" command. Returns true on
	 * success; never throws so the caller can surface a Notice instead.
	 */
	async captureReadableNow(file: TFile): Promise<boolean> {
		const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
		const url = typeof fm?.['url'] === 'string' ? fm['url'] : '';
		if (!url) return false;
		try {
			await this.throttle();
			const res = await requestUrl({ url, throw: false });
			if (res.status >= 400) throw new Error(`HTTP ${res.status} for ${url}`);
			await this.captureReadable(file, res.text, url, this.getSettings());
			this.failed.delete(file.path);
			return true;
		} catch {
			return false;
		}
	}

	/** Render page HTML to a readable Markdown result. THROWS on failure. */
	private renderReadable(html: string, pageUrl: string): ReadableResult {
		// Fresh document: meta extraction happened on a separate parse.
		const doc = new DOMParser().parseFromString(html, 'text/html');
		let result: ReadableResult | null;
		try {
			result = extractReadableMarkdown(doc, pageUrl);
		} catch (e) {
			console.warn('Linkhaven: readable capture failed for', pageUrl, e);
			throw e instanceof Error ? e : new Error(String(e));
		}
		if (!result) {
			console.warn('Linkhaven: readable capture found no content for', pageUrl);
			throw new Error(`No readable content for ${pageUrl}`);
		}
		return result;
	}

	/**
	 * Save a readable Markdown copy of the page into the archive folder and
	 * link it via fm.readable. THROWS on failure so the queue records the file
	 * in its failed set and retryFailed() picks it up on next load.
	 */
	private async captureReadable(
		file: TFile,
		html: string,
		pageUrl: string,
		s: LinkhavenSettings
	): Promise<void> {
		const result = this.renderReadable(html, pageUrl);
		await ensureFolder(this.app, s.archiveFolder);
		const path = await uniquePathForNote(this.app, s.archiveFolder, file.basename);
		await this.app.vault.create(path, result.markdown);
		await this.app.fileManager.processFrontMatter(file, (m: Record<string, unknown>) => {
			m['readable'] = path;
		});
	}

	/**
	 * Re-capture the readable copy during refetch: overwrite the existing
	 * archive note in place via vault.process when it lives in the archive
	 * folder; otherwise (missing file, failed earlier capture, or a path
	 * outside the plugin's folder) create a fresh archive note. THROWS on
	 * failure so refetch reports "Refetch failed".
	 */
	private async refreshReadable(
		file: TFile,
		html: string,
		pageUrl: string,
		s: LinkhavenSettings
	): Promise<void> {
		const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
		const existing = typeof fm?.['readable'] === 'string' ? fm['readable'] : '';
		if (existing && pathInsideFolder(existing, s.archiveFolder)) {
			const target = this.app.vault.getFileByPath(normalizePath(existing));
			if (target) {
				const result = this.renderReadable(html, pageUrl);
				await this.app.vault.process(target, () => result.markdown);
				return;
			}
		}
		await this.captureReadable(file, html, pageUrl, s);
	}
}
