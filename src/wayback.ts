import { requestUrl } from 'obsidian';
import { sleep } from './utils';

/** Outcome of a Wayback capture attempt: a snapshot URL or a clear error. */
export interface WaybackResult {
	archivedUrl?: string;
	error?: string;
}

const SAVE_ENDPOINT = 'https://web.archive.org/save';
const STATUS_ENDPOINT = 'https://web.archive.org/save/status/';
const AVAILABILITY_ENDPOINT = 'https://archive.org/wayback/available';
const CDX_ENDPOINT = 'https://web.archive.org/cdx';
/** Job status is polled every 3 seconds (wayback-linker cadence). */
const POLL_INTERVAL_MS = 3000;
/** A direct save response is only accepted when its timestamp is within 5 minutes of the request. */
const FRESHNESS_WINDOW_MS = 5 * 60 * 1000;
/** Anonymous SPN shares a small pool of active sessions; wait 30 s and retry once. */
const SESSION_LIMIT_WAIT_MS = 30 * 1000;
const SESSION_LIMIT_PATTERN = /limit of active save page now sessions/i;

/** Latest-snapshot lookup URL for any page; never throws. */
export function waybackLookupUrl(url: string): string {
	return `https://web.archive.org/web/${url}`;
}

/** Lowercase and strip a leading "www." from a hostname. */
function normalizeHost(host: string): string {
	const lower = host.trim().toLowerCase();
	return lower.startsWith('www.') ? lower.slice(4) : lower;
}

/**
 * Normalize one ignored-domain entry the way the settings parser does:
 * lowercase, drop any scheme/path, then strip wildcard ("*."), leading-dot,
 * and "www." prefixes. Kept in sync with parseIgnoredDomains in settings.ts.
 */
function normalizeIgnoredEntry(entry: string): string {
	let domain = entry.trim().toLowerCase();
	const schemeAt = domain.indexOf('://');
	if (schemeAt >= 0) domain = domain.slice(schemeAt + 3);
	const slashAt = domain.indexOf('/');
	if (slashAt >= 0) domain = domain.slice(0, slashAt);
	while (domain.startsWith('*.')) domain = domain.slice(2);
	while (domain.startsWith('.')) domain = domain.slice(1);
	return normalizeHost(domain);
}

/**
 * True when the URL's host matches an ignored domain exactly or as a
 * subdomain ("sub.example.com" is ignored by "example.com"). Never throws.
 */
export function isIgnoredDomain(url: string, ignored: string[]): boolean {
	let host = '';
	try {
		host = new URL(url).hostname;
	} catch {
		return false;
	}
	const normalized = normalizeHost(host);
	if (!normalized) return false;
	for (const entry of ignored) {
		const domain = normalizeIgnoredEntry(entry);
		if (!domain) continue;
		if (normalized === domain || normalized.endsWith(`.${domain}`)) return true;
	}
	return false;
}

/** Parse a Wayback timestamp (yyyyMMddHHmmss, UTC) to epoch ms; NaN when malformed. */
function parseWaybackTimestamp(timestamp: string): number {
	const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(timestamp.trim());
	if (!m) return NaN;
	return Date.UTC(
		Number(m[1] ?? 0),
		Number(m[2] ?? 1) - 1,
		Number(m[3] ?? 1),
		Number(m[4] ?? 0),
		Number(m[5] ?? 0),
		Number(m[6] ?? 0)
	);
}

/** Snapshot permalink for a capture with a known timestamp and original URL. */
function snapshotUrl(timestamp: string, original: string): string {
	return `https://web.archive.org/web/${timestamp}/${original}`;
}

interface SaveResponseBody {
	job_id?: string;
	url?: string;
	timestamp?: string;
	message?: string;
	error?: string;
}

interface StatusResponseBody {
	status?: string;
	timestamp?: string;
	original_url?: string;
	message?: string;
	error?: string;
}

function responseMessage(data: { message?: string; error?: string }): string | undefined {
	const message = data.message ?? data.error;
	return typeof message === 'string' && message.trim().length > 0 ? message.trim() : undefined;
}

function parseBody<T>(json: unknown): T {
	return (typeof json === 'object' && json !== null ? json : {}) as T;
}

interface SubmitOutcome {
	jobId?: string;
	result?: WaybackResult;
}

/**
 * POST the URL to the anonymous Save Page Now endpoint. The response either
 * carries a job_id to poll or a direct url+timestamp capture that must pass
 * the freshness check (a stale timestamp means SPN served an old snapshot
 * instead of capturing now, which counts as a failure).
 */
async function submitSave(
	url: string,
	requestedAt: number,
	throttle: () => Promise<void>
): Promise<SubmitOutcome> {
	await throttle();
	const body = new URLSearchParams({
		url,
		if_not_archived_within: '0',
		skip_first_archive: '1',
	}).toString();
	const res = await requestUrl({
		url: SAVE_ENDPOINT,
		method: 'POST',
		headers: {
			Accept: 'application/json',
			'Content-Type': 'application/x-www-form-urlencoded',
		},
		body,
		throw: false,
	});
	const data = parseBody<SaveResponseBody>(res.json);
	if (res.status >= 400) {
		return { result: { error: responseMessage(data) ?? `Wayback save failed (HTTP ${res.status})` } };
	}
	if (typeof data.job_id === 'string' && data.job_id) return { jobId: data.job_id };
	if (typeof data.url === 'string' && typeof data.timestamp === 'string' && data.timestamp) {
		const capturedAt = parseWaybackTimestamp(data.timestamp);
		if (!Number.isNaN(capturedAt) && Math.abs(requestedAt - capturedAt) <= FRESHNESS_WINDOW_MS) {
			return { result: { archivedUrl: snapshotUrl(data.timestamp, data.url) } };
		}
		return { result: { error: 'Wayback returned a stale snapshot instead of a fresh capture' } };
	}
	return {
		result: { error: responseMessage(data) ?? 'Unexpected response from the Wayback Machine' },
	};
}

/** Poll an SPN job every 3 s until it settles or maxWaitSeconds elapses. */
async function pollJob(
	jobId: string,
	maxWaitSeconds: number,
	originalUrl: string,
	throttle: () => Promise<void>
): Promise<WaybackResult> {
	const deadline = Date.now() + maxWaitSeconds * 1000;
	for (;;) {
		await sleep(POLL_INTERVAL_MS);
		if (Date.now() >= deadline) {
			return { error: `Wayback capture did not finish within ${maxWaitSeconds} seconds` };
		}
		await throttle();
		const res = await requestUrl({
			url: `${STATUS_ENDPOINT}${encodeURIComponent(jobId)}`,
			headers: { Accept: 'application/json' },
			throw: false,
		});
		if (res.status >= 400) continue; // transient status-flap: keep polling until the deadline
		const data = parseBody<StatusResponseBody>(res.json);
		if (data.status === 'success') {
			if (typeof data.timestamp === 'string' && data.timestamp) {
				return { archivedUrl: snapshotUrl(data.timestamp, data.original_url ?? originalUrl) };
			}
			return { archivedUrl: waybackLookupUrl(data.original_url ?? originalUrl) };
		}
		if (data.status === 'error') {
			return { error: responseMessage(data) ?? 'Wayback capture job failed' };
		}
		// 'pending' (or an unknown state): keep polling.
	}
}

/** One full capture attempt: submit, then poll when a job id comes back. */
async function captureOnce(
	url: string,
	maxWaitSeconds: number,
	requestedAt: number,
	throttle: () => Promise<void>
): Promise<WaybackResult> {
	const submitted = await submitSave(url, requestedAt, throttle);
	if (submitted.result) return submitted.result;
	if (submitted.jobId) return pollJob(submitted.jobId, maxWaitSeconds, url, throttle);
	return { error: 'Unexpected response from the Wayback Machine' };
}

/**
 * Fallback for a failed fresh capture: accept the latest existing snapshot
 * from the availability API, then the CDX index (latest 200-status capture).
 */
async function findExistingSnapshot(
	url: string,
	throttle: () => Promise<void>
): Promise<string | undefined> {
	try {
		await throttle();
		const res = await requestUrl({
			url: `${AVAILABILITY_ENDPOINT}?url=${encodeURIComponent(url)}`,
			headers: { Accept: 'application/json' },
			throw: false,
		});
		if (res.status < 400) {
			const data = parseBody<{
				archived_snapshots?: { closest?: { available?: boolean; url?: string } };
			}>(res.json);
			const closest = data.archived_snapshots?.closest;
			if (closest?.available === true && typeof closest.url === 'string' && closest.url) {
				return closest.url;
			}
		}
	} catch (e) {
		console.warn('Linkhaven: Wayback availability lookup failed', e);
	}
	try {
		await throttle();
		const res = await requestUrl({
			url: `${CDX_ENDPOINT}?url=${encodeURIComponent(url)}&output=json&fl=timestamp,original,statuscode&filter=statuscode:200&limit=-1`,
			headers: { Accept: 'application/json' },
			throw: false,
		});
		if (res.status < 400 && Array.isArray(res.json) && res.json.length > 1) {
			const last: unknown = res.json[res.json.length - 1];
			if (Array.isArray(last) && typeof last[0] === 'string' && typeof last[1] === 'string') {
				return snapshotUrl(last[0], last[1]);
			}
		}
	} catch (e) {
		console.warn('Linkhaven: Wayback CDX lookup failed', e);
	}
	return undefined;
}

/**
 * Archive a URL to the Wayback Machine via the anonymous Save Page Now API
 * (no S3 keys — keeps minAppVersion at 1.7.2). Every request goes through
 * the injected `throttle()` (the EnrichQueue's rate limiter) before firing.
 *
 * Flow, adapted from the author's wayback-linker plugin: POST /save → poll
 * /save/status/{job_id} every 3 s up to maxWaitSeconds; a direct url+timestamp
 * response is accepted only when fresh (within 5 minutes of the request); an
 * "active save page now sessions" limit waits 30 s and retries once, then
 * gives up. When no fresh capture lands, the availability API and then the
 * CDX index are consulted for the latest existing snapshot. Never throws;
 * failures are returned as `{ error }`.
 */
export async function archiveUrlToWayback(
	url: string,
	maxWaitSeconds: number,
	throttle: () => Promise<void>
): Promise<WaybackResult> {
	const requestedAt = Date.now();
	try {
		let result = await captureOnce(url, maxWaitSeconds, requestedAt, throttle);
		if (result.error && SESSION_LIMIT_PATTERN.test(result.error)) {
			await sleep(SESSION_LIMIT_WAIT_MS);
			result = await captureOnce(url, maxWaitSeconds, requestedAt, throttle);
			if (result.error && SESSION_LIMIT_PATTERN.test(result.error)) {
				return { error: 'Wayback session limit reached; try again later' };
			}
		}
		if (result.archivedUrl) return result;
		const existing = await findExistingSnapshot(url, throttle);
		if (existing) return { archivedUrl: existing };
		return { error: result.error ?? 'Wayback capture failed' };
	} catch (e) {
		return { error: e instanceof Error ? e.message : String(e) };
	}
}
