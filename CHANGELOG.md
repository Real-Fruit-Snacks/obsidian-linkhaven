# Changelog

All notable changes to Linkhaven are documented here. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/), and this project adheres to
[Semantic Versioning](https://semver.org/).

## [1.5.1] - 2026-09-03

### Added
- Archived badge on cards: bookmarks with a stored Wayback snapshot now show a
  muted archive icon in the card meta row (grid and list modes) with an
  "Archived to Wayback" tooltip.
- Archived smart view: the tree's Views section gains an Archived row that
  collects every bookmark with a Wayback snapshot; the grid shows a
  "Nothing archived yet" empty state when none are archived.

## [1.5.0] - 2026-09-03

### Added
- Wayback Machine integration: a new "Archive saved links to the Wayback Machine"
  setting (off by default) submits every saved link to the Internet Archive after
  enrichment — anonymously, through the queue's polite rate limiter, with SPN job
  polling, a freshness check, one session-limit retry, and an availability/CDX
  fallback to the latest existing snapshot. The snapshot URL is stored in the
  note's `wayback:` frontmatter; failures warn in the console only and are
  retried on later enrichment triggers.
- "Wayback ignored domains" setting: links on these domains (subdomains included)
  are never sent to the Wayback Machine — on the auto path, the manual card-menu
  action, and the bulk action alike.
- Card context menu gains "Open archived version" (the stored snapshot, or the
  latest-snapshot lookup when none is stored; mark-read-on-open applies) and
  "Save to Wayback Machine" (only shown while no snapshot is stored).
- Bulk bar gains a "Wayback" button that archives the selection sequentially,
  skipping already-captured or ignored bookmarks, with a summary notice.

## [1.4.0] - 2026-09-03

### Added
- Grid sort control: a toolbar dropdown (Newest first, Oldest first, Title, Domain)
  orders the grid after filtering and search, persisted as the new Grid sort setting
  and applied uniformly to every filter, smart views included.
- Mark as read on open setting: opening a bookmark's external link or readable copy
  silently marks it as read (opening the note never does).
- Copy link in the card context menu: copies the bookmark URL to the clipboard with
  a confirmation notice.
- Fuzzy search in the grid toolbar: Obsidian's fuzzy matcher now gates inclusion
  across title, URL, tags, description, and collection.

## [1.3.0] - 2026-09-03

### Changed
- Release assets (main.js, manifest.json, styles.css) now carry SLSA build-provenance
  attestations — verify a download was built from this repository with
  `gh attestation verify main.js --repo Real-Fruit-Snacks/obsidian-linkhaven`.

## [1.2.1] - 2026-09-03

### Added
- Refetch page per bookmark: card context menu → Refetch page re-pulls metadata and
  re-downloads a missing or stale cover (old assets are cleaned up, not orphaned).
- Bulk refetch: the bulk bar's Refetch button re-fetches every selected bookmark,
  sequentially and rate-limited.

## [1.2.0] - 2026-09-03

### Added
- Multi-select in the grid: Ctrl/Cmd-click toggles cards, Shift-click selects a range,
  and a selection-mode toolbar toggle gives mobile tap-to-toggle (long-press menus are
  suspended while it is on). The selection clears on filter or search changes.
- Bulk action bar with a selection count, Select all / Clear, Move to…, Add tag…
  (canonical casing), Mark read / Mark unread, and a confirmed cascade Delete.
- Bulk drag-and-drop: dragging a selected card drags the whole selection — drop it on
  a collection, Inbox, or a tag in the tree to move or tag all of them at once.

## [1.1.0] - 2026-09-03

### Added
- Per-collection icons: pick any Lucide icon from a searchable picker (tree context
  menu → Change icon). Icons show on tree rows and the grid breadcrumb, follow
  collection renames, and are removed with the collection.

## [1.0.0] - 2026-09-02

First stable release — everything below, battle-tested.

## [0.2.7] - 2026-09-02

### Added
- Tag autocomplete in the Edit tags dialog: suggests existing tags with usage counts
  as you type and normalizes to canonical casing, so duplicates can't form.
- Drag a card onto a tag row in the tree to add that tag.

## [0.2.6] - 2026-09-02

### Added
- Edit tags per bookmark from the card's tag button or context menu — no more opening
  the note to add a tag.

## [0.2.5] - 2026-09-02

### Added
- Empty-state CTA: "Add your first bookmark" button with saving hints on a fresh install.
- Card context menu (right-click / long-press) with all card actions.
- Settings row with a copyable mobile save link (obsidian:// URI pre-filled with your
  vault name).
- "Retry failed enrichments" command.
- CI workflow: lint + build on every push and PR.

### Fixed
- Duplicate detection now normalizes URLs (http/https, www, casing, trailing slash).

## [0.2.4] - 2026-09-02

### Fixed
- Cold-start race: the bookmark grid no longer shows empty after an app reload. The
  store now scans after layout is ready and re-scans when the metadata cache finishes
  initial indexing.

## [0.2.3] - 2026-09-02

### Added
- Notes auto-rename to the page title after metadata fetch (only when the name was
  auto-derived; setting to disable).
- Favicons are shared per domain instead of duplicated per bookmark; cascade delete
  keeps a shared favicon until its last bookmark is removed.

## [0.2.2] - 2026-09-02

### Added
- Cascade delete: deleting a bookmark also removes its cover, favicon, and archive
  copy (only files inside plugin-managed folders).
- Saving a duplicate URL now offers Refetch page / Open bookmark / Cancel. Refetch
  updates metadata, re-downloads assets without orphaning old ones, and rewrites the
  archive copy.

## [0.2.1] - 2026-09-02

### Added
- Grid toolbar: Add bookmark and Open collection tree buttons.
- Command to manually capture a readable copy for the active bookmark.
- Dev harness (npm run test:readable) for testing extraction against real URLs.

### Fixed
- Readable capture: base-URL injection for working links/images in archives, relaxed
  thresholds with a semantic-container fallback (GitHub and other app-shell pages now
  capture correctly), and failures now enter the retry queue instead of vanishing.

## [0.2.0] - 2026-09-02

### Added
- Collection management: create, rename, and delete collections from tree context
  menus (desktop right-click, mobile long-press). Deletes never delete notes.
- Tag management: rename or remove tags across all bookmarks.
- Drag-and-drop filing: drag cards onto collections or the Inbox.
- Official eslint-plugin-obsidianmd wired in; zero-problem clean.
- Declarative settings definitions (Obsidian 1.13+) alongside the classic tab.

### Fixed
- View row clicks (broken attribute mismatch), duplicate grid tabs, and a
  footer-listener leak.

## [0.1.0] - 2026-09-01

### Added
- Initial release: collection tree + cover-card grid over one Markdown note per
  bookmark, smart views (Inbox, Pinned, Unread, Recent), automatic metadata capture
  (title, cover, favicon, optional readable copy), zero-prompt saving via Web Clipper /
  share sheet / obsidian:// URI, and Linkwarden JSON import. Identical on desktop and
  mobile.
