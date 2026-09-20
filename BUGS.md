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

_None outstanding._

---

## Fixed

_(moved here during the fix pass, with the commit that fixed them)_

### 4. Health reported "excellent" for a browser with no shields at all
**Status:** FIXED
**Found:** verification pass 2, constructing `Health` with no dependencies.

`config.enabled !== false` is true for an ABSENT shields module, so the report
said "Shields on", showed 0 filter rules, and gave an overall status of
"excellent". The same held for the password vault: `checked: true` with no
vault present. This is exactly the failure the module's own docstring warns
against - a status that cannot be traced to a measurement.

Now an absent module reports `null` (not checked) and raises an `attention`
finding naming what could not be confirmed. The page prints "Not checked"
rather than "Off", because "Off" claims a measurement that was never made.

### 5. Sense and the organizer threw on live tab state that was mid-change
**Status:** FIXED
**Found:** verification pass 2, passing malformed entries.

`Sense.suggest`, `analyze`, `aiMetadata` and `signature` all dereferenced
`tab.url` without checking the tab existed. A tab closing during analysis
leaves a null or half-populated entry in the array, which threw. Both now
filter before dereferencing, via a shared `webTabs()` helper, and real tabs
mixed with junk are still classified correctly.

### 6. A partly-applied profile reported itself as unchosen
**Status:** FIXED
**Found:** verification pass 2, making `shields.update` throw.

`chooseProfile` applied settings, then shields, then recorded the choice. If
the shields step threw, the settings had already landed and were visible, but
the recorded profile stayed empty - the UI would show a changed theme next to
"no profile chosen". The shields step is now caught separately, the choice is
recorded, and the returned state carries a `warning` naming the part that
failed. The welcome page surfaces it.



### 2. Page extraction includes navigation chrome
**Status:** FIXED
Wikipedia's language list and table of contents are plain divs inside the
article, so the tag-name selectors never touched them. Now also drops
`[role=navigation]`, `[role=banner]`, `[aria-hidden=true]`, `#toc`,
`.mw-jump-link` and the other common chrome classes, and collapses runs of
tabs and blank lines before the character budget is measured.

Verified against the real page: the "18 languages" list is gone, the article
title leads, and 14,866 characters of actual content are extracted.
Covered by `npm run test:extract`.

### 3. `Organizer.apply()` threw synchronously but every other action rejects
**Status:** FIXED
The selection check now returns a rejected promise, so `apply(x).catch(...)`
behaves like every other organizer method. Test updated to assert rejection.



---

## Not a bug

_(things that looked wrong and turned out to be correct, kept so they are not
re-investigated later)_

### `npm start` does not rebuild preload bundles
**Status:** NOT-A-BUG
**Filed:** while wiring `ai:summarise-page`. **Retested:** during verification.

The claim was that adding a channel needs a manual `node scripts/build.cjs`.
It does not: `package.json` has a `prestart` hook that runs `npm run build`,
so `npm start` always rebuilds first. Verified by touching
`src/shared/channels.js` and confirming `build/tab.preload.cjs` changed
mtime.

What actually happened at the time was almost certainly launching Electron
directly rather than through `npm start`, which skips the hook. Keeping the
note so the 15 minutes is not spent again.

Checked as part of verification: every channel in `channels.js` has a handler,
every handler is in `channels.js`, and both preload bundles carry the
onboarding channels.


