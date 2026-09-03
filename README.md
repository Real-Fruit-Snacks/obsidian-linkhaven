# Linkhaven

**A calm home for your web bookmarks — inside Obsidian.**

![GitHub release](https://img.shields.io/github/v/release/Real-Fruit-Snacks/obsidian-linkhaven)
![License: MIT](https://img.shields.io/badge/license-MIT-blue)
![Minimum Obsidian version](https://img.shields.io/badge/obsidian-%3E%3D1.7.2-7c6aa8)

Every bookmark is one plain Markdown note with YAML frontmatter. Linkhaven adds a
**collection tree** (left dock) and a **cover-card grid** (main area) on top of those
notes, with automatic metadata capture — title, description, cover image, favicon, and an
optional readable-text copy. It works **identically on desktop and mobile**: no Electron
or Node APIs, so nothing is "desktop only".

> 📖 **Docs & demo:** https://Real-Fruit-Snacks.github.io/obsidian-linkhaven/

![Linkhaven — a calm home for your web bookmarks](assets/cover.png)

## Features

- **Collection tree** with nested collections (`Dev/Tools`), live filter, and smart
  views: All, Inbox, Pinned, Unread, Recent, Archived.
- **Cover-card grid** with `og:image` covers, favicon and letter-tile fallbacks,
  grid/list toggle, "+ add / tree" toolbar buttons, a **sort dropdown** (newest,
  oldest, title, or domain — applied after filtering and search), live **fuzzy
  search** across title, URL, tags, description, and collection, per-card
  actions (open, read/unread, pin, move to collection, trash), and a right-click
  or long-press **context menu** on every card with **Copy link** one tap away.
  With zero bookmarks, the grid shows an **"Add your first bookmark"** button to
  get you started.
- **Automatic enrichment** — saves are zero-prompt; title, description, cover and
  favicon are fetched in the background at a polite rate, with retry on failure
  (the `Retry failed enrichments` command re-queues them manually).
  Notes saved with a domain file name are **renamed to the page title** once it
  is known, and favicons are **shared per domain** instead of duplicated per
  bookmark.
- **Optional readable-text archive** per bookmark (Readability + Turndown, pure JS).
- **Manage collections and tags** (rename, delete, merge-safe moves) from the tree.
- **Collection icons** — pick a Lucide icon per collection from the tree's context menu.
- **Drag cards onto collections** to file them, or onto a tag to add it (desktop).
- **Bulk select + actions** — Ctrl/Cmd-click and Shift-click (or the selection-mode
  toggle on mobile) select multiple cards; a bulk bar offers Move to…, Add tag…,
  Mark read/unread and Delete, and dragging a selected card drops the whole
  selection onto a collection, Inbox, or tag.
- **Linkwarden import** — collections, tags, dates and pinned links map across; existing
  URLs are skipped.
- **Cascade delete** — deleting a bookmark also removes its cover, favicon, and archive
  copy (only files inside the plugin's covers/archive folders are touched).
- **Refetch page** — a card's context menu (or the bulk bar) can refetch page metadata
  and re-download a missing or stale cover.
- **Wayback Machine integration** — optionally auto-archive every saved link to the
  Internet Archive (anonymous Save Page Now; off by default). The card context menu
  offers **Open archived version** and **Save to Wayback Machine**, and the bulk bar
  can archive a whole selection. Snapshots are stored in the note's `wayback:`
  frontmatter; an ignored-domains list keeps private URLs out of the archive.
  Captures are anonymous — authenticated captures may come later if rate limits bite.
  Archived bookmarks show an archive badge on their card and collect under the
  **Archived** smart view.
- **Local-first** — plain Markdown files, no account, no telemetry.

## Install

### Community plugins (once accepted)

Settings → Community plugins → Browse → search **Linkhaven**.

### BRAT (beta)

1. Install the [BRAT](https://github.com/TfTHacker/obsidian42-brat) plugin.
2. Add beta plugin → `Real-Fruit-Snacks/obsidian-linkhaven`.

### Manual

1. Download `main.js`, `manifest.json`, and `styles.css` from the latest
   [release](https://github.com/Real-Fruit-Snacks/obsidian-linkhaven/releases).
2. Copy them into `<your-vault>/.obsidian/plugins/linkhaven/`.
3. Reload Obsidian, then enable **Linkhaven** under Settings → Community plugins.

## Usage

### Saving bookmarks

Saving is zero-prompt: any note with a `url` frontmatter key that appears in the
bookmarks folder is picked up and enriched automatically.

- **Command**: `Add bookmark from URL` — paste a URL (clipboard prefill when available),
  optionally set title, collection, and tags.
- **Ribbon / commands**: `Open bookmark grid`, `Open collection tree`.
- **obsidian:// URI** (works from other apps, e.g. iOS Shortcuts):

  ```
  obsidian://bookmark-add?vault=YourVault&url=https%3A%2F%2Fexample.com&collection=Dev%2FTools&tags=js,tools
  ```

  iOS Shortcut example: a "URL" action with
  `obsidian://bookmark-add?vault=YourVault&url=[Shortcut Input]` followed by "Open URLs".
  The **Mobile save link** row in settings copies a ready-made version of this
  link for your vault — replace the placeholder with your shortcut's input.
  Note: Obsidian shows a confirmation dialog for URI actions until you allowlist the
  `bookmark-add` action for this plugin.

- **Web Clipper**: point the official Obsidian Web Clipper at your bookmarks folder;
  Linkhaven watches the folder and enriches new notes. Template JSON snippet:

  ```json
  {
    "name": "Bookmark",
    "path": "Bookmarks",
    "properties": [
      { "name": "url", "value": "{{url}}" },
      { "name": "title", "value": "{{title}}" },
      { "name": "status", "value": "unread" },
      { "name": "pinned", "value": false },
      { "name": "created", "value": "{{date}}" }
    ]
  }
  ```

### Filing vs. saving

Filing is separate from saving. Notes without a `collection` key land in the **Inbox**
smart view; move them later with the card's **Move to collection** button (or by editing
frontmatter). Tags are editable per bookmark via the card's context menu (**Edit tags…**)
or its tag button — the field autocompletes from existing tags and normalizes them to the
established (canonical) casing, and you can drag a card onto a tag row in the tree to add
it. Global rename/remove stays in the tree.

Re-saving an already-saved URL (add modal or `obsidian://bookmark-add`) opens a dialog
that offers to **refetch the page** (overwrite title/description and re-download cover,
favicon, and readable copy) or open the existing bookmark. URLs are compared in
normalized form, so `http` vs `https`, a leading `www.`, host casing, and a trailing
slash all count as the same bookmark.

### Sane names and shared favicons

Notes saved before anything is known about the page get a domain file name
(`github.com.md`, `github.com-2.md`, …). After enrichment fetches the real page title,
Linkhaven renames the note to that title — along with its cover and readable copy, so
names stay in correspondence. Only auto-named notes are renamed: notes that already have
a real title (e.g. from the Web Clipper) are never touched. Turn this off with the
**Rename notes to page title** setting.

Favicons are cached once per domain under `Bookmarks/covers/favicons/` and reused by
every bookmark of that domain (covers stay per-bookmark, since `og:image` differs per
page). When a bookmark is deleted, a favicon still used by other bookmarks is kept.

### Deleting bookmarks

Trashing a bookmark from the grid card also moves its cached cover, favicon, and archive
copy to the trash — but only when those files live inside the plugin's covers/archive
folders. Deleting the note yourself in the file explorer does **not** cascade: the
artifacts stay behind.

### Linkwarden import

1. In Linkwarden, export your data as JSON and copy the file into your vault.
2. Run the command `Import bookmarks from Linkwarden export`.
3. Pick the export file (root-level JSON files are listed; you can also browse the whole
   vault or type a path).
4. Collections are recreated as `Parent/Child` paths, pinned links stay pinned, and all
   new notes are queued for enrichment. Existing URLs are skipped.

## Settings

| Setting | Default | Purpose |
| --- | --- | --- |
| Bookmarks folder | `Bookmarks` | One note per bookmark |
| Covers folder | `Bookmarks/covers` | Cached covers and favicons |
| Archive folder | `Bookmarks/archives` | Readable copies |
| Capture readable copy | off | Save a readable Markdown copy during enrichment |
| Show save chooser | off | Collection/tag pickers in the add modal |
| Rename notes to page title | on | Rename domain-named notes to the fetched page title after enrichment |
| Grid sort | Newest first | Order of bookmarks in the grid: newest, oldest, title, or domain |
| Mark as read on open | off | Silently mark a bookmark as read when its link or readable copy is opened |
| Archive saved links to the Wayback Machine | off | Submit each saved link to the Wayback Machine after enrichment; captures are public |
| Wayback ignored domains | — | Domains (subdomains included) that are never archived; one per line or comma-separated |
| Mobile save link | — | Copy an `obsidian://` save link for share-sheet shortcuts on your phone |

Tree collapse state and the last grid filter are persisted automatically.

## Data schema

```yaml
url: https://example.com        # required; dedupe key
title: Example
collection: Dev/Tools           # absent/empty = Inbox
tags: [js, tools]
status: unread                  # unread|read
pinned: false
created: 2026-01-01
cover: Bookmarks/covers/example-cover.png
favicon: Bookmarks/covers/favicons/example.com.png   # shared per domain
readable: Bookmarks/archives/example.md
description: Optional summary
wayback: https://web.archive.org/web/20260101000000/https://example.com   # Wayback snapshot (optional)
```

## Network use disclosure

When a bookmark is enriched, the plugin fetches the saved page itself (to read its title,
description, and Open Graph metadata) and the page's `og:image` and favicon **from their
origins only**. All requests go through Obsidian's `requestUrl` API.

**Wayback Machine:** with the "Archive saved links" setting enabled — or when you use the
manual or bulk Wayback actions — the saved URLs are sent to the Internet Archive
(`web.archive.org` / `archive.org`) so a snapshot can be taken, and those captures are
**public**. Domains on the "Wayback ignored domains" list are never sent. No account or
API keys are used; captures are anonymous. Apart from the Wayback Machine, there are no
third-party services, proxies, or CDNs involved.

## Privacy

No telemetry, no analytics, no external accounts. All data lives in your vault as plain
Markdown files and image attachments.

## Development

```bash
npm install
npm run dev    # esbuild watch mode
npm run build  # tsc typecheck + production bundle
```

Recommended: the [hot-reload](https://github.com/pjeby/hot-reload) plugin during
development.

## Releasing

Tags trigger the GitHub Actions release workflow, which builds and attaches `main.js`,
`manifest.json`, and `styles.css` to a new release:

```bash
npm version patch   # bumps manifest.json + versions.json via version-bump.mjs
git push && git push --tags
```

## Roadmap

- Community-store submission
- Optional desktop-only capture module (screenshots / PDF) as a separate companion
- Palette-style quick launcher as an alternate view over the same notes

## License

MIT · Not affiliated with Obsidian or Linkwarden.
