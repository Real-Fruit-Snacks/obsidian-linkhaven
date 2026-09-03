import {
	App,
	MarkdownView,
	Notice,
	SuggestModal,
	prepareFuzzySearch,
} from 'obsidian';
import type LinkhavenPlugin from './main';
import type { BookmarkRecord } from './types';
import { domainFromUrl } from './utils';

const EMPTY_QUERY_CAP = 20;
const SEARCH_CAP = 50;

/**
 * Fuzzy bookmark palette (SuggestModal): quick-open, insert-into-note, and
 * readable-copy actions for every bookmark in the store.
 *
 * The constructor takes the plugin (like the views) so the modal reads
 * plugin.store and plugin.settings directly.
 */
export class BookmarkLauncher extends SuggestModal<BookmarkRecord> {
	private plugin: LinkhavenPlugin;

	constructor(app: App, plugin: LinkhavenPlugin) {
		super(app);
		this.plugin = plugin;
		this.setPlaceholder('Find a bookmark…');
		this.setInstructions([
			{ command: '↵', purpose: 'open' },
			{ command: '⌘↵', purpose: 'insert into note' },
			{ command: '⌥↵', purpose: 'readable copy' },
		]);
		this.emptyStateText = 'No matching bookmarks';
	}

	getSuggestions(query: string): BookmarkRecord[] {
		const q = query.trim();
		if (!q) return this.defaultSuggestions();
		const matcher = prepareFuzzySearch(q);
		if (!matcher) return [];
		// Same haystack fields as store.matches, plus the collection, ranked
		// by the fuzzy score (the store's matches() only gates inclusion).
		return this.plugin.store
			.all()
			.map((record) => {
				const text = `${record.title} ${record.url} ${record.tags.join(' ')} ${record.collection} ${record.description ?? ''}`;
				const result = matcher(text);
				return result ? { record, score: result.score } : null;
			})
			.filter((entry): entry is { record: BookmarkRecord; score: number } => entry !== null)
			.sort((a, b) => b.score - a.score || b.record.created.localeCompare(a.record.created))
			.slice(0, SEARCH_CAP)
			.map((entry) => entry.record);
	}

	/** Empty query: pinned, then unread, then recent — deduped, capped. */
	private defaultSuggestions(): BookmarkRecord[] {
		const store = this.plugin.store;
		const seen = new Set<string>();
		const merged: BookmarkRecord[] = [];
		for (const id of ['pinned', 'unread', 'recent'] as const) {
			for (const record of store.filter({ kind: 'smart', id })) {
				if (seen.has(record.path)) continue;
				seen.add(record.path);
				merged.push(record);
				if (merged.length >= EMPTY_QUERY_CAP) return merged;
			}
		}
		return merged;
	}

	renderSuggestion(record: BookmarkRecord, el: HTMLElement): void {
		const row = el.createDiv({ cls: 'lh-launcher-row' });

		const icon = row.createDiv({ cls: 'lh-launcher-icon' });
		const faviconFile = record.favicon ? this.app.vault.getFileByPath(record.favicon) : null;
		if (faviconFile) {
			icon.createEl('img', {
				cls: 'lh-launcher-favicon',
				attr: { src: this.app.vault.getResourcePath(faviconFile), alt: '', loading: 'lazy' },
			});
		} else {
			const domain = domainFromUrl(record.url);
			icon.createDiv({
				cls: 'lh-launcher-letter',
				text: (domain.charAt(0) || '?').toUpperCase(),
			});
		}

		const body = row.createDiv({ cls: 'lh-launcher-body' });
		body.createDiv({
			cls: 'lh-launcher-title',
			text: record.title || domainFromUrl(record.url) || record.url,
		});
		body.createDiv({ cls: 'lh-launcher-domain', text: domainFromUrl(record.url) || record.url });

		if (record.tags.length > 0) {
			const tags = row.createDiv({ cls: 'lh-launcher-tags' });
			for (const tag of record.tags.slice(0, 2)) {
				tags.createSpan({ cls: 'lh-launcher-tag', text: tag });
			}
		}
	}

	onChooseSuggestion(item: BookmarkRecord, evt: MouseEvent | KeyboardEvent): void {
		if (evt.metaKey || evt.ctrlKey) {
			this.insertIntoActiveNote(item);
			return;
		}
		if (evt.altKey) {
			void this.openReadableCopy(item);
			return;
		}
		this.plugin.openBookmarkLink(item);
	}

	/** Cmd/Ctrl+Enter: insert a Markdown link into the active note. */
	private insertIntoActiveNote(item: BookmarkRecord): void {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view) {
			new Notice('No active note to insert into');
			return;
		}
		const label = item.title || domainFromUrl(item.url) || item.url;
		view.editor.replaceSelection(`[${label}](${item.url})`);
	}

	/** Alt+Enter: open the captured readable copy in a tab. */
	private async openReadableCopy(item: BookmarkRecord): Promise<void> {
		const file = item.readable ? this.app.vault.getFileByPath(item.readable) : null;
		if (!file) {
			new Notice('No readable copy');
			return;
		}
		await this.app.workspace.getLeaf('tab').openFile(file);
		// mark-read-on-open lives in one place: the plugin's public method.
		await this.plugin.markReadOnOpen(item);
	}
}
