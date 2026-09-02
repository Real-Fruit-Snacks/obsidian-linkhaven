import { App, Notice } from 'obsidian';
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
