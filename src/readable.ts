import { Readability } from '@mozilla/readability';
import TurndownService from 'turndown';

export interface ReadableResult {
	title: string;
	markdown: string;
	textLength: number;
}

const MIN_ARTICLE_CHARS = 600;
const MIN_FALLBACK_CHARS = 300;
const FALLBACK_SELECTOR =
	'article, main, [role="main"], .markdown-body, #readme, .post, .entry-content, .post-content';

function trimmedLength(node: { textContent?: string | null } | null | undefined): number {
	return node?.textContent?.trim().length ?? 0;
}

function pageTitle(doc: Document): string {
	const og = doc.querySelector('meta[property="og:title"]')?.getAttribute('content')?.trim();
	if (og) return og;
	return doc.querySelector('title')?.textContent?.trim() ?? '';
}

/**
 * Extract a readable Markdown copy from a parsed HTML document.
 * Pure DOM in/out — works in Obsidian (DOMParser) and in Node (jsdom).
 * Returns null when neither Readability nor the semantic-container
 * fallback finds enough text.
 */
export function extractReadableMarkdown(doc: Document, pageUrl: string): ReadableResult | null {
	// Resolve relative links/images before anything reads hrefs. Prepending
	// wins over a base tag the page may already carry.
	const base = doc.createElement('base');
	base.setAttribute('href', pageUrl);
	doc.head.prepend(base);

	const turndown = new TurndownService({ headingStyle: 'atx' });
	const fallbackTitle = pageTitle(doc) || pageUrl;
	const toResult = (title: string, textLength: number, body: string): ReadableResult => ({
		title,
		textLength,
		markdown: `# ${title}\n\nSource: ${pageUrl}\n\n${body.trim()}\n`,
	});

	// Readability mutates the document it parses — hand it a clone so the
	// caller's document (and the fallback below) stays intact.
	let article: ReturnType<Readability['parse']> = null;
	try {
		const clone = doc.cloneNode(true) as Document;
		article = new Readability(clone, { charThreshold: 100 }).parse();
		const length = trimmedLength(article);
		if (article && typeof article.content === 'string' && length >= MIN_ARTICLE_CHARS) {
			const title = article.title?.trim() || fallbackTitle;
			return toResult(title, length, turndown.turndown(article.content));
		}
	} catch (e) {
		console.warn('Linkhaven: Readability pass failed', e);
	}

	// Fallback: largest semantic container by visible text.
	let best: Element | null = null;
	for (const el of Array.from(doc.querySelectorAll(FALLBACK_SELECTOR))) {
		if (trimmedLength(el) > trimmedLength(best)) best = el;
	}
	const length = trimmedLength(best);
	if (best && length >= MIN_FALLBACK_CHARS) {
		// Turndown accepts DOM nodes directly — no innerHTML read needed.
		// (Cast: @types/turndown narrows nodes to HTMLElement; any Element works.)
		return toResult(fallbackTitle, length, turndown.turndown(best as HTMLElement));
	}

	// Last resort for tiny pages below both thresholds (e.g. example.com):
	// Readability still parsed something — better a short copy than none.
	if (article && typeof article.content === 'string' && trimmedLength(article) > 0) {
		const title = article.title?.trim() || fallbackTitle;
		return toResult(title, trimmedLength(article), turndown.turndown(article.content));
	}
	return null;
}
