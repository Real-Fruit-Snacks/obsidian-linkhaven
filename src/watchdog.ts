import { App, Notice, requestUrl } from 'obsidian';
import type { LinkhavenSettings } from './settings';
import type { BookmarkStore } from './store';
import { canonicalizeUrl, sleep } from './utils';

/** Outcome of a single link check; status 0 means the request never completed. */
export interface LinkCheckResult {
	alive: boolean;
	status: number;
}

/** Polite gap between sequential dead-link checks. */
export const CHECK_GAP_MS = 500;

/**
 * One probe attempt. Returns the HTTP status, or 0 when the request itself
 * failed (DNS, TLS, offline, CORS-blocked). Never throws.
 */
async function attempt(url: string, method: 'HEAD' | 'GET'): Promise<number> {
	try {
		const res = await requestUrl({ url, method, throw: false });
		return res.status;
	} catch {
		return 0;
	}
}

/**
 * Check whether a bookmark URL is alive. HEAD first; on 405/501 (method not
 * supported) or a failed request, retry once with GET. Dead means the final
 * status is >= 400. A status of 0 means the request never completed (offline,
 * DNS, TLS) — the outcome is inconclusive, not dead. Never throws.
 */
export async function checkLink(url: string): Promise<LinkCheckResult> {
	let status = await attempt(url, 'HEAD');
	if (status === 0 || status === 405 || status === 501) {
		status = await attempt(url, 'GET');
	}
	return { alive: status > 0 && status < 400, status };
}

/**
 * Record the outcome of one check in settings.deadLinks: dead links gain an
 * entry keyed by canonical URL; alive links lose any stale entry. Inconclusive
 * results (status 0 — the request never completed) are never recorded: offline
 * is not dead, and any existing entry is left untouched.
 */
export function recordLinkCheck(settings: LinkhavenSettings, url: string, result: LinkCheckResult): void {
	if (result.status === 0) return;
	const canonical = canonicalizeUrl(url);
	if (result.alive) {
		delete settings.deadLinks[canonical];
	} else {
		settings.deadLinks[canonical] = { status: result.status, checkedAt: new Date().toISOString() };
	}
}

/**
 * Sequential dead-link check over the target records (opts.paths, or every
 * bookmark). Per-item try/catch: one bad URL never aborts the run. Settings
 * are saved once at the end; the summary Notice only appears for manual runs.
 * Never throws.
 *
 * Offline safety: inconclusive results (status 0) are skipped, never recorded
 * as dead. If the first 3 consecutive checks all fail at the network level,
 * the run is almost certainly offline, so it aborts early (manual runs get a
 * "No network connection — check skipped" Notice). Stale deadLinks entries
 * whose bookmark no longer exists are pruned at the end of every run.
 */
export async function runDeadLinkCheck(
	app: App,
	store: BookmarkStore,
	settings: LinkhavenSettings,
	saveSettings: () => Promise<void>,
	opts?: { paths?: string[]; manual?: boolean }
): Promise<{ checked: number; dead: number }> {
	const targets = opts?.paths
		? store.all().filter((r) => opts.paths?.includes(r.path))
		: store.all();
	let checked = 0;
	let dead = 0;
	let consecutiveNetworkFails = 0;
	for (const record of targets) {
		if (checked > 0) await sleep(CHECK_GAP_MS);
		try {
			const result = await checkLink(record.url);
			if (result.status === 0) {
				// Inconclusive (offline/DNS/TLS): never recorded as dead.
				consecutiveNetworkFails++;
				// Only when the first 3 checks all failed at the network
				// level: the device is almost certainly offline — stop
				// instead of burning through every bookmark. (Mid-run
				// clusters of unreachable hosts do not abort the run.)
				if (consecutiveNetworkFails >= 3 && consecutiveNetworkFails === checked + 1) {
					checked++;
					if (opts?.manual) {
						new Notice('No network connection — check skipped');
					}
					return { checked, dead };
				}
			} else {
				consecutiveNetworkFails = 0;
				recordLinkCheck(settings, record.url, result);
				if (!result.alive) dead++;
			}
		} catch (e) {
			console.error(`Linkhaven: dead-link check failed for ${record.url}`, e);
		}
		checked++;
	}
	// Prune deadLinks entries whose bookmark was deleted since the check.
	const liveUrls = new Set(store.all().map((r) => canonicalizeUrl(r.url)));
	for (const canonical of Object.keys(settings.deadLinks)) {
		if (!liveUrls.has(canonical)) delete settings.deadLinks[canonical];
	}
	await saveSettings();
	if (opts?.manual) {
		new Notice(`Checked ${checked} links · ${dead} dead`);
	}
	return { checked, dead };
}
