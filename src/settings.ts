import { App, PluginSettingTab, Setting, normalizePath } from 'obsidian';
import type { SettingDefinitionItem } from 'obsidian';
import type LinkhavenPlugin from './main';
import type { Filter } from './types';

export interface LinkhavenSettings {
	// knownCollections: user-created (possibly empty) collections; the store
	// reports union(collections derived from notes, knownCollections).
	bookmarksFolder: string;
	coversFolder: string;
	archiveFolder: string;
	captureReadable: boolean;
	showSaveChooser: boolean;
	collapsedNodes: string[];
	lastFilter: Filter | null;
	knownCollections: string[];
}

export const DEFAULT_SETTINGS: LinkhavenSettings = {
	bookmarksFolder: 'Bookmarks',
	coversFolder: 'Bookmarks/covers',
	archiveFolder: 'Bookmarks/archives',
	captureReadable: false,
	showSaveChooser: false,
	collapsedNodes: [],
	lastFilter: null,
	knownCollections: [],
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
	}
}
