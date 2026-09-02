import { App, Notice, normalizePath } from 'obsidian';
import { createBookmarkNote } from './enrich';
import type { LinkhavenSettings } from './settings';
import type { BookmarkStore } from './store';
import { canonicalizeUrl, sanitizeCollectionPart } from './utils';

interface LwTag {
	name?: string;
}

interface LwLink {
	name?: string;
	url?: string;
	description?: string;
	tags?: LwTag[];
	createdAt?: string;
}

interface LwCollection {
	id?: string | number;
	name?: string;
	parentId?: string | number | null;
	color?: string;
	links?: LwLink[];
}

interface LwExport {
	collections?: LwCollection[];
	pinnedLinks?: { url?: string }[];
}

function toCreatedDate(createdAt: string | undefined): string | undefined {
	if (!createdAt) return undefined;
	const d = new Date(createdAt);
	if (isNaN(d.getTime())) return undefined;
	const mm = String(d.getMonth() + 1).padStart(2, '0');
	const dd = String(d.getDate()).padStart(2, '0');
	return `${d.getFullYear()}-${mm}-${dd}`;
}

/**
 * Build "Parent/Child" collection paths. Linkwarden's exportData resolves the
 * parent by object identity; array order is NOT guaranteed to match id order,
 * so parents are resolved by id (falling back to array index when ids are
 * absent) with a cycle guard.
 */
function buildCollectionPaths(collections: LwCollection[]): Map<LwCollection, string> {
	const byId = new Map<string | number, LwCollection>();
	collections.forEach((c, i) => {
		// Prefix index fallbacks so they cannot collide with a numeric id from
		// a mixed export (some collections with ids, some without).
		byId.set(c.id ?? `__idx_${i}`, c);
	});
	const paths = new Map<LwCollection, string>();
	const build = (c: LwCollection, seen: Set<LwCollection>): string => {
		const cached = paths.get(c);
		if (cached !== undefined) return cached;
		const name = sanitizeCollectionPart(String(c.name ?? 'Imported'));
		if (seen.has(c)) {
			paths.set(c, name);
			return name;
		}
		seen.add(c);
		let parentPath = '';
		if (c.parentId !== null && c.parentId !== undefined) {
			const parent = byId.get(c.parentId);
			if (parent && parent !== c) parentPath = build(parent, seen);
		}
		const full = parentPath ? `${parentPath}/${name}` : name;
		paths.set(c, full);
		return full;
	};
	for (const c of collections) build(c, new Set<LwCollection>());
	return paths;
}

export async function importLinkwarden(
	app: App,
	s: LinkhavenSettings,
	store: BookmarkStore,
	jsonPath: string
): Promise<{ created: number; skipped: number }> {
	const file = app.vault.getFileByPath(normalizePath(jsonPath));
	if (!file) {
		new Notice('Export file not found');
		return { created: 0, skipped: 0 };
	}
	let data: LwExport;
	try {
		data = JSON.parse(await app.vault.read(file)) as LwExport;
	} catch {
		new Notice('Could not parse the export file');
		return { created: 0, skipped: 0 };
	}
	const collections = Array.isArray(data.collections) ? data.collections : [];
	const paths = buildCollectionPaths(collections);
	const pinnedUrls = new Set<string>(
		(Array.isArray(data.pinnedLinks) ? data.pinnedLinks : [])
			.map((l) => l?.url)
			.filter((u): u is string => typeof u === 'string' && u.length > 0)
	);

	let created = 0;
	let skipped = 0;
	const seenUrls = new Set<string>();
	for (const collection of collections) {
		const collectionPath = paths.get(collection) ?? '';
		const links = Array.isArray(collection.links) ? collection.links : [];
		for (const link of links) {
			const url = link.url?.trim();
			// Canonicalize: http/https, www and trailing-slash variants of a URL
			// (inside the export or already saved) all count as the same link.
			const canonical = url ? canonicalizeUrl(url) : '';
			if (!url || seenUrls.has(canonical) || store.byUrl(url)) {
				skipped++;
				continue;
			}
			seenUrls.add(canonical);
			const tags = (Array.isArray(link.tags) ? link.tags : [])
				.map((t) => t?.name?.trim() ?? '')
				.filter((t) => t.length > 0);
			// created is false on dedupe (e.g. store.byUrl missed an existing
			// note because the metadata cache lagged behind this session).
			const { created: didCreate } = await createBookmarkNote(app, s, store, {
				url,
				title: link.name,
				description: link.description,
				tags,
				collection: collectionPath,
				created: toCreatedDate(link.createdAt),
				pinned: pinnedUrls.has(url),
			});
			if (didCreate) created++;
			else skipped++;
		}
	}
	return { created, skipped };
}
