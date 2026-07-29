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

// WXT configuration. The extension is a Manifest V3 background service worker plus
// a vanilla popup. No UI framework module is registered on purpose.
export default defineConfig({
  manifest: {
    name: 'MarkSync',
    description: 'Sync your bookmarks securely across browsers and devices.',
    homepage_url: 'https://github.com/MarkSyncOrg/app-next',
    permissions: ['storage', 'bookmarks', 'alarms'],
    // The official service. Self-hosted/custom service URLs are requested at runtime
    // via optional host permissions so users only grant what they actually use.
    host_permissions: ['https://api.xbrowsersync.org/*', ...(extraHost ? [extraHost] : [])],
    optional_host_permissions: ['https://*/*', 'http://*/*'],
    browser_specific_settings: {
      gecko: {
        id: 'marksync-webext@marksync.org',
        strict_min_version: '115.0',
        // The extension collects no telemetry; all sync data is end-to-end encrypted.
        data_collection_permissions: { required: ['none'] },
      },
    },
  },
  // Build stamp constants, read through src/build-info.ts.
  vite: () => ({
    define: {
      __GIT_COMMIT__: JSON.stringify(gitCommit),
      __GIT_DIRTY__: JSON.stringify(gitDirty),
    },
  }),
});
