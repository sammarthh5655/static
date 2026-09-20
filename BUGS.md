# Bug log

Bugs found while building the next-stage features. **Not fixed at the time of
discovery** — deliberately. Stopping to fix each one is what made the previous
stretch slow, so they are recorded here and fixed in a dedicated pass after
the features are complete and verified twice.

Each entry records what is wrong and how it was noticed, so the fix pass does
not have to re-derive any of it.

Status: `OPEN` · `FIXED` · `NOT-A-BUG`

---

## Open

### 1. `npm start` does not rebuild preload bundles — new IPC channels silently fail
**Status:** OPEN
**Found:** while wiring `ai:summarise-page`.

Adding a channel to `src/shared/channels.js` and a handler in
`application.js` is not enough: the tab preload is an esbuild bundle in
`build/`, and until `node scripts/build.cjs` runs it carries the OLD channel
allowlist. Every new channel then fails with "Unknown browser operation",
which reads like a handler bug and is not one. Cost ~15 minutes here.

**Fix direction:** make the start script rebuild when a source file is newer
than its bundle, or fail loudly when `channels.js` is newer than
`build/tab.preload.cjs`.

### 2. Page extraction includes navigation chrome
**Status:** OPEN
**Found:** extracting the Wikipedia article.

The extractor strips `nav`/`footer`/`aside`, but the Wikipedia article body
still yielded a language list and sidebar text before the real content:
`"Electron (software framework)
			

...18 languages..."`. The
summary was still correct, so this is quality rather than correctness - it
wastes context and could mislead on a page with heavier chrome.

**Fix direction:** also drop `[role=navigation]`, `.sidebar`, `#toc`,
`.mw-jump-link`, and collapse runs of tabs/newlines before measuring length.

---

## Fixed

_(moved here during the fix pass, with the commit that fixed them)_

---

## Not a bug

_(things that looked wrong and turned out to be correct, kept so they are not
re-investigated later)_
