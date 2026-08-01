# MarkSync — Web Extension

MarkSync is a ground-up rewrite of a bookmark-sync browser extension targeting
**Manifest V3**, built with [WXT](https://wxt.dev) + TypeScript and **no UI framework**.
It is a fork/successor of the xBrowserSync web client.

This client is compatible **only with the existing xBrowserSync backend API**; there is
no compatibility constraint with the legacy (AngularJS) client code.

## Status

Alpha. An end-to-end vertical slice works: set up a sync (new or existing), and
bookmarks are encrypted and synchronised with an xBrowserSync service.

| Area                          | State                                   |
| ----------------------------- | --------------------------------------- |
| OpenAPI contract (`openapi/`) | done                                    |
| Core: crypto                  | done (tested, format-compatible)        |
| Core: API client              | done (tested)                           |
| Core: storage                 | done (tested)                           |
| Core: bookmark model          | done (tested)                           |
| Core: sync engine             | done (tested) — full-tree + 3-way merge |
| Service worker (MV3)          | done — needs real-browser validation    |
| UI (popup)                    | done (setup/status/QR, e2e-covered)     |

### How sync works (and current limits)

Synchronisation is **full-tree**: the entire bookmark tree is encrypted and
uploaded, or downloaded and applied, on each sync. Change detection uses the
service's `lastUpdated` timestamp, plus a locally cached copy of the last-synced
tree to detect un-pushed local edits ("dirty" state). Background sync and "Sync
now" reconcile automatically: push when only local changed, pull when only remote
changed, and **three-way merge when both changed** so neither side's edits are lost
(`src/core/sync/merge.ts`). The merge is structural and content-keyed (folders by
title, bookmarks by URL, separators by position) rather than per-operation change
tracking; on a genuine attribute conflict, remote wins, so every device converges
deterministically. Per-operation change tracking (as in the legacy client) is still
future work.

The browser↔xBrowserSync bookmark mapping (`src/background/webext-bookmark-provider.ts`)
is the one piece that still needs validation against real Chrome/Firefox profiles.

### Settings, backup & logs (options page)

The popup is for setup and status — including a **QR code** of the sync ID (under
"Show QR code") to transfer it to another device by scanning. A dedicated **options
page** (opened from the popup) holds everything else. State persists in `chrome.storage` across enable/disable.

Settings:

- **Theme** — system / light / dark (palette from the legacy client).
- **Auto-sync** — background sync interval (off / 15 / 30 / 60 min); drives the alarm.
- **Sync bookmarks toolbar** — include the browser's toolbar/bar in the sync.
- **Sync changes automatically** — push local bookmark edits as they happen.

Backup & restore:

- **Export** the current bookmarks to an unencrypted backup file
  (`xbs_backup_<timestamp>.txt`, xBrowserSync-compatible; credentials are never written).
- **Restore** from a backup file (current or legacy shape); restoring replaces the
  current bookmarks and pushes them if sync is enabled. Scheduled auto-backup is not
  implemented (MV3 cannot reliably write files on a timer).

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

Website link:

- Both the popup and the options page carry a link to
  [app.marksync.org](https://app.marksync.org) in their footer, opened in a new tab so the
  popup closing never interrupts what the user was doing.

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

## Compatibility contract

The encryption format and API surface are fixed by the existing backend and the wider
xBrowserSync ecosystem. See [`openapi/xbrowsersync-api.yaml`](openapi/xbrowsersync-api.yaml)
and [`src/core/crypto/crypto.ts`](src/core/crypto/crypto.ts). Do not change crypto
parameters (PBKDF2 250 000 iterations / SHA-256, AES-GCM, 16-byte prepended IV, LZUTF8
compression) without an explicit migration plan — existing syncs would become unreadable.

## License

GPL-3.0-only, following upstream xBrowserSync (MarkSync is a downstream fork).
