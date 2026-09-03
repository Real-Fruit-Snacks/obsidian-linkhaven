// Dev harness: smoke-check src/watchdog.ts checkLink against live URLs.
// The bundled module's obsidian.requestUrl is stubbed with node fetch, which
// shares requestUrl's throw:false semantics (HTTP errors resolve, network
// failures reject).
// Usage: node scripts/test-deadlink.mjs
import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import process from 'node:process';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// utils.sleep uses window.setTimeout; give the bundle a minimal window.
globalThis.window ??= { setTimeout };

const outDir = path.join(root, '.test-build');
await mkdir(outDir, { recursive: true });
const outfile = path.join(outDir, 'watchdog.cjs');
await build({
	entryPoints: [path.join(root, 'src/watchdog.ts')],
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
					contents: `
						export class App {}
						export class TFolder {}
						export const normalizePath = (p) => p;
						export class Notice {
							constructor(message) { console.log('Notice:', message); }
						}
						export const requestUrl = async ({ url, method, throw: shouldThrow }) => {
							// Test hook: simulate a full network outage (offline/DNS/TLS).
							if (globalThis.__lhNetworkDown) throw new Error('network down');
							const res = await fetch(url, { method: method ?? 'GET', redirect: 'follow' });
							if (shouldThrow !== false && !res.ok) {
								throw new Error('HTTP ' + res.status);
							}
							return { status: res.status, headers: {}, text: '', json: null, arrayBuffer: new ArrayBuffer(0) };
						};
					`,
				}));
			},
		},
	],
});
const mod = await import(pathToFileURL(outfile).href);
const checkLink = mod.checkLink ?? mod.default?.checkLink;
if (typeof checkLink !== 'function') {
	console.error('Could not load checkLink from the bundle');
	process.exit(1);
}

const expect = (label, ok, detail) => {
	if (!ok) {
		console.error(`FAIL ${label}: ${detail}`);
		process.exit(1);
	}
	console.log(`PASS ${label}: ${detail}`);
};

const alive = await checkLink('https://real-fruit-snacks.github.io/obsidian-linkhaven/');
expect('alive URL', alive.alive === true, `status ${alive.status}`);

const dead = await checkLink('https://real-fruit-snacks.github.io/definitely-not-here-404');
expect('dead URL', dead.alive === false && dead.status === 404, `status ${dead.status}`);

// Offline safety: a network-level failure (requestUrl throwing on both the
// HEAD and GET attempts) yields status 0 — inconclusive, never recorded dead.
const { recordLinkCheck, runDeadLinkCheck } = mod;
globalThis.__lhNetworkDown = true;
const offline = await checkLink('https://real-fruit-snacks.github.io/obsidian-linkhaven/');
expect('offline check inconclusive', offline.alive === false && offline.status === 0, `status ${offline.status}`);
const settings = { deadLinks: {} };
recordLinkCheck(settings, 'https://example.com/anything', offline);
expect('status-0 not recorded', Object.keys(settings.deadLinks).length === 0, 'deadLinks stays empty');
const fakeStore = {
	all: () => [1, 2, 3, 4, 5].map((i) => ({ path: `Bookmarks/${i}.md`, url: `https://example.com/${i}` })),
};
const aborted = await runDeadLinkCheck(null, fakeStore, settings, async () => {}, { manual: true });
expect(
	'offline run aborts after 3 checks',
	aborted.checked === 3 && aborted.dead === 0,
	`checked ${aborted.checked}, dead ${aborted.dead}`
);
expect('offline run records nothing', Object.keys(settings.deadLinks).length === 0, 'deadLinks stays empty');
globalThis.__lhNetworkDown = false;

console.log('checkLink smoke checks verified.');
