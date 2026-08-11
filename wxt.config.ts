import { execFileSync } from 'node:child_process';
import { defineConfig } from 'wxt';

// Optional extra granted host, used only for local/integration testing against a
// self-hosted backend (e.g. WXT_EXTRA_HOST=http://localhost:8080/*). Never set in
// production builds, so users still grant custom services explicitly at runtime.
const extraHost = process.env.WXT_EXTRA_HOST;

/** Runs a git command, returning its trimmed output or '' when git cannot answer. */
function git(...args: string[]): string {
  try {
    return execFileSync('git', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    // No git, no repository (building from the sources zip), or a refused checkout.
    return '';
  }
}

// Commit the extension is built from, stamped into the bundle so the UI and the debug
// log can name the exact build a bug report comes from. Falls back to the sha CI hands
// us when the checkout has no .git directory; when nothing is known the UI shows the
// version on its own.
const gitCommit = git('rev-parse', 'HEAD') || process.env.GITHUB_SHA || '';
// A local build with uncommitted changes is not the commit it claims to be, so say so.
const gitDirty = gitCommit !== '' && git('status', '--porcelain') !== '';

// Version stamped into the manifest, overriding package.json when set. Both stores reject
// a version they have already seen, and nightlies are built from a package version that
// only moves on release, so CI hands every uploadable build its own version (nightlies get
// a fourth component, `2.0.0.<run>`, which is monotonic and stays inside the four-part,
// 0–65535-per-part format Chrome accepts). Unset locally and for release builds, where
// package.json is the source of truth.
const versionOverride = process.env.WXT_EXTENSION_VERSION;

// Hosts a user may grant at runtime for a self-hosted service. HTTPS only: the sync ID
// travels in the request path and is the only thing the service authenticates on, so a
// plaintext endpoint would hand the sync to anyone on the network path. A local service
// over http is still reachable in development through WXT_EXTRA_HOST, which is granted
// at install rather than requested.
const OPTIONAL_HOSTS = ['https://*/*'];

// WXT configuration. The extension is a Manifest V3 background service worker plus
// a vanilla popup. No UI framework module is registered on purpose.
export default defineConfig({
  manifest: ({ manifestVersion }) => ({
    name: 'MarkSync',
    description: 'Sync your bookmarks securely across browsers and devices.',
    ...(versionOverride ? { version: versionOverride } : {}),
    homepage_url: 'https://github.com/MarkSyncOrg/app-next',
    permissions: ['storage', 'bookmarks', 'alarms'],
    // The official service. Self-hosted/custom service URLs are requested at runtime
    // via optional host permissions so users only grant what they actually use.
    host_permissions: ['https://api.xbrowsersync.org/*', ...(extraHost ? [extraHost] : [])],
    // MV2 (the Firefox target) has no `optional_host_permissions`; Gecko reads optional
    // host patterns from `optional_permissions`. Emitting the MV3 key there makes it
    // vanish from the built manifest, and `permissions.request()` then rejects every
    // custom service URL — i.e. self-hosted setup silently stops working on Firefox.
    ...(manifestVersion === 2
      ? { optional_permissions: OPTIONAL_HOSTS }
      : { optional_host_permissions: OPTIONAL_HOSTS }),
    browser_specific_settings: {
      gecko: {
        id: 'marksync-webext@marksync.org',
        // Firefox's built-in data collection consent — the key below — landed in 140 on
        // desktop and 142 on Android. AMO requires the disclosure, so the minimums are
        // pinned to the first versions that understand it; anything lower makes the
        // validator warn that the key is declared for browsers that ignore it. 140 is
        // the current ESR, so this only excludes users on stale non-ESR builds.
        strict_min_version: '140.0',
        // The extension collects no telemetry; all sync data is end-to-end encrypted.
        data_collection_permissions: { required: ['none'] },
      },
      gecko_android: {
        strict_min_version: '142.0',
      },
    },
  }),
  // Build stamp constants, read through src/build-info.ts.
  vite: () => ({
    define: {
      __GIT_COMMIT__: JSON.stringify(gitCommit),
      __GIT_DIRTY__: JSON.stringify(gitDirty),
    },
  }),
});
