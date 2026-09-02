# SPEC.md — Linkhaven (Obsidian plugin)

**"Faithful Port, cross-platform edition"** — a Linkwarden-style bookmark navigator:
collection tree (left dock) + card grid (main area) over one-note-per-bookmark Markdown
files. 100% mobile/desktop parity. NO Electron/Node APIs (isDesktopOnly: false).

## Source of truth for the design
- Data layer: one Markdown note per bookmark with YAML frontmatter (schema below).
- Covers: og:image cached as vault attachment; favicon fallback. No screenshots/PDF.
- Save flow: zero-prompt. Web Clipper drops note in folder → plugin watches + enriches.
  Plugin also offers "Add bookmark" command + obsidian:// URI action.
- Filing is separate from saving: Inbox smart view collects unfiled links.

## Repo layout (project root = shared git repo)
```
manifest.json  versions.json  package.json  tsconfig.json  esbuild.config.mjs
styles.css     README.md      LICENSE (MIT)
src/
  main.ts          # LinkhavenPlugin (default export)
  types.ts         # shared types + constants
  store.ts         # BookmarkStore — vault folder as data store
  enrich.ts        # metadata/cover/favicon/readable capture + retry queue
  importer.ts      # Linkwarden JSON import
  settings.ts      # LinkhavenSettingTab (classic display() API)
  utils.ts         # sanitizeFileName, domainFromUrl, ensureFolder, uniquePathForNote
  modals.ts        # AddBookmarkModal, MoveToModal, ImportModal, ChooserModal
  views/treeView.ts  # CollectionTreeView (ItemView, left dock)
  views/gridView.ts  # BookmarkGridView (ItemView, main area)
```

## manifest.json
```json
{
  "id": "linkhaven",
  "name": "Linkhaven",
  "version": "0.1.0",
  "minAppVersion": "1.7.2",
  "description": "Navigate web bookmarks as vault notes with a collection tree, cover-card grid, and automatic metadata capture.",
  "author": "Real-Fruit-Snacks",
  "isDesktopOnly": false
}
```
versions.json: `{ "0.1.0": "1.7.2" }`

## Toolchain (verified 2026 standard)
- esbuild (format cjs, target es2021, bundle, externals: obsidian, electron, node builtins,
  @codemirror/*, @lezer/*); `npm run build` = `tsc -noEmit -skipLibCheck && node esbuild.config.mjs production`; `npm run dev` = watch.
- tsconfig: strict, noUncheckedIndexedAccess, moduleResolution node, isolatedModules,
  lib ES2021+DOM, include src.
- Deps: `obsidian` (types), esbuild, typescript; runtime deps `@mozilla/readability` +
  `turndown` (+ `@types/turndown`) bundled by esbuild. If npm registry is unreachable,
  FALLBACK: implement `extractReadable(html)` heuristic in enrich.ts (largest text-density
  block) and a minimal `htmlToMarkdown(el)` (headings/p/a/li/img) — do NOT block on deps.
- Optional: eslint with eslint-plugin-obsidianmd flat config if registry allows.

## Hard rules (from 2026 research — violations = review failure)
1. NEVER `detachLeavesOfType` anywhere (esp. onunload). Reuse leaves via
   `workspace.getLeavesOfType`, activate via `ensureSideLeaf(type,'left',{...})` /
   `workspace.getLeaf('tab')` + `leaf.setViewState` + `await workspace.revealLeaf(leaf)`.
2. `leaf.view instanceof MyView` checks (deferred views); never cache view refs.
3. All network via `requestUrl` (never `fetch`). Binary: `res.arrayBuffer` →
   `vault.createBinary` after `ensureFolder`.
4. Frontmatter writes ONLY via `app.fileManager.processFrontMatter(file, fm => {...})`.
5. No `innerHTML`/`outerHTML` — use createEl/createDiv/createSpan/createSvg/setIcon.
   No inline styles (`el.style.x =`) — CSS classes + styles.css (CSS vars allowed only).
6. No console.log (warn/error allowed). UI strings in sentence case.
7. All listeners via `this.registerEvent(...)`, intervals via `this.registerInterval(...)`,
   DOM events via `this.registerDomEvent(...)` — clean unload.
8. Watch data via `metadataCache.on('changed'|'deleted')` + `vault.on('create'|'rename'|'delete')`,
   debounced (obsidian `debounce`); initial scan with `vault.getMarkdownFiles()`.
9. No regex lookbehind (iOS). Use `Platform.isMobile` for any branching, never UA sniffing.
10. `normalizePath()` on all user paths; never assume folders exist (ensureFolder).

## Data schema (frontmatter keys on each bookmark note)
```yaml
url: string          # required; canonical dedupe key
title: string
collection: string   # path form "Dev/Tools"; absent/empty = Inbox
tags: [string]       # YAML list
status: unread|read  # default unread
pinned: boolean      # default false
created: YYYY-MM-DD
cover: string        # vault-relative path to cached og:image (optional)
favicon: string      # vault-relative path to cached favicon (optional)
readable: string     # vault-relative path to readable .md copy (optional)
description: string  # optional
```
Note body: `> {description}` if any, then `## Notes` heading (empty user area).

## Settings (loadData/saveData, Object.assign defaults; classic display() tab — declarative
settings require 1.13, above our minAppVersion)
```ts
interface LinkhavenSettings {
  bookmarksFolder: string;   // default "Bookmarks"
  coversFolder: string;      // default "Bookmarks/covers"
  archiveFolder: string;     // default "Bookmarks/archives"
  captureReadable: boolean;  // default false — save readable text copy on save
  showSaveChooser: boolean;  // default false — collection/tag picker in add modal
  collapsedNodes: string[];  // tree UI state, persisted
  lastFilter: Filter | null; // restore grid filter on reload
}
```

## Interface contracts (exact)
```ts
// types.ts
export type SmartId = 'inbox' | 'pinned' | 'unread' | 'recent';
export type Filter =
  | { kind: 'all' } | { kind: 'collection'; path: string }
  | { kind: 'smart'; id: SmartId } | { kind: 'tag'; tag: string };
export interface BookmarkRecord {
  path: string; url: string; title: string; collection: string;
  tags: string[]; status: 'unread' | 'read'; pinned: boolean;
  created: string; cover?: string; favicon?: string;
  readable?: string; description?: string;
}
export const VIEW_TYPE_TREE = 'linkhaven-tree';
export const VIEW_TYPE_GRID = 'linkhaven-grid';

// store.ts — BookmarkStore
export class BookmarkStore {
  constructor(app: App, getFolder: () => string)
  async init(): Promise<void>                      // initial scan + event wiring
  all(): BookmarkRecord[]
  byUrl(url: string): BookmarkRecord | undefined
  collections(): string[]                          // distinct, sorted, path form
  tags(): string[]
  filter(f: Filter): BookmarkRecord[]              // smart: inbox=collection=='' , recent=latest 30 by created
  subscribe(cb: () => void): () => void            // returns unsubscribe; views use it
  matches(r: BookmarkRecord, f: Filter, query?: string): boolean
}
// store re-emits one debounced change per vault/metadata burst.

// enrich.ts
export async function createBookmarkNote(app: App, s: LinkhavenSettings,
  input: { url: string; title?: string; collection?: string; tags?: string[] }): Promise<TFile>
// - dedupe via store.byUrl → if exists: new Notice('Already saved') + return existing file
// - filename from sanitized title||domain, unique via utils.uniquePathForNote
export class EnrichQueue {
  constructor(app: App, s: () => LinkhavenSettings, store: BookmarkStore)
  enqueue(file: TFile): void   // idempotent; concurrency 2; 250 ms gap between requests
  retryFailed(): void          // called on plugin load
}
// enrich steps per note: requestUrl(url) → DOMParser → title(og:title||<title>),
// description, og:image (resolve relative to page URL), icon link (else /favicon.ico)
// → download cover+favicon via arrayBuffer → vault.createBinary in coversFolder
// → processFrontMatter sets title/description/cover/favicon (only fill title if empty/auto)
// → if settings.captureReadable && !fm.readable: Readability → Turndown →
//   createBinary/create note in archiveFolder, set fm.readable
// - failures: mark record in-memory as failed, Notice only on manual actions, never throw out

// importer.ts
export async function importLinkwarden(app: App, s: LinkhavenSettings, store: BookmarkStore,
  jsonPath: string): Promise<{ created: number; skipped: number }>
// parse vault JSON file: { collections: [{name,parentId,color,links:[{name,url,description,
//   tags:[{name}],createdAt}]}], pinnedLinks: [{url}] }
// - build id-less collection paths by name-chains via parentId (index array order = id order
//   is NOT guaranteed — resolve parent by object identity per Linkwarden exportData.ts)
// - per link: createBookmarkNote(url,name,description,tags,collectionPath,createdAt→created)
// - pinnedLinks url set → pinned: true; then queue enrichment for all new notes

// grid/tree talk only through plugin: plugin.store, plugin.filter: Filter,
// plugin.setFilter(f) → notifies views; plugin.openGrid(): Promise<void>
```

## Views — behavior
### CollectionTreeView (left dock, icon 'bookmark')
- Header: filter input (live text filter of tree + forwards query to grid as search).
- Section "Views": All bookmarks, Inbox (count), Pinned (count), Unread (count), Recent.
- Section "Collections": tree built from `store.collections()` path segments; each node:
  expand arrow (persist in settings.collapsedNodes), name, count of direct+descendant links.
  Click node → plugin.setFilter({kind:'collection',path}) + plugin.openGrid().
- Section "Tags": flat sorted list w/ counts → filter kind 'tag'.
- Active filter node gets `.is-active`. Empty state: "No bookmarks yet" + hint to save.
- Rebuild on store.subscribe callback; keep DOM updates simple full-rerender (debounced).

### BookmarkGridView (main area, icon 'layout-grid')
- Toolbar: current filter label (+breadcrumb for collection path), live search input
  (filters within current Filter via store.matches title/url/tags/description),
  grid/list toggle button (icon 'layout-grid'/'list').
- Cards (grid) / rows (list): cover img via `app.vault.getResourcePath(vault.getFileByPath(cover))`
  when cover exists (img with loading lazy attr via setAttribute), else favicon tile, else
  letter tile (first letter of domain). Title (2-line clamp via CSS), domain, tag chips,
  status dot (unread), pinned indicator, created date.
- Card click → `window.open(url, '_external')`. Buttons per card (icon buttons with
  aria-labels): open note (workspace.openLinkText? use `app.workspace.getLeaf('tab')
  .openFile(file)`), open readable (if fm.readable), toggle read/unread, toggle pin,
  "Move to…" (MoveToModal → processFrontMatter collection), trash
  (`app.fileManager.trashFile(file)` after ConfirmModal).
- Render in chunks of 60 cards via requestAnimationFrame; "Showing N of M" footer with
  "Show more" button when capped at 300.
- Empty states per filter kind (e.g., Inbox zero → "Inbox is clear").

### Modals
- AddBookmarkModal: URL text field (try clipboard prefill via navigator.clipboard.readText
  in try/catch — may fail on mobile, ignore), title optional; when showSaveChooser:
  collection dropdown (existing + "New…"→text) + tags text (comma). Submit →
  createBookmarkNote → Notice "Saved to Inbox" / "Saved to {collection}".
- MoveToModal: collection dropdown + New…; applies via processFrontMatter.
- ImportModal: dropdown listing *.json files at vault root (or text path), runs importer,
  Notice with counts.
- All modals sentence case, keyboard: Enter submits.

## Commands (no default hotkeys; ids without plugin id prefix per convention)
- `open-grid` "Open bookmark grid" (also ribbon icon 'bookmark')
- `open-tree` "Open collection tree"
- `add-bookmark` "Add bookmark from URL"
- `import-linkwarden` "Import bookmarks from Linkwarden export"
- protocol handler: action `bookmark-add`, params url[,collection,tags(comma)] → same as add
  command. (README must note Obsidian's URI confirmation dialog / allowlist.)

## Styling (styles.css, scoped .lh-* only, theme variables)
- `.lh-grid` CSS grid: `repeat(auto-fill, minmax(170px, 1fr))`, gap var(--size-4-3).
- Card: var(--background-primary), border var(--background-modifier-border),
  radius var(--radius-m); cover 16:9 object-fit cover; hover raise via
  var(--background-modifier-hover). List mode: rows with 44px min touch height.
- Tree rows reuse native-like paddings via vars; `.is-active` uses
  var(--background-modifier-hover)+var(--text-accent)? NO accent text — use
  var(--interactive-accent) bg tint classes consistent with themes.
- `@media (max-width: 480px)` or Platform-based body class: larger paddings,
  min 44px touch targets, single-column grid min 150px.

## Build acceptance
- `npm run build` exits 0 (tsc clean + esbuild bundle).
- main.js + manifest.json + styles.css = the shippable triple.
- README.md: purpose, install (copy to .obsidian/plugins/linkhaven, enable),
  usage (save flows incl. Web Clipper template JSON snippet + iOS Shortcut URI),
  Linkwarden import steps, settings list, network-use disclosure (fetches saved pages +
  og:image/favicon from their origins only), privacy note (no telemetry).
