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

<!-- TODO: add a screenshot of the tree + grid here -->

## Features

- **Collection tree** with nested collections (`Dev/Tools`), live filter, and smart
  views: All, Inbox, Pinned, Unread, Recent.
- **Cover-card grid** with `og:image` covers, favicon and letter-tile fallbacks,
  grid/list toggle, "+ add / tree" toolbar buttons, live search, and per-card
  actions (open, read/unread, pin, move to collection, trash).
- **Automatic enrichment** — saves are zero-prompt; title, description, cover and
  favicon are fetched in the background at a polite rate, with retry on failure.
- **Optional readable-text archive** per bookmark (Readability + Turndown, pure JS).
- **Manage collections and tags** (rename, delete, merge-safe moves) from the tree.
- **Drag cards onto collections** to file them (desktop).
- **Linkwarden import** — collections, tags, dates and pinned links map across; existing
  URLs are skipped.
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
frontmatter).

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
favicon: Bookmarks/covers/example-favicon.png
readable: Bookmarks/archives/example.md
description: Optional summary
```

## Network use disclosure

When a bookmark is enriched, the plugin fetches the saved page itself (to read its title,
description, and Open Graph metadata) and the page's `og:image` and favicon **from their
origins only**. All requests go through Obsidian's `requestUrl` API. There are no
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
