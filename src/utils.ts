import { App, TFolder, normalizePath } from 'obsidian';

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

export function domainFromUrl(url: string): string {
	try {
		const host = new URL(url).hostname;
		return host.replace(/^www\./, '');
	} catch {
		return '';
	}
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
