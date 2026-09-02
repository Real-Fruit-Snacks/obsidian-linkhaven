import { App, Notice, TFile, normalizePath } from 'obsidian';
import type { LinkhavenSettings } from './settings';
import type { BookmarkStore } from './store';
import { sanitizeCollectionPart } from './utils';

/** Number of notes updated vs. failed during a bulk frontmatter operation. */
export interface OpResult {
	updated: number;
	failed: number;
}

function summaryNotice(prefix: string, result: OpResult, suffix: string): void {
	let message = `${prefix} · ${result.updated} ${suffix}`;
	if (result.failed > 0) message += `, ${result.failed} failed`;
	new Notice(message);
}

/** True when `path` (normalized) lives strictly inside `folder` (normalized). */
export function pathInsideFolder(path: string, folder: string): boolean {
	const dir = normalizePath(folder);
	if (!dir) return false;
	return normalizePath(path).startsWith(`${dir}/`);
}

/**
 * Trash `path` only when it lives inside the plugin-managed `folder`.
 * Missing files and out-of-folder paths are skipped silently — the plugin
 * never touches anything outside its own covers/archive folders.
 */
export async function trashManagedFile(app: App, path: string, folder: string): Promise<void> {
	if (!path || !pathInsideFolder(path, folder)) return;
	const target = app.vault.getFileByPath(normalizePath(path));
	if (!target) return;
	await app.fileManager.trashFile(target);
}

/**
 * Delete a bookmark note together with the artifacts the plugin created for
 * it: cached cover and favicon (coversFolder) and the readable archive copy
 * (archiveFolder). Referenced files outside those folders are never touched,
 * and a favicon shared with other bookmarks (same path, per-domain cache) is
 * kept. Uses app.fileManager.trashFile throughout, so the user's
 * system-/plugin-trash preference is respected.
 */
export async function deleteBookmarkCascade(
	app: App,
	s: LinkhavenSettings,
	file: TFile,
	store?: BookmarkStore
): Promise<void> {
	const fm = app.metadataCache.getFileCache(file)?.frontmatter;
	const cover = typeof fm?.['cover'] === 'string' ? fm['cover'] : '';
	const favicon = typeof fm?.['favicon'] === 'string' ? fm['favicon'] : '';
	const readable = typeof fm?.['readable'] === 'string' ? fm['readable'] : '';
	if (cover) await trashManagedFile(app, cover, s.coversFolder);
	// Favicons are shared per domain: keep the file while any other bookmark
	// still references the same path. Covers/readable copies are per-bookmark
	// and are always trashed.
	const faviconShared =
		favicon.length > 0 &&
		store !== undefined &&
		store.all().some((r) => r.path !== file.path && r.favicon === favicon);
	if (favicon && !faviconShared) await trashManagedFile(app, favicon, s.coversFolder);
	if (readable) await trashManagedFile(app, readable, s.archiveFolder);
	await app.fileManager.trashFile(file);
}

/**
 * Rename a collection: every note whose collection === from OR startsWith
 * (from + '/') gets the 'to' prefix. Sequential, per-note try/catch. Also
 * rewrites knownCollections (path and descendants' prefixes).
 */
export async function renameCollection(
	app: App,
	store: BookmarkStore,
	s: LinkhavenSettings,
	from: string,
	to: string
): Promise<{ updated: number; failed: number }> {
	const result: OpResult = { updated: 0, failed: 0 };
	for (const record of store.all()) {
		if (record.collection !== from && !record.collection.startsWith(`${from}/`)) continue;
		const file = app.vault.getFileByPath(record.path);
		if (!file) {
			result.failed++;
			continue;
		}
		const next = to + record.collection.slice(from.length);
		try {
			await app.fileManager.processFrontMatter(file, (m: Record<string, unknown>) => {
				m['collection'] = next;
			});
			result.updated++;
		} catch {
			result.failed++;
		}
	}
	s.knownCollections = s.knownCollections
		.map((c) => (c === from || c.startsWith(`${from}/`) ? to + c.slice(from.length) : c))
		.filter((c, i, all) => all.indexOf(c) === i)
		.sort((a, b) => a.localeCompare(b));
	summaryNotice('Renamed collection', result, 'bookmarks updated');
	return result;
}

/**
 * Delete a collection: clears collection to '' (Inbox) for the collection AND
 * its descendants. Never deletes notes. Removes the path (+ descendants) from
 * knownCollections.
 */
export async function deleteCollection(
	app: App,
	store: BookmarkStore,
	s: LinkhavenSettings,
	path: string
): Promise<{ updated: number; failed: number }> {
	const result: OpResult = { updated: 0, failed: 0 };
	for (const record of store.all()) {
		if (record.collection !== path && !record.collection.startsWith(`${path}/`)) continue;
		const file = app.vault.getFileByPath(record.path);
		if (!file) {
			result.failed++;
			continue;
		}
		try {
			await app.fileManager.processFrontMatter(file, (m: Record<string, unknown>) => {
				delete m['collection'];
			});
			result.updated++;
		} catch {
			result.failed++;
		}
	}
	s.knownCollections = s.knownCollections.filter(
		(c) => c !== path && !c.startsWith(`${path}/`)
	);
	summaryNotice('Deleted collection', result, 'bookmarks moved to Inbox');
	return result;
}

/**
 * Register a new (possibly empty) collection in knownCollections. Parent
 * segments are auto-added; existing entries are deduped. The caller persists
 * via saveSettings.
 */
export async function addCollection(s: LinkhavenSettings, path: string): Promise<void> {
	const parts = path
		.split('/')
		.map((part) => sanitizeCollectionPart(part))
		.filter((part) => part.length > 0);
	if (parts.length === 0) {
		new Notice('Enter a collection name');
		return;
	}
	const known = new Set(s.knownCollections);
	let current = '';
	for (const part of parts) {
		current = current ? `${current}/${part}` : part;
		known.add(current);
	}
	s.knownCollections = Array.from(known).sort((a, b) => a.localeCompare(b));
}

/** Read a frontmatter list-of-strings key (a single string counts as one item). */
function fmStringList(value: unknown): string[] {
	if (Array.isArray(value)) {
		return value
			.map((v) => (typeof v === 'string' ? v.trim() : ''))
			.filter((v) => v.length > 0);
	}
	return typeof value === 'string' && value.trim().length > 0 ? [value.trim()] : [];
}

/**
 * Append a tag to one bookmark note (drag-a-card-onto-a-tag flow). The tag is
 * stored with the canonical casing of the established store tag when it
 * matches case-insensitively; duplicates (case-insensitive) are not added.
 */
export async function addTagToBookmark(
	app: App,
	store: BookmarkStore,
	file: TFile,
	tag: string
): Promise<void> {
	const canonical = store.tags().find((t) => t.toLowerCase() === tag.toLowerCase()) ?? tag;
	const record = store.all().find((r) => r.path === file.path);
	if (record?.tags.some((t) => t.toLowerCase() === canonical.toLowerCase())) {
		new Notice(`Already tagged #${canonical}`);
		return;
	}
	await app.fileManager.processFrontMatter(file, (m: Record<string, unknown>) => {
		const current = fmStringList(m['tags']);
		if (current.some((t) => t.toLowerCase() === canonical.toLowerCase())) return;
		m['tags'] = [...current, canonical];
	});
	new Notice(`Tagged #${canonical}`);
}

/** Rename a tag across all bookmark notes (exact, case-sensitive match). */
export async function renameTag(
	app: App,
	store: BookmarkStore,
	from: string,
	to: string
): Promise<{ updated: number; failed: number }> {
	const result: OpResult = { updated: 0, failed: 0 };
	for (const record of store.all()) {
		if (!record.tags.includes(from)) continue;
		const file = app.vault.getFileByPath(record.path);
		if (!file) {
			result.failed++;
			continue;
		}
		const next: string[] = [];
		for (const tag of record.tags) {
			const value = tag === from ? to : tag;
			if (!next.includes(value)) next.push(value);
		}
		try {
			await app.fileManager.processFrontMatter(file, (m: Record<string, unknown>) => {
				m['tags'] = next;
			});
			result.updated++;
		} catch {
			result.failed++;
		}
	}
	summaryNotice('Renamed tag', result, 'bookmarks updated');
	return result;
}

/** Remove a tag from tags[] across all bookmark notes. */
export async function removeTag(
	app: App,
	store: BookmarkStore,
	tag: string
): Promise<{ updated: number; failed: number }> {
	const result: OpResult = { updated: 0, failed: 0 };
	for (const record of store.all()) {
		if (!record.tags.includes(tag)) continue;
		const file = app.vault.getFileByPath(record.path);
		if (!file) {
			result.failed++;
			continue;
		}
		const next = record.tags.filter((t) => t !== tag);
		try {
			await app.fileManager.processFrontMatter(file, (m: Record<string, unknown>) => {
				if (next.length > 0) {
					m['tags'] = next;
				} else {
					delete m['tags'];
				}
			});
			result.updated++;
		} catch {
			result.failed++;
		}
	}
	summaryNotice('Removed tag', result, 'bookmarks updated');
	return result;
}
