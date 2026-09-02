// Dev harness: extract the readable copy of a live URL using src/readable.ts.
// Usage: node scripts/test-readable.mjs <url>
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import process from 'node:process';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = process.argv[2];
if (!target) {
	console.error('Usage: node scripts/test-readable.mjs <url>');
	process.exit(1);
}

// Bundle the pure module on the fly so the test exercises the shipped code.
const outDir = path.join(root, '.test-build');
await mkdir(outDir, { recursive: true });
const outfile = path.join(outDir, 'readable.cjs');
await build({
	entryPoints: [path.join(root, 'src/readable.ts')],
	bundle: true,
	format: 'cjs',
	platform: 'node',
	target: 'es2021',
	logLevel: 'warning',
	outfile,
});
const mod = await import(pathToFileURL(outfile).href);
const extractReadableMarkdown = mod.extractReadableMarkdown ?? mod.default?.extractReadableMarkdown;
if (typeof extractReadableMarkdown !== 'function') {
	console.error('Could not load extractReadableMarkdown from the bundle');
	process.exit(1);
}

const res = await fetch(target, {
	headers: {
		'user-agent':
			'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
		accept: 'text/html,application/xhtml+xml',
	},
});
if (!res.ok) {
	console.error(`HTTP ${res.status} for ${target}`);
	process.exit(1);
}
const html = await res.text();
const dom = new JSDOM(html, { url: target });
const result = extractReadableMarkdown(dom.window.document, target);
if (!result) {
	console.error('extractReadableMarkdown returned null');
	process.exit(1);
}
console.log(`textLength: ${result.textLength}`);
console.log(`markdown length: ${result.markdown.length}`);
console.log('--- first 400 chars ---');
console.log(result.markdown.slice(0, 400));
