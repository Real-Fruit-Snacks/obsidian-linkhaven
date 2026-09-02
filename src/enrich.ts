import { App, Notice, TFile, normalizePath, requestUrl } from 'obsidian';
import { ReadableResult, extractReadableMarkdown } from './readable';
import type { LinkhavenSettings } from './settings';
import type { BookmarkStore } from './store';
import type { NewBookmarkInput } from './types';
import {
	domainFromUrl,
	ensureFolder,
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

function findExistingByUrl(app: App, folder: string, url: string): TFile | null {
	const dir = normalizePath(folder);
	for (const file of app.vault.getMarkdownFiles()) {
		if (dir && !(file.path === dir || file.path.startsWith(`${dir}/`))) continue;
		const fm = app.metadataCache.getFileCache(file)?.frontmatter;
		if (fm && fm['url'] === url) return file;
	}
	return null;
}

/**
 * Create a one-note-per-bookmark Markdown file. Dedupes on url; `created` is
 * false when an existing note was returned instead of writing a new one.
 */
export async function createBookmarkNote(
	app: App,
	s: LinkhavenSettings,
	input: NewBookmarkInput
): Promise<{ file: TFile; created: boolean }> {
	const folder = normalizePath(s.bookmarksFolder);
	await ensureFolder(app, folder);
	const existing = findExistingByUrl(app, folder, input.url);
	if (existing) {
		new Notice('Already saved');
		return { file: existing, created: false };
	}
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

	retryFailed(): void {
		for (const path of Array.from(this.failed)) {
			const file = this.app.vault.getFileByPath(path);
			if (file) this.enqueue(file);
		}
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

		let coverPath: string | undefined;
		if (meta.image && !hasCover) {
			coverPath = await this.downloadAsset(meta.image, s.coversFolder, `${file.basename}-cover`);
		}
		let faviconPath: string | undefined;
		if (meta.icon && !hasFavicon) {
			faviconPath = await this.downloadAsset(meta.icon, s.coversFolder, `${file.basename}-favicon`);
		}

		await this.app.fileManager.processFrontMatter(file, (m: Record<string, unknown>) => {
			if (meta.title && titleIsAuto) m['title'] = meta.title;
			if (meta.description && !m['description']) m['description'] = meta.description;
			if (coverPath) m['cover'] = coverPath;
			if (faviconPath) m['favicon'] = faviconPath;
		});

		if (wantReadable) {
			await this.captureReadable(file, res.text, url, s);
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
		await ensureFolder(this.app, s.archiveFolder);
		const path = await uniquePathForNote(this.app, s.archiveFolder, file.basename);
		await this.app.vault.create(path, result.markdown);
		await this.app.fileManager.processFrontMatter(file, (m: Record<string, unknown>) => {
			m['readable'] = path;
		});
	}
}
