import { App, TFolder, normalizePath } from 'obsidian';
import type { BookmarkRecord, GridSort } from './types';

/** Strip characters that are invalid in Obsidian file names. No lookbehind (iOS safe). */
export function sanitizeFileName(name: string): string {
	const cleaned = name
		.replace(/[\\/:*?"<>|#[\]^]/g, ' ')
		.split('')
		.map((c) => (c.charCodeAt(0) < 0x20 ? ' ' : c))
		.join('')
		.replace(/\s+/g, ' ')
		.trim();
	const out = cleaned.length > 0 ? cleaned : 'Untitled';
	return out.slice(0, 100);
}

/** Sanitize a single collection path segment (same rules as file names). */
export function sanitizeCollectionPart(part: string): string {
	return sanitizeFileName(part).replace(/\//g, ' ').trim();
}

/**
 * Canonical form of a bookmark URL, used as the dedupe key everywhere
 * (store.byUrl and every caller that goes through it): trim, default to
 * https://, lowercase protocol and host, strip a leading "www.", drop the
 * fragment, and drop a single trailing slash from the path (bare "/" stays).
 * The query string is kept. Unparseable input is returned trimmed, unchanged.
 */
export function canonicalizeUrl(raw: string): string {
	const trimmed = raw.trim();
	if (!trimmed) return trimmed;
	const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed) ? trimmed : `https://${trimmed}`;
	try {
		const parsed = new URL(withScheme);
		const protocol = parsed.protocol.toLowerCase();
		let host = parsed.hostname.toLowerCase();
		if (host.startsWith('www.')) host = host.slice(4);
		const port = parsed.port ? `:${parsed.port}` : '';
		let path = parsed.pathname;
		if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
		return `${protocol}//${host}${port}${path}${parsed.search}`;
	} catch {
		return trimmed;
	}
}

export function domainFromUrl(url: string): string {
	try {
		const host = new URL(url).hostname;
		return host.replace(/^www\./, '');
	} catch {
		return '';
	}
}

/**
 * Order grid records per the gridSort setting. Applied after filter + search,
 * uniformly for every filter (smart 'recent' stays the latest 30, then sorted).
 * Pinned records always come first, regardless of the selected sort; the chosen
 * sort applies within the pinned group and within the unpinned group alike.
 */
export function sortRecords(records: BookmarkRecord[], sort: GridSort): BookmarkRecord[] {
	const byPath = (a: BookmarkRecord, b: BookmarkRecord): number => a.path.localeCompare(b.path);
	// Case-insensitive; bookmarks without a title always sink to the end.
	const byTitle = (a: BookmarkRecord, b: BookmarkRecord): number => {
		const ta = a.title.toLowerCase();
		const tb = b.title.toLowerCase();
		if (!ta && !tb) return 0;
		if (!ta) return 1;
		if (!tb) return -1;
		return ta.localeCompare(tb);
	};
	let bySort: (a: BookmarkRecord, b: BookmarkRecord) => number;
	switch (sort) {
		case 'newest':
			bySort = (a, b) => b.created.localeCompare(a.created) || byPath(a, b);
			break;
		case 'oldest':
			bySort = (a, b) => a.created.localeCompare(b.created) || byPath(a, b);
			break;
		case 'title':
			bySort = (a, b) => byTitle(a, b) || byPath(a, b);
			break;
		case 'domain':
			bySort = (a, b) =>
				domainFromUrl(a.url).localeCompare(domainFromUrl(b.url)) || byTitle(a, b) || byPath(a, b);
			break;
	}
	const out = [...records];
	out.sort((a, b) => Number(b.pinned) - Number(a.pinned) || bySort(a, b));
	return out;
}

/** Create folder (and parents) if missing. No-op when it already exists. */
export async function ensureFolder(app: App, folder: string): Promise<void> {
	const path = normalizePath(folder);
	if (!path) return;
	const parts = path.split('/');
	let current = '';
	for (const part of parts) {
		current = current ? `${current}/${part}` : part;
		const existing = app.vault.getAbstractFileByPath(current);
		if (existing instanceof TFolder) continue;
		if (existing) return; // a file blocks this path; cannot create folder
		try {
			await app.vault.createFolder(current);
		} catch {
			// created concurrently; ignore
		}
	}
}

function isTaken(app: App, path: string): boolean {
	return app.vault.getAbstractFileByPath(path) !== null;
}

/** Unique path for a new note: folder/base.md, folder/base-2.md, ... */
export async function uniquePathForNote(app: App, folder: string, baseName: string): Promise<string> {
	const dir = normalizePath(folder);
	await ensureFolder(app, dir);
	const base = sanitizeFileName(baseName);
	let candidate = normalizePath(dir ? `${dir}/${base}.md` : `${base}.md`);
	let n = 2;
	while (isTaken(app, candidate)) {
		candidate = normalizePath(dir ? `${dir}/${base}-${n}.md` : `${base}-${n}.md`);
		n++;
	}
	return candidate;
}

/** Unique path for a binary asset: folder/base.ext, folder/base-2.ext, ... */
export async function uniquePathForAsset(
	app: App,
	folder: string,
	baseName: string,
	ext: string
): Promise<string> {
	const dir = normalizePath(folder);
	await ensureFolder(app, dir);
	const base = sanitizeFileName(baseName);
	const safeExt = ext.replace(/[^a-zA-Z0-9]/g, '').toLowerCase() || 'bin';
	let candidate = normalizePath(`${dir}/${base}.${safeExt}`);
	let n = 2;
	while (isTaken(app, candidate)) {
		candidate = normalizePath(`${dir}/${base}-${n}.${safeExt}`);
		n++;
	}
	return candidate;
}

export function todayString(): string {
	const d = new Date();
	const mm = String(d.getMonth() + 1).padStart(2, '0');
	const dd = String(d.getDate()).padStart(2, '0');
	return `${d.getFullYear()}-${mm}-${dd}`;
}

export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => window.setTimeout(resolve, ms));
}

/**
 * Parse the custom bulk drag-and-drop payload (a JSON array of bookmark note
 * paths). Returns [] on any malformed input — never throws.
 */
export function parseBulkDragPayload(raw: string): string[] {
	if (!raw) return [];
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		return parsed.filter((p): p is string => typeof p === 'string' && p.length > 0);
	} catch {
		return [];
	}
}
