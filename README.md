# MarkSync — Web Extension

MarkSync is a ground-up rewrite of a bookmark-sync browser extension targeting
**Manifest V3**, built with [WXT](https://wxt.dev) + TypeScript and **no UI framework**.
It is a fork/successor of the xBrowserSync web client.

This client is compatible **only with the existing xBrowserSync backend API**; there is
no compatibility constraint with the legacy (AngularJS) client code.

## Status

Alpha. An end-to-end vertical slice works: set up a sync (new or existing), and
bookmarks are encrypted and synchronised with an xBrowserSync service.

| Area                          | State                                    |
| ----------------------------- | ---------------------------------------- |
| OpenAPI contract (`openapi/`) | done                                     |
| Core: crypto                  | done (tested, format-compatible)         |
| Core: API client              | done (tested)                            |
| Core: storage                 | done (tested)                            |
| Core: bookmark model          | done (tested)                            |
| Core: sync engine             | done (tested) — full-tree + 3-way merge  |
| Service worker (MV3)          | done — needs real-browser validation     |
| UI (popup)                    | done (page editor/setup/status/QR/usage) |

### How sync works (and current limits)

Synchronisation is **full-tree**: the entire bookmark tree is encrypted and
uploaded, or downloaded and applied, on each sync. Change detection uses the
service's `lastUpdated` timestamp, plus a locally cached copy of the last-synced
tree to detect un-pushed local edits ("dirty" state). Background sync and "Update
Sync" reconcile automatically: push when only local changed, pull when only remote
changed, and **three-way merge when both changed** so neither side's edits are lost
(`src/core/sync/merge.ts`). The merge is structural and content-keyed (folders by
title, bookmarks by URL, separators by position) rather than per-operation change
tracking; on a genuine attribute conflict, remote wins, so every device converges
deterministically. Per-operation change tracking (as in the legacy client) is still
future work. A device can also be restricted to half of that — see
[One-way sync](#one-way-sync).

The browser↔xBrowserSync bookmark mapping (`src/background/webext-bookmark-provider.ts`)
is the one piece that still needs validation against real Chrome/Firefox profiles.

#### Descriptions and tags

The xBrowserSync bookmark model carries a `description` and `tags`, and no browser has
anywhere to put either — a native bookmark node holds a title and a URL. Since the local
tree is rebuilt from the native one on every read, that metadata is not merely invisible,
it is lost on the round trip: the next dirty check reads the loss as a local edit and
pushes a stripped tree, erasing every description and tag in the sync for every device.

So they are kept in a **sidecar** in `chrome.storage` alongside the browser's bookmarks:
written whenever a tree is applied to the browser, laid back over the native tree
whenever it is read. Everything above the provider — dirty detection, the merge, the
upload — therefore sees whole bookmarks, and the wire format is unchanged, so
descriptions and tags written by xBrowserSync clients survive a round trip through
MarkSync and vice versa.

Entries are keyed by the same content-based identity the merge uses, shared in the core's
`bookmarks/identity.ts` so the two cannot drift. A write replaces the entries of every
container it touches, which is what lets a description deleted on another device actually
disappear; when a bookmark's path no longer matches (a renamed folder, a bookmark dragged
elsewhere) an unambiguous URL is used instead. The sidecar survives disabling sync,
because the bookmarks it describes do.

The popup's **This page** editor is where they are set: it shows the active tab's
bookmark, its description and its comma-separated tags, and offers to bookmark the page
when it is not bookmarked yet. Empty fields are filled in from what the page says about
itself — `og:description`, then `twitter:description`, then `<meta name="description">`,
with tags from `<meta name="keywords">` and `og:video:tag` — matching xBrowserSync's
precedence so both clients suggest the same thing for the same page. A suggestion is only
ever placed in an empty field and is not stored until saved, so nothing the sync carries
is overwritten by a page's claims about itself.

Reading the tab's URL and title uses the `activeTab` permission — granted only for the tab
the popup was opened over, and only while it is open — and `scripting` reads that same
tab's meta tags. Neither carries an install-time warning, and the reach stays one tab, on
demand: the extension never asks for access to browsing history. This is deliberately
narrower than xBrowserSync, which asks for optional access to every http(s) site so it can
also scrape from the background when a bookmark is starred; the cost is that MarkSync can
only suggest metadata while the popup is open over the page. Tags are
de-duplicated and sorted before they are stored: dirty detection and the merge compare
the tag array by value, so without a canonical order re-entering the same tags in a
different order would read as an edit.

### One-way sync

By default every device both sends and receives. **Sync direction** (options page) narrows
that per device, for when one browser should feed another without anything coming back —
so a second browser's bookmark storage can never push its quirks into the sync:

| Direction        | This device                                                         |
| ---------------- | ------------------------------------------------------------------- |
| **Two-way**      | Sends and receives; both sides' edits are merged (the default).     |
| **Send only**    | Uploads its bookmarks; never applies the service's.                 |
| **Receive only** | Mirrors the service; never uploads, and undoes its own local edits. |

A one-way sync is the pair: set the source browser to **send only** and every other
browser to **receive only**. The direction is asked for **at setup**, in the popup, as well
as being changeable later — otherwise the first exchange would run two-way before the user
could correct it, and that is the one exchange the setting cannot undo afterwards. The
setup hint spells out which side survives it, because that depends on the direction _and_
on whether a sync is being created or joined:

- **Creating** a sync always seeds it from this browser, whatever the direction. On a
  receive-only device that seed is the last thing it ever sends.
- **Joining** one as send only uploads this browser's bookmarks over what the sync holds;
  joining it any other way replaces this browser's bookmarks with the sync's. (Joining
  still downloads and decrypts the existing payload first either way — that is what proves
  the password is right before anything is overwritten.)

The direction then holds everywhere, not just for the "Update Sync" button — background
sync, the automatic push on a bookmark edit, backup restore and the conflict-recovery
actions all respect it, and the recovery action that would go against it is greyed out. It
is a per-device setting stored locally, so each browser is configured on its own and the
service is not involved.

A send-only device wins outright: it uploads over whatever the service holds rather than
merging, since it is not allowed to resolve a conflict by pulling. A receive-only device
is the mirror image — a remote change is applied over local edits, and local edits made
while the service sat still are undone from the last-synced tree, so the copy cannot drift
silently. Both report what they did in the popup ("Remote changes ignored", "Local changes
undone") and in the debug log.

**Changing your mind later** is safe in both directions. A send-only device never records
a revision it declined to apply, so switching it back to two-way makes it pull what it
skipped — or three-way merge, if it has local edits of its own — instead of believing it
was already up to date. Switching a receive-only device to two-way needs no repair at all:
local edits it would have undone are simply pushed instead. The one thing to know is that
the change takes effect from the _next_ sync, so a receive-only device still undoes edits
made before you switch it.

### Settings, backup & logs (options page)

The popup is for the **page editor** (description and tags for the active tab), setup and
status — including a **QR code** of the sync ID (under "Show QR code") to transfer it to
another device by scanning, a **service status badge** (online / offline / not accepting
new syncs) with the operator's message, and a **data-usage bar** showing how much of the
service's `maxSyncSize` the sync occupies.
Its actions are "Update Sync" and "Disable Sync". A dedicated **options page** (opened
from the popup) holds everything else. State persists in `chrome.storage` across
enable/disable.

The operator message is untrusted HTML from whichever service the user configured, so
the popup parses it into an inert document and reduces it to a small allowlist of tags
(links only ever keep an absolute `http(s)` href) before it joins the DOM.

Settings:

- **Theme** — system / light / dark (palette from the legacy client).
- **Auto-sync** — background sync interval (off / 15 / 30 / 60 min); drives the alarm.
- **Sync bookmarks toolbar** — include the browser's toolbar/bar in the sync.
- **Sync changes automatically** — push local bookmark edits as they happen.
- **Sync direction** — two-way (default), send only, or receive only; also asked for at
  setup. See [One-way sync](#one-way-sync).

Backup & restore:

- **Export** the current bookmarks to an unencrypted backup file
  (`xbs_backup_<timestamp>.txt`, xBrowserSync-compatible; credentials are never written).
- **Restore** from a backup file (current or legacy shape); restoring replaces the
  current bookmarks and pushes them if sync is enabled (a receive-only device restores
  locally and uploads nothing). Scheduled auto-backup is not implemented (MV3 cannot
  reliably write files on a timer).

Debug log:

- Every operation is traced: popup and options actions, message handling, background
  syncs, debounced pushes, conflict recovery, alarms and bookmark writes — each with its
  duration and outcome, or the error name, message and stack when it fails. Entries are
  levelled (`debug`/`info`/`warn`/`error`), scoped (`sync`, `bookmarks`, `popup`,
  `options`) and carry structured context (`{"outcome":"pushed","durationMs":412}`).
- The log **rotates daily** (`src/logging/rotating-log-store.ts`): one bucket per calendar
  day in `chrome.storage`, the last **7 days** kept and up to **500 entries per day**;
  expired days are dropped on write, on an hourly alarm and at startup. It is viewable,
  **downloadable** (`xbs_log.txt`, with a header per day) and clearable from the options
  page. Everything is also mirrored to the console of its context, so the service-worker
  devtools show the same trace live.
- Passwords are never logged, and bookmark titles/URLs never leave the browser through the
  log — payloads are reduced to counts, with the origin only when a single bookmark fails
  to be created. The log is meant to be safe to attach to a bug report.

Web app:

- Both surfaces carry an **Open the MarkSync web app** button linking to
  [app.marksync.org](https://app.marksync.org) — at the foot of the popup, below the
  settings button so the view's own action (Enable sync / Update Sync) keeps the only accent
  button above it, and in the options page header, opposite the title. Each is an anchor
  styled as a primary button (`.button`) that opens in a new tab, so the popup closing on
  focus loss never interrupts what the user was doing.

Build stamp:

- Both the popup and the options page end with the build they are running —
  `v2.0.0 (a1b2c3d)`: the manifest version plus the short sha of the commit it was built
  from, suffixed `-dirty` when the working tree had uncommitted changes. Hovering shows
  the full sha, and the same short label opens every service-worker trace in the debug
  log, so a bug report identifies an exact build rather than a version number that only
  moves on release.
- The sha is injected at build time by `wxt.config.ts` (`git rev-parse HEAD`, falling back
  to `GITHUB_SHA`) and read through `src/build-info.ts`. Builds made where neither is
  available — from the sources zip, say — simply show `v2.0.0`.

### Contract testing against a real backend

Crypto + API client + data-format interoperability is verified against the reference
server. It is skipped in normal runs (no Docker required) and only runs when
`XBS_CONTRACT_URL` is set:

```sh
docker compose -f contract/docker-compose.yml up -d
XBS_CONTRACT_URL=http://localhost:8080 pnpm test:contract
docker compose -f contract/docker-compose.yml down -v
```

## Requirements

- Node `>=22` (see `.nvmrc`)
- pnpm `>=11` (the repo pins a version via `packageManager`; run `corepack enable` to use it)

Install dependencies with `pnpm install`.

## Scripts

| Script               | Purpose                                               |
| -------------------- | ----------------------------------------------------- |
| `pnpm gen:api`       | Generate typed API client types from the OpenAPI spec |
| `pnpm lint:api`      | Lint the OpenAPI spec with Spectral                   |
| `pnpm dev`           | Run the extension in dev mode (Chromium)              |
| `pnpm dev:firefox`   | Run the extension in dev mode (Firefox)               |
| `pnpm build`         | Production build (Chromium)                           |
| `pnpm build:firefox` | Production build (Firefox)                            |
| `pnpm zip`           | Package the extension for store upload                |
| `pnpm test`          | Run unit/integration tests (Vitest)                   |
| `pnpm test:contract` | Run contract tests against a real backend (see below) |
| `pnpm test:e2e`      | Run end-to-end tests (Playwright)                     |
| `pnpm lint`          | Lint TypeScript with ESLint                           |
| `pnpm typecheck`     | Type-check without emitting                           |

## Publishing

Uploads to the Chrome Web Store and to AMO are automated, through
[`wxt submit`](https://wxt.dev/guide/essentials/publishing) (a wrapper around
`publish-browser-extension`, which ships with WXT — nothing extra to install). Two
workflows drive it:

| Workflow      | Trigger              | Chrome                        | Firefox                      |
| ------------- | -------------------- | ----------------------------- | ---------------------------- |
| `nightly.yml` | 01:00 UTC (schedule) | `default`, submitted publicly | `listed`, submitted publicly |
| `release.yml` | pushing a `v*` tag   | `default`, submitted publicly | `listed`, submitted publicly |

Both workflows skip a store whose credentials are missing, so you can configure one store
first and add the other later.

**The nightly publishing straight to the public listings is a pre-1.0 arrangement.** There
is no stable release yet, so the nightly _is_ the published extension — early users get
what landed on `main` rather than nothing. The cost is real and worth naming: every build
is unreviewed code auto-updated onto every user, and each upload spends a review
submission on each store.

Once `release.yml` has shipped a first stable release, move the nightly back to the test
channels — `CHROME_PUBLISH_TARGET: trustedTesters` and `FIREFOX_CHANNEL: unlisted` in the
upload step of `nightly.yml`, two lines. The public listing then keeps serving the last
release while nightlies reach only Chrome's trusted testers and an unlisted (signed, never
listed) Firefox build. Nothing else has to change; `release.yml` is already wired for it.

### A red nightly is usually a Chrome review still open

The Chrome Web Store refuses a new package while the previous one is still in review — the
API answers `Publish condition not met`, with no detail — so on any day a review runs past
24 hours, the next nightly fails on its upload step. This is known and accepted for now:
uploads happen after the GitHub release is created and published, so a failed upload never
costs the artifacts, and the next nightly to run once the review clears carries the newer
commit anyway. AMO does not have this problem; versions there are independent.

If it turns into noise, the fix is to slow the Chrome uploads down (weekly, say) rather
than to ignore the error — an upload failing for an unrelated reason looks exactly the
same.

### Versions

Both stores reject a version they have already accepted, and `package.json` only moves on
release, so CI stamps every uploadable build with its own version. A nightly is the
package's **major.minor** with the workflow run number in the third slot — with
`package.json` at `2.0.0`, nightlies are `2.0.412`, `2.0.415`, `2.0.418`:

```
series=2.0                           # major.minor, minus any prerelease suffix
WXT_EXTENSION_VERSION=${series}.${GITHUB_RUN_NUMBER}
```

`wxt.config.ts` reads `WXT_EXTENSION_VERSION` and, when set, uses it as the manifest
`version`; the zip filenames follow from the manifest, so build and artifacts always agree.
Releases leave it unset and ship exactly what `package.json` declares.

The run number is what makes this work: it increments on every run of that workflow, never
resets, and never repeats — so each nightly is unique and strictly newer than the last,
including on days the build is skipped (the counter just leaves a gap). It also stays well
inside Chrome's version format, which is at most four dot-separated integers of 0–65535
each. Two things would break it, neither likely: renaming `nightly.yml` (the counter is
per-workflow-file and would restart from 1) and a run number above 65535. A date-based
component — days since a fixed epoch — is the usual alternative if either becomes a
problem.

Setting the version through the config rather than rewriting `package.json` is deliberate:
a mutated working tree would make `wxt.config.ts` mark the build dirty, and every nightly
would show `-dirty` in the build stamp shown in the popup.

**Nightlies occupy the patch component, so there are no patch releases while they
publish.** Everything in the `2.0` series now sorts below `2.0.412`, which means a stable
release has to bump at least the minor: `2.0.412` → `2.1.0`, never `2.0.0` or `2.0.1` —
both stores would reject those as older than what nightlies already shipped. The next
cycle's nightlies then become `2.1.<run>`, and the release after that `2.2.0`. If patch
releases become necessary, widening the nightly back to four components
(`<major>.<minor>.<patch>.<run>`) frees the patch slot again.

Cutting a release is: bump `version`, merge, then tag that commit `v<version>` and push the
tag — `release.yml` refuses to build when the tag and `package.json` disagree.

### Credentials

Run `pnpm exec wxt submit init` locally: it walks through both stores and prints the
values. Add them as repository **secrets** (Settings → Secrets and variables → Actions).

| Secret                                                             | Store  |
| ------------------------------------------------------------------ | ------ |
| `CHROME_EXTENSION_ID`                                              | Chrome |
| `CHROME_CLIENT_ID`, `CHROME_CLIENT_SECRET`, `CHROME_REFRESH_TOKEN` | Chrome |
| `FIREFOX_EXTENSION_ID`                                             | AMO    |
| `FIREFOX_JWT_ISSUER`, `FIREFOX_JWT_SECRET`                         | AMO    |

Two optional knobs, both repository **variables** rather than secrets:

- `STORE_DRY_RUN=true` — every upload authenticates and validates but uploads nothing.
  Worth setting while first wiring the credentials up.
- The `store-release` environment gates `release.yml`. Adding required reviewers to it
  (Settings → Environments) makes every public release wait for a human before uploading.

`workflow_dispatch` on `nightly.yml` takes a `skip_store_upload` input for forcing a
nightly build without touching the stores; `release.yml`'s manual runs default to a dry
run.

## Compatibility contract

The encryption format and API surface are fixed by the existing backend and the wider
xBrowserSync ecosystem. See [`openapi/xbrowsersync-api.yaml`](openapi/xbrowsersync-api.yaml)
and [`src/core/crypto/crypto.ts`](src/core/crypto/crypto.ts). Do not change crypto
parameters (PBKDF2 250 000 iterations / SHA-256, AES-GCM, 16-byte prepended IV, LZUTF8
compression) without an explicit migration plan — existing syncs would become unreadable.

## License

GPL-3.0-only, following upstream xBrowserSync (MarkSync is a downstream fork).
