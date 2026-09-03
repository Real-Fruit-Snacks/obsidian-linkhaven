// Dev harness: assert the four gridSort orderings of src/utils.ts sortRecords
// on fixture records (sort audit guard, SPEC v1.6.1; pinned-first rule added
// in v1.6.2 — fixtures now include pinned records and every expectation leads
// with the internally-sorted pinned group).
// Usage: node scripts/test-sort.mjs
import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import process from 'node:process';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// Bundle the shipped module on the fly so the test exercises real code.
// src/utils.ts imports obsidian (App/TFolder/normalizePath) for other helpers;
// stub that import — sortRecords itself is pure.
const outDir = path.join(root, '.test-build');
await mkdir(outDir, { recursive: true });
const outfile = path.join(outDir, 'utils.cjs');
await build({
	entryPoints: [path.join(root, 'src/utils.ts')],
	bundle: true,
	format: 'cjs',
	platform: 'node',
	target: 'es2021',
	logLevel: 'warning',
	outfile,
	plugins: [
		{
			name: 'stub-obsidian',
			setup(b) {
				b.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian', namespace: 'stub' }));
				b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
					contents:
						'export class TFolder {} export class App {} export const normalizePath = (p) => p;',
				}));
			},
		},
	],
});
const mod = await import(pathToFileURL(outfile).href);
const sortRecords = mod.sortRecords ?? mod.default?.sortRecords;
if (typeof sortRecords !== 'function') {
	console.error('Could not load sortRecords from the bundle');
	process.exit(1);
}

const rec = (p, url, title, created, pinned = false) => ({
	path: p,
	url,
	title,
	collection: '',
	tags: [],
	status: 'unread',
	pinned,
	created,
});

// Fixture covers: created ties (path fallback), case-insensitive titles, an
// empty title (sinks last), a domain tie (title fallback), and two pinned
// records that exercise the pinned-first rule (v1.6.2) with distinct created
// dates, titles, and domains so each ordering visibly sorts the pinned group.
const fixtures = [
	rec('b.md', 'https://zeta.com/x', 'bravo', '2026-01-02'),
	rec('a.md', 'https://alpha.com/y', 'Charlie', '2026-03-01'),
	rec('c.md', 'https://alpha.com/z', '', '2026-02-01'),
	rec('d.md', 'https://mid.net/a', 'alpha', '2026-01-02'),
	rec('e.md', 'https://zulu.org/p', 'echo', '2026-01-15', true),
	rec('f.md', 'https://bravo.net/q', 'Beta', '2026-04-01', true),
];

const paths = (records) => records.map((r) => r.path);
const expect = (label, actual, wanted) => {
	const ok = actual.length === wanted.length && actual.every((v, i) => v === wanted[i]);
	if (!ok) {
		console.error(`FAIL ${label}: got [${actual.join(', ')}], wanted [${wanted.join(', ')}]`);
		process.exit(1);
	}
	console.log(`PASS ${label}: [${actual.join(', ')}]`);
};

// Pinned records (e.md, f.md) always lead; each group is internally sorted.
// newest: pinned created desc, then unpinned created desc, ties by path asc
expect('newest (pinned first)', paths(sortRecords(fixtures, 'newest')), [
	'f.md',
	'e.md',
	'a.md',
	'c.md',
	'b.md',
	'd.md',
]);
// oldest: pinned created asc, then unpinned created asc, ties by path asc
expect('oldest (pinned first)', paths(sortRecords(fixtures, 'oldest')), [
	'e.md',
	'f.md',
	'b.md',
	'd.md',
	'c.md',
	'a.md',
]);
// title: pinned by title, then unpinned; localeCompare case-insensitive, empty titles last
expect('title (pinned first)', paths(sortRecords(fixtures, 'title')), [
	'f.md',
	'e.md',
	'd.md',
	'b.md',
	'a.md',
	'c.md',
]);
// domain: pinned by domain, then unpinned; domain asc, then title, then path
expect('domain (pinned first)', paths(sortRecords(fixtures, 'domain')), [
	'f.md',
	'e.md',
	'a.md',
	'c.md',
	'd.md',
	'b.md',
]);

// Pinned-first invariant: no unpinned record ever precedes a pinned one.
for (const sort of ['newest', 'oldest', 'title', 'domain']) {
	const sorted = sortRecords(fixtures, sort);
	const firstUnpinned = sorted.findIndex((r) => !r.pinned);
	const lastPinned = sorted.map((r) => r.pinned).lastIndexOf(true);
	expect(`${sort} pinned-before-unpinned`, [firstUnpinned > lastPinned], [true]);
}

// Guard: sortRecords must not mutate its input (views re-sort per render).
const before = paths(fixtures);
sortRecords(fixtures, 'oldest');
expect('input unchanged', paths(fixtures), before);

console.log('All sortRecords orderings verified.');
