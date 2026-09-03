import { App, Notice, PluginSettingTab, Setting, normalizePath } from 'obsidian';
import type { SettingDefinitionItem, TextComponent } from 'obsidian';
import type LinkhavenPlugin from './main';
import type { Filter, GridSort } from './types';

const GRID_SORT_OPTIONS: Record<GridSort, string> = {
	newest: 'Newest first',
	oldest: 'Oldest first',
	title: 'Title',
	domain: 'Domain',
};

function asGridSort(value: unknown): GridSort {
	const candidate = String(value);
	return candidate in GRID_SORT_OPTIONS ? (candidate as GridSort) : DEFAULT_SETTINGS.gridSort;
}

/** Placeholder in the mobile save link that the shortcut replaces with the shared URL. */
const MOBILE_SAVE_PLACEHOLDER = 'PASTE_OR_SHORTCUT_INPUT';
// Kept out of line so the sentence-case lint does not rewrite "obsidian://".
const MOBILE_SAVE_DESC =
	'Copy an obsidian:// link you can use from a share-sheet shortcut on your phone.';

export interface LinkhavenSettings {
	// knownCollections: user-created (possibly empty) collections; the store
	// reports union(collections derived from notes, knownCollections).
	bookmarksFolder: string;
	coversFolder: string;
	archiveFolder: string;
	captureReadable: boolean;
	showSaveChooser: boolean;
	renameNotesToTitle: boolean;
	gridSort: GridSort;
	markReadOnOpen: boolean;
	collapsedNodes: string[];
	lastFilter: Filter | null;
	knownCollections: string[];
	// collectionIcons: collection path -> lucide icon id, managed from the
	// tree's context menu (no settings-tab row).
	collectionIcons: Record<string, string>;
}

export const DEFAULT_SETTINGS: LinkhavenSettings = {
	bookmarksFolder: 'Bookmarks',
	coversFolder: 'Bookmarks/covers',
	archiveFolder: 'Bookmarks/archives',
	captureReadable: false,
	showSaveChooser: false,
	renameNotesToTitle: true,
	gridSort: 'newest',
	markReadOnOpen: false,
	collapsedNodes: [],
	lastFilter: null,
	knownCollections: [],
	collectionIcons: {},
};

export class LinkhavenSettingTab extends PluginSettingTab {
	plugin: LinkhavenPlugin;

	constructor(app: App, plugin: LinkhavenPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	// Declarative definitions power settings search on Obsidian 1.13+; rendering
	// stays in display() below so the tab also works on older app versions.
	override getSettingDefinitions(): SettingDefinitionItem[] {
		return [
			{
				name: 'Bookmarks folder',
				desc: 'Folder that holds one note per bookmark.',
				control: {
					type: 'text',
					key: 'bookmarksFolder',
					placeholder: DEFAULT_SETTINGS.bookmarksFolder,
					defaultValue: DEFAULT_SETTINGS.bookmarksFolder,
				},
			},
			{
				name: 'Covers folder',
				desc: 'Folder for cached cover images and favicons.',
				control: {
					type: 'text',
					key: 'coversFolder',
					placeholder: DEFAULT_SETTINGS.coversFolder,
					defaultValue: DEFAULT_SETTINGS.coversFolder,
				},
			},
			{
				name: 'Archive folder',
				desc: 'Folder for readable text copies of saved pages.',
				control: {
					type: 'text',
					key: 'archiveFolder',
					placeholder: DEFAULT_SETTINGS.archiveFolder,
					defaultValue: DEFAULT_SETTINGS.archiveFolder,
				},
			},
			{
				name: 'Capture readable copy',
				desc: 'Save a readable markdown copy of each page when it is enriched.',
				control: {
					type: 'toggle',
					key: 'captureReadable',
					defaultValue: DEFAULT_SETTINGS.captureReadable,
				},
			},
			{
				name: 'Show save chooser',
				desc: 'Show collection and tag pickers in the add bookmark modal.',
				control: {
					type: 'toggle',
					key: 'showSaveChooser',
					defaultValue: DEFAULT_SETTINGS.showSaveChooser,
				},
			},
			{
				name: 'Rename notes to page title',
				desc: 'Rename auto-named bookmark notes (domain-based file names) to the fetched page title after enrichment.',
				control: {
					type: 'toggle',
					key: 'renameNotesToTitle',
					defaultValue: DEFAULT_SETTINGS.renameNotesToTitle,
				},
			},
			{
				name: 'Grid sort',
				desc: 'Order of bookmarks in the grid, applied after filtering and search.',
				control: {
					type: 'dropdown',
					key: 'gridSort',
					options: GRID_SORT_OPTIONS,
					defaultValue: DEFAULT_SETTINGS.gridSort,
				},
			},
			{
				name: 'Mark as read on open',
				desc: 'Silently mark a bookmark as read when its link or readable copy is opened.',
				control: {
					type: 'toggle',
					key: 'markReadOnOpen',
					defaultValue: DEFAULT_SETTINGS.markReadOnOpen,
				},
			},
			{
				name: 'Mobile save link',
				desc: MOBILE_SAVE_DESC,
				action: () => void this.copyMobileSaveLink(),
			},
		];
	}

	// Mirrors the onChange handlers in display(): normalize folders, fall back
	// to defaults, persist, and rescan when the bookmarks folder moves.
	override async setControlValue(key: string, value: unknown): Promise<void> {
		const s = this.plugin.settings;
		switch (key) {
			case 'bookmarksFolder':
				s.bookmarksFolder = normalizePath(String(value).trim()) || DEFAULT_SETTINGS.bookmarksFolder;
				await this.plugin.saveSettings();
				await this.plugin.store.rescan();
				return;
			case 'coversFolder':
				s.coversFolder = normalizePath(String(value).trim()) || DEFAULT_SETTINGS.coversFolder;
				await this.plugin.saveSettings();
				return;
			case 'archiveFolder':
				s.archiveFolder = normalizePath(String(value).trim()) || DEFAULT_SETTINGS.archiveFolder;
				await this.plugin.saveSettings();
				return;
			case 'captureReadable':
				s.captureReadable = value === true;
				await this.plugin.saveSettings();
				return;
			case 'showSaveChooser':
				s.showSaveChooser = value === true;
				await this.plugin.saveSettings();
				return;
			case 'renameNotesToTitle':
				s.renameNotesToTitle = value === true;
				await this.plugin.saveSettings();
				return;
			case 'gridSort':
				s.gridSort = asGridSort(value);
				await this.plugin.saveSettings();
				this.plugin.notifyViews();
				return;
			case 'markReadOnOpen':
				s.markReadOnOpen = value === true;
				await this.plugin.saveSettings();
				return;
		}
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName('Bookmarks folder')
			.setDesc('Folder that holds one note per bookmark.')
			.addText((text) =>
				text
					.setPlaceholder('Bookmarks')
					.setValue(this.plugin.settings.bookmarksFolder)
					.onChange(async (value) => {
						await this.setControlValue('bookmarksFolder', value);
					})
			);

		new Setting(containerEl)
			.setName('Covers folder')
			.setDesc('Folder for cached cover images and favicons.')
			.addText((text) =>
				text
					.setPlaceholder('Bookmarks/covers')
					.setValue(this.plugin.settings.coversFolder)
					.onChange(async (value) => {
						await this.setControlValue('coversFolder', value);
					})
			);

		new Setting(containerEl)
			.setName('Archive folder')
			.setDesc('Folder for readable text copies of saved pages.')
			.addText((text) =>
				text
					.setPlaceholder('Bookmarks/archives')
					.setValue(this.plugin.settings.archiveFolder)
					.onChange(async (value) => {
						await this.setControlValue('archiveFolder', value);
					})
			);

		new Setting(containerEl)
			.setName('Capture readable copy')
			.setDesc('Save a readable markdown copy of each page when it is enriched.')
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.captureReadable).onChange(async (value) => {
					await this.setControlValue('captureReadable', value);
				})
			);

		new Setting(containerEl)
			.setName('Show save chooser')
			.setDesc('Show collection and tag pickers in the add bookmark modal.')
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.showSaveChooser).onChange(async (value) => {
					await this.setControlValue('showSaveChooser', value);
				})
			);

		new Setting(containerEl)
			.setName('Rename notes to page title')
			.setDesc(
				'Rename auto-named bookmark notes (domain-based file names) to the fetched page title after enrichment.'
			)
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.renameNotesToTitle).onChange(async (value) => {
					await this.setControlValue('renameNotesToTitle', value);
				})
			);

		new Setting(containerEl)
			.setName('Grid sort')
			.setDesc('Order of bookmarks in the grid, applied after filtering and search.')
			.addDropdown((dropdown) =>
				dropdown
					.addOptions(GRID_SORT_OPTIONS)
					.setValue(this.plugin.settings.gridSort)
					.onChange(async (value) => {
						await this.setControlValue('gridSort', value);
					})
			);

		new Setting(containerEl)
			.setName('Mark as read on open')
			.setDesc('Silently mark a bookmark as read when its link or readable copy is opened.')
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.markReadOnOpen).onChange(async (value) => {
					await this.setControlValue('markReadOnOpen', value);
				})
			);

		let linkField: TextComponent | null = null;
		new Setting(containerEl)
			.setName('Mobile save link')
			.setDesc(MOBILE_SAVE_DESC)
			.addText((text) => {
				linkField = text;
				// Always visible and read-only: when the clipboard write fails
				// (common on mobile), this field is the manual copy target.
				text.setValue(this.mobileSaveUri());
				text.inputEl.setAttribute('readonly', 'true');
			})
			.addButton((button) =>
				button.setButtonText('Copy link').onClick(() => {
					void this.copyMobileSaveLink(linkField);
				})
			);
	}

	/** The obsidian://bookmark-add URI with a placeholder for the shortcut input. */
	private mobileSaveUri(): string {
		return `obsidian://bookmark-add?vault=${encodeURIComponent(this.app.vault.getName())}&url=${MOBILE_SAVE_PLACEHOLDER}`;
	}

	private async copyMobileSaveLink(linkField?: TextComponent | null): Promise<void> {
		const uri = this.mobileSaveUri();
		try {
			await navigator.clipboard.writeText(uri);
			new Notice(`Copied — replace ${MOBILE_SAVE_PLACEHOLDER} with your shortcut input.`);
		} catch {
			new Notice('Copy failed — long-press to select the link');
			// Surface the read-only field's text for manual selection.
			if (linkField) {
				linkField.inputEl.focus();
				linkField.inputEl.select();
			}
		}
	}
}
