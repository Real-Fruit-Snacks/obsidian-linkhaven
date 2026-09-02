import { App, Component, Modal, Notice, Setting, TFile, normalizePath, setIcon } from 'obsidian';
import { createBookmarkNote } from './enrich';
import { importLinkwarden } from './importer';
import type LinkhavenPlugin from './main';
import { sanitizeCollectionPart } from './utils';

/** Simple confirmation dialog (Obsidian does not ship one). */
export class ConfirmModal extends Modal {
	private message: string;
	private onConfirm: () => void;
	private helper = new Component();

	constructor(app: App, message: string, onConfirm: () => void) {
		super(app);
		this.message = message;
		this.onConfirm = onConfirm;
	}

	onOpen(): void {
		this.helper.load();
		const { contentEl } = this;
		contentEl.addClass('lh-modal');
		contentEl.createEl('p', { text: this.message });
		const buttons = contentEl.createDiv({ cls: 'lh-modal-buttons' });
		const cancel = buttons.createEl('button', { text: 'Cancel' });
		const confirm = buttons.createEl('button', { text: 'Confirm', cls: 'mod-cta' });
		this.helper.registerDomEvent(cancel, 'click', () => this.close());
		this.helper.registerDomEvent(confirm, 'click', () => {
			this.close();
			this.onConfirm();
		});
		this.helper.registerDomEvent(contentEl, 'keydown', (e: KeyboardEvent) => {
			if (e.key === 'Enter') {
				e.preventDefault();
				this.close();
				this.onConfirm();
			}
		});
	}

	onClose(): void {
		this.helper.unload();
		this.contentEl.empty();
	}
}

/**
 * Generic single-choice picker with a filter input. Enter picks the
 * highlighted (first visible) option. Used for browsing vault files.
 */
export class ChooserModal extends Modal {
	private options: string[];
	private placeholder: string;
	private onChoose: (choice: string) => void;
	private onCancel: (() => void) | null;
	private chosen = false;
	private helper = new Component();
	private listEl!: HTMLElement;
	private inputEl!: HTMLInputElement;

	constructor(
		app: App,
		options: string[],
		placeholder: string,
		onChoose: (choice: string) => void,
		onCancel?: () => void
	) {
		super(app);
		this.options = options;
		this.placeholder = placeholder;
		this.onChoose = onChoose;
		this.onCancel = onCancel ?? null;
	}

	onOpen(): void {
		this.helper.load();
		const { contentEl } = this;
		contentEl.addClass('lh-modal');
		this.inputEl = contentEl.createEl('input', {
			cls: 'lh-chooser-input',
			attr: { type: 'text', placeholder: this.placeholder },
		});
		this.listEl = contentEl.createDiv({ cls: 'lh-chooser-list' });
		this.renderList('');
		this.helper.registerDomEvent(this.inputEl, 'input', () =>
			this.renderList(this.inputEl.value)
		);
		this.helper.registerDomEvent(this.inputEl, 'keydown', (e: KeyboardEvent) => {
			if (e.key === 'Enter') {
				e.preventDefault();
				const first = this.listEl.querySelector<HTMLElement>('.lh-chooser-item');
				if (first) this.pick(first.dataset['value'] ?? '');
			}
		});
		this.helper.registerDomEvent(this.listEl, 'click', (e: MouseEvent) => {
			const item = (e.target as HTMLElement).closest<HTMLElement>('.lh-chooser-item');
			if (item) this.pick(item.dataset['value'] ?? '');
		});
		this.inputEl.focus();
	}

	private renderList(query: string): void {
		this.listEl.empty();
		const q = query.trim().toLowerCase();
		const shown = this.options.filter((o) => !q || o.toLowerCase().includes(q)).slice(0, 50);
		if (shown.length === 0) {
			this.listEl.createDiv({ cls: 'lh-empty', text: 'No matches' });
			return;
		}
		for (const option of shown) {
			const item = this.listEl.createDiv({ cls: 'lh-chooser-item', text: option });
			item.dataset['value'] = option;
		}
	}

	private pick(value: string): void {
		if (!value) return;
		this.chosen = true;
		this.close();
		this.onChoose(value);
	}

	onClose(): void {
		this.helper.unload();
		this.contentEl.empty();
		if (!this.chosen) this.onCancel?.();
	}
}

export interface AddBookmarkPreset {
	url?: string;
	collection?: string;
	tags?: string[];
}

export class AddBookmarkModal extends Modal {
	private plugin: LinkhavenPlugin;
	private helper = new Component();
	private url = '';
	private title = '';
	private collection = '';
	private tags = '';
	private urlComponent: import('obsidian').TextComponent | null = null;
	private saveButton: HTMLButtonElement | null = null;
	private submitting = false;

	constructor(app: App, plugin: LinkhavenPlugin, preset?: AddBookmarkPreset) {
		super(app);
		this.plugin = plugin;
		this.url = preset?.url ?? '';
		this.collection = preset?.collection ?? '';
		this.tags = (preset?.tags ?? []).join(', ');
	}

	onOpen(): void {
		this.helper.load();
		const { contentEl } = this;
		contentEl.addClass('lh-modal');
		contentEl.createEl('h2', { text: 'Add bookmark' });

		new Setting(contentEl).setName('URL').addText((text) => {
			this.urlComponent = text;
			text.setPlaceholder('https://example.com')
				.setValue(this.url)
				.onChange((value) => {
					this.url = value.trim();
				});
		});

		new Setting(contentEl).setName('Title').addText((text) =>
			text
				.setPlaceholder('Optional')
				.setValue(this.title)
				.onChange((value) => {
					this.title = value;
				})
		);

		if (this.plugin.settings.showSaveChooser) {
			const collections = this.plugin.store.collections();
			let textWrap: HTMLElement | null = null;
			new Setting(contentEl).setName('Collection').addDropdown((drop) => {
				drop.addOption('', 'Inbox');
				for (const c of collections) drop.addOption(c, c);
				drop.addOption('__new__', 'New…');
				drop.setValue(this.collection);
				drop.onChange((value) => {
					if (value === '__new__') {
						this.collection = '';
						textWrap?.removeClass('lh-hidden');
					} else {
						this.collection = value;
						textWrap?.addClass('lh-hidden');
					}
				});
			});
			textWrap = contentEl.createDiv({ cls: 'lh-hidden' });
			new Setting(textWrap).setName('New collection').addText((text) =>
				text.setPlaceholder('Dev/tools').onChange((value) => {
					this.collection = value
						.split('/')
						.map((part) => sanitizeCollectionPart(part))
						.filter((part) => part.length > 0)
						.join('/');
				})
			);

			new Setting(contentEl).setName('Tags').addText((text) =>
				text
					.setPlaceholder('Comma separated')
					.setValue(this.tags)
					.onChange((value) => {
						this.tags = value;
					})
			);
		}

		const buttons = contentEl.createDiv({ cls: 'lh-modal-buttons' });
		const save = buttons.createEl('button', { text: 'Save bookmark', cls: 'mod-cta' });
		this.saveButton = save;
		this.helper.registerDomEvent(save, 'click', () => void this.submit());
		this.helper.registerDomEvent(contentEl, 'keydown', (e: KeyboardEvent) => {
			if (e.key === 'Enter') {
				e.preventDefault();
				void this.submit();
			}
		});

		// Clipboard prefill (may fail on mobile; ignored).
		void (async () => {
			try {
				const clip = (await navigator.clipboard.readText()).trim();
				if (!this.url && /^https?:\/\//.test(clip) && this.urlComponent) {
					this.url = clip;
					this.urlComponent.setValue(clip);
				}
			} catch {
				// clipboard unavailable; ignore
			}
		})();
	}

	private async submit(): Promise<void> {
		if (this.submitting) return;
		const url = this.url.trim();
		if (!/^https?:\/\//.test(url)) {
			new Notice('Enter a valid URL');
			return;
		}
		this.submitting = true;
		if (this.saveButton) this.saveButton.disabled = true;
		try {
			const tags = this.tags
				.split(',')
				.map((t) => t.trim())
				.filter((t) => t.length > 0);
			const known = this.plugin.store.byUrl(url);
			const { file } = await createBookmarkNote(this.app, this.plugin.settings, {
				url,
				title: this.title.trim() || undefined,
				collection: this.collection || undefined,
				tags: tags.length > 0 ? tags : undefined,
			});
			this.plugin.enrichQueue.enqueue(file);
			if (!known) {
				new Notice(this.collection ? `Saved to ${this.collection}` : 'Saved to Inbox');
			}
			this.close();
		} finally {
			this.submitting = false;
			if (this.saveButton) this.saveButton.disabled = false;
		}
	}

	onClose(): void {
		this.helper.unload();
		this.contentEl.empty();
	}
}

export class MoveToModal extends Modal {
	private plugin: LinkhavenPlugin;
	private file: TFile;
	private helper = new Component();
	private selection = '';

	constructor(app: App, plugin: LinkhavenPlugin, file: TFile) {
		super(app);
		this.plugin = plugin;
		this.file = file;
	}

	onOpen(): void {
		this.helper.load();
		const { contentEl } = this;
		contentEl.addClass('lh-modal');
		contentEl.createEl('h2', { text: 'Move to collection' });

		const collections = this.plugin.store.collections();
		let textWrap: HTMLElement | null = null;
		new Setting(contentEl).setName('Collection').addDropdown((drop) => {
			drop.addOption('', 'Inbox');
			for (const c of collections) drop.addOption(c, c);
			drop.addOption('__new__', 'New…');
			const record = this.plugin.store
				.all()
				.find((r) => r.path === this.file.path);
			if (record) drop.setValue(record.collection);
			this.selection = record?.collection ?? '';
			drop.onChange((value) => {
				if (value === '__new__') {
					this.selection = '';
					textWrap?.removeClass('lh-hidden');
				} else {
					this.selection = value;
					textWrap?.addClass('lh-hidden');
				}
			});
		});
		textWrap = contentEl.createDiv({ cls: 'lh-hidden' });
		new Setting(textWrap).setName('New collection').addText((text) =>
			text.setPlaceholder('Dev/tools').onChange((value) => {
				this.selection = value
					.split('/')
					.map((part) => sanitizeCollectionPart(part))
					.filter((part) => part.length > 0)
					.join('/');
			})
		);

		const buttons = contentEl.createDiv({ cls: 'lh-modal-buttons' });
		const move = buttons.createEl('button', { text: 'Move', cls: 'mod-cta' });
		this.helper.registerDomEvent(move, 'click', () => void this.apply());
		this.helper.registerDomEvent(contentEl, 'keydown', (e: KeyboardEvent) => {
			if (e.key === 'Enter') {
				e.preventDefault();
				void this.apply();
			}
		});
	}

	private async apply(): Promise<void> {
		const target = this.selection;
		await this.app.fileManager.processFrontMatter(this.file, (m: Record<string, unknown>) => {
			if (target) {
				m['collection'] = target;
			} else {
				delete m['collection'];
			}
		});
		new Notice(target ? `Moved to ${target}` : 'Moved to Inbox');
		this.close();
	}

	onClose(): void {
		this.helper.unload();
		this.contentEl.empty();
	}
}

export class ImportModal extends Modal {
	private plugin: LinkhavenPlugin;
	private helper = new Component();
	private jsonPath = '';
	private dropdown: import('obsidian').DropdownComponent | null = null;
	private lastFileChoice = '';

	constructor(app: App, plugin: LinkhavenPlugin) {
		super(app);
		this.plugin = plugin;
	}

	onOpen(): void {
		this.helper.load();
		const { contentEl } = this;
		contentEl.addClass('lh-modal');
		contentEl.createEl('h2', { text: 'Import from Linkwarden' });
		contentEl.createEl('p', {
			text: 'Choose the Linkwarden JSON export file stored in this vault.',
			cls: 'lh-muted',
		});

		const rootJson = this.app.vault
			.getFiles()
			.filter((f) => f.extension === 'json' && f.parent && f.parent.isRoot())
			.map((f) => f.path)
			.sort((a, b) => a.localeCompare(b));

		let textWrap: HTMLElement | null = null;
		new Setting(contentEl).setName('Export file').addDropdown((drop) => {
			this.dropdown = drop;
			for (const path of rootJson) drop.addOption(path, path);
			drop.addOption('__browse__', 'Browse vault…');
			drop.addOption('__manual__', 'Enter path manually…');
			if (rootJson.length > 0) {
				this.jsonPath = rootJson[0] ?? '';
				drop.setValue(this.jsonPath);
			} else {
				drop.setValue('__manual__');
			}
			this.lastFileChoice = drop.getValue();
			drop.onChange((value) => {
				if (value === '__manual__') {
					this.lastFileChoice = value;
					this.jsonPath = '';
					textWrap?.removeClass('lh-hidden');
				} else if (value === '__browse__') {
					const all = this.app.vault
						.getFiles()
						.filter((f) => f.extension === 'json')
						.map((f) => f.path)
						.sort((a, b) => a.localeCompare(b));
					new ChooserModal(
						this.app,
						all,
						'Choose a JSON file',
						(choice) => {
							this.jsonPath = choice;
							void this.runImport();
						},
						() => {
							// Cancelled: restore the previous value so Browse can
							// be re-selected (setValue does not fire onChange).
							this.dropdown?.setValue(this.lastFileChoice);
						}
					).open();
				} else {
					this.lastFileChoice = value;
					this.jsonPath = value;
					textWrap?.addClass('lh-hidden');
				}
			});
		});
		textWrap = contentEl.createDiv({ cls: 'lh-hidden' });
		// No root *.json files: the dropdown defaults to manual entry.
		if (rootJson.length === 0) textWrap.removeClass('lh-hidden');
		new Setting(textWrap).setName('File path').addText((text) =>
			text.setPlaceholder('linkwarden-export.json').onChange((value) => {
				this.jsonPath = value.trim();
			})
		);

		const buttons = contentEl.createDiv({ cls: 'lh-modal-buttons' });
		const run = buttons.createEl('button', { text: 'Import', cls: 'mod-cta' });
		this.helper.registerDomEvent(run, 'click', () => void this.runImport());
		this.helper.registerDomEvent(contentEl, 'keydown', (e: KeyboardEvent) => {
			if (e.key === 'Enter') {
				e.preventDefault();
				void this.runImport();
			}
		});
	}

	private async runImport(): Promise<void> {
		const path = normalizePath(this.jsonPath.trim());
		if (!path) {
			new Notice('Choose an export file first');
			return;
		}
		this.close();
		const { created, skipped } = await importLinkwarden(
			this.app,
			this.plugin.settings,
			this.plugin.store,
			path
		);
		new Notice(`Imported ${created} bookmarks, skipped ${skipped}`);
	}

	onClose(): void {
		this.helper.unload();
		this.contentEl.empty();
	}
}

/** Small icon button factory shared by views (kept here to avoid duplication). */
export function iconButton(parent: HTMLElement, icon: string, label: string): HTMLElement {
	const btn = parent.createEl('button', { cls: 'lh-icon-btn clickable-icon' });
	btn.setAttribute('aria-label', label);
	setIcon(btn, icon);
	return btn;
}
