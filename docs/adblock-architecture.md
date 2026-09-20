# Ad blocking in Static: architecture, and what Electron will not let us do

This document describes how Static blocks ads today, what a Brave-style native
engine would add, and — most importantly — which parts of Brave's approach are
**not reachable from Electron at all**. That last part is the reason this
document exists: a plan that assumes Electron can do what Chromium's network
stack does will fail late and expensively.

Everything stated here about current behaviour is measured from the running
browser, not estimated. Figures were taken on 2026-09-20.

---

## 1. What exists today

Static's blocking runs in four layers. They are independent: any one can fail
without taking the others down.

| Layer | Where it runs | What it stops | Implementation |
|---|---|---|---|
| Network filtering | `session.webRequest.onBeforeRequest` in main | Requests to ad and tracker hosts | `src/features/shields/filters.js` |
| Cosmetic filtering | Injected CSS per document | Leftover ad *slots* — the empty boxes | `filters.js` (`cosmeticFor`) |
| Scriptlets | Page main world, document-start | Anti-adblock scripts, in-page ad code | `src/features/shields/scriptlets.js` |
| YouTube player | Page main world, document-start | Pre-roll and mid-roll video ads | `src/features/shields/youtube.js` |

Measured on a current profile:

- **113,982** network rules loaded
- **23,820** cosmetic rules loaded
- Rules are parsed from Adblock Plus syntax: `||domain^`, `$options`,
  `##selector`

### 1.1 Why the YouTube layer is shaped the way it is

This is the part most likely to be redesigned by someone who has not read the
history, so the failures are recorded in `youtube.js` and repeated here.

Three approaches were tried and abandoned:

1. **Rewriting the HTML response.** Worked, but routed every HTTPS request in
   the browser through `net.fetch`. Anything `net.fetch` did not reproduce
   byte-for-byte — range requests, streaming, auth — broke. YouTube reported
   "no internet". Removed.

2. **Polling `window.ytInitialPlayerResponse`.** It is a top-level `var`, so a
   plain property setter never fires, and a 50 ms poll cannot reliably beat the
   parser. Ads still played.

3. **Hooking `XMLHttpRequest` only.** YouTube fetches `/youtubei/v1/player`
   with `fetch()`, not XHR. Every video after the first was served its ads
   untouched. This was the single largest cause of "ads are still coming".

**What works** is uBlock Origin's technique. A `var` declaration does *not*
redefine an existing own property on `window` — it assigns through the existing
setter. So an accessor is installed on `window.ytInitialPlayerResponse` **first**,
at document-start, in the page's main world. When YouTube's `var` assigns the
player response, our setter receives the object, deletes the ad keys, and
returns. The player reads an object that never contained ads. No polling, no
race.

Later navigations fetch a fresh player response, so `fetch` and
`XMLHttpRequest` are both wrapped and the same keys pruned from the JSON body.

Two constraints that are not obvious and cost real time when violated:

- The interception must be scoped to `/youtubei/v1/player` **only**.
  Intercepting `get_watch` breaks playback: the video reaches `readyState 4`,
  unpaused, and sits at `currentTime 0` forever.
- Only one `window.fetch` wrapper may exist. Two wrappers fought here; the
  later one used reassignment rather than in-place patching and silently won,
  unhooking the blocker.

---

## 2. What Brave does that we do not

Brave's advantage is not better filter lists — it is the same lists, applied by
a faster engine in a place we cannot reach.

| Brave capability | Status in Static |
|---|---|
| Rust matching engine (`adblock-rust`) | **Reachable.** See §4. |
| FlatBuffers-serialised rule sets | **Reachable.** |
| CNAME uncloaking | **Partly reachable.** See §3.2. |
| Signed list updates | **Reachable.** |
| Blocking *before* the request leaves the network stack | **Not reachable.** See §3.1. |
| Rewriting response bodies (`$replace=`) | **Not reachable.** See §3.1. |

---

## 3. The hard limits

### 3.1 Electron cannot rewrite response bytes

This is the important one.

Brave blocks and rewrites inside Chromium's network stack, where it sees
request and response bodies as they stream. Electron exposes `webRequest`,
which can **cancel** or **redirect** a request, and can read and modify
*headers* — but it cannot modify a response **body**.

Concretely, this means:

- `$replace=` filter rules cannot be implemented. Any list entry using them is
  parsed and then does nothing.
- Server-side ad injection, where the ad arrives in the same response as the
  content, cannot be stripped at the network layer.

The only two workarounds both have disqualifying costs:

1. **Proxy every request through `net.fetch` and rewrite the body.** Tried.
   Broke streaming, ranges and auth. This is failure (1) in §1.1.
2. **Attach the debugger and use the `Fetch` domain.** Tried and removed:
   `/youtubei/v1/player` never appears in intercepted requests — only
   `log_event`, `updated_metadata`, `stats` and `timedtext` do. It also
   conflicts with DevTools and extension debuggers, which must not be
   disturbed.

**Therefore:** anything requiring body rewriting must be done in the page,
through scriptlets, as YouTube blocking already is. This is a permanent
architectural constraint, not a gap to be closed later.

### 3.2 CNAME uncloaking is only partly reachable

Trackers hide behind a subdomain of the site you are visiting, which resolves
by CNAME to the tracker. Brave resolves the CNAME and matches against the real
target.

Electron has no DNS resolution hook in the request path. `dns.resolveCname`
exists in Node, but `onBeforeRequest` is **synchronous with respect to the
decision** — an async DNS lookup cannot block it without stalling the request.

A workable design, not yet built:

- Maintain an async cache of hostname → CNAME target.
- On a request whose host is not cached, **allow it** and resolve in the
  background.
- On subsequent requests to that host, match against the resolved target.

This leaks the first request to each cloaked host. That is worth stating
plainly rather than describing the feature as "CNAME uncloaking" and implying
Brave-equivalence.

---

## 4. Proposed native engine

Worth doing for matching **speed**, not for capability. It changes nothing in
§3.

### 4.1 Shape

```
  filter lists (text)
        │
        ▼
  ┌──────────────────┐   build step, offline
  │ parser + builder │ ──────────────────────▶ rules.fb (FlatBuffers)
  └──────────────────┘
        │
        ▼
  ┌──────────────────┐
  │  Rust engine     │  matches URL + document host + resource type
  │  (adblock-rust)  │
  └──────────────────┘
        │ N-API
        ▼
  ┌──────────────────┐
  │ shields/index.js │  onBeforeRequest → { cancel: true }
  └──────────────────┘
```

### 4.2 Why FlatBuffers

Rule sets are read on every launch and never mutated at runtime. FlatBuffers is
zero-copy: the file is mapped and read in place, so startup cost is a `mmap`
rather than parsing ~114,000 rules. This matters because rule parsing currently
happens on the main process at startup.

### 4.3 Binding choice

**N-API via `napi-rs`**, not raw C++ FFI. N-API is ABI-stable across Node and
Electron versions, so an Electron upgrade does not require a rebuild against
new V8 headers. A raw C++ addon would need rebuilding on every Electron bump —
a recurring cost with no offsetting benefit.

Matching must stay **synchronous**. `onBeforeRequest`'s callback decides
whether the request proceeds; an async hop adds latency to every request in the
browser. Rust matching is sub-microsecond, so a synchronous N-API call is the
right shape.

### 4.4 Signed updates

Filter lists are executable policy: an attacker who can replace a list can
unblock their own trackers, or block a competitor's site.

- Sign each list with Ed25519 at build time.
- Ship the public key **in the binary**, not alongside the lists.
- Verify before parsing. A failed signature keeps the previous list and
  reports the failure — it must never fall back to "no filtering", which would
  turn a tampered update into silently disabled protection.

### 4.5 What this does *not* buy

State this to whoever asks for it:

- No new ads blocked on YouTube. That is a page-world problem (§3.1).
- No `$replace=` support.
- No blocking of server-inserted ads.

It buys faster matching and faster startup. If the goal is "block more ads",
the work is in scriptlets and cosmetic rules, not here.

---

## 5. Recommended order of work

1. **Cosmetic and scriptlet coverage.** Highest ratio of ads-blocked to effort,
   and it is where the remaining YouTube and site-specific gaps actually live.
2. **CNAME uncloaking** with the cache design in §3.2, and honest wording about
   the first-request leak.
3. **Signed list updates.** Security-relevant, independent of the engine, and
   small.
4. **Rust engine.** Only once 1–3 are done, and only if profiling shows
   matching is a measurable cost. It is currently not.

---

## 6. Summary for a decision-maker

- Static blocks ads through four independent layers and currently loads
  113,982 network and 23,820 cosmetic rules.
- YouTube video ads are handled in the page's main world, using uBlock's
  property-accessor technique. This is the only approach that works; three
  others were tried and failed.
- **Electron cannot rewrite response bodies.** Any plan depending on
  `$replace=` or stripping server-inserted ads at the network layer is not
  achievable, and no amount of native code changes that.
- A Rust engine is a performance improvement, not a capability one. It should
  be scheduled after cosmetic coverage, CNAME uncloaking and signed updates.
