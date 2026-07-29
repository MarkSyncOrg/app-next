/**
 * Identifies the build the user is running: the manifest version plus the commit it
 * was built from. Shown in the popup and the settings page, and recorded in the debug
 * log, so a bug report can be tied to an exact build rather than to a version number
 * that only changes on release.
 */

// Injected by the bundler (see `vite.define` in wxt.config.ts). Declared as possibly
// undefined because the module is also imported outside a WXT build (unit tests),
// where the constants are not substituted — hence the `typeof` guards below.
declare const __GIT_COMMIT__: string | undefined;
declare const __GIT_DIRTY__: boolean | undefined;

/** Full commit sha this bundle was built from, or '' when it could not be determined. */
export const BUILD_COMMIT = typeof __GIT_COMMIT__ === 'string' ? __GIT_COMMIT__ : '';

/** Whether the working tree carried uncommitted changes at build time. */
export const BUILD_DIRTY = typeof __GIT_DIRTY__ === 'boolean' ? __GIT_DIRTY__ : false;

/** Length of the abbreviated sha shown in the UI, matching git's own default. */
const SHORT_COMMIT_LENGTH = 7;

export interface BuildInfo {
  /** Extension version, as declared in the manifest. */
  version: string;
  /** Full commit sha, or '' when unknown. */
  commit: string;
  /** True when the build included uncommitted changes. */
  dirty: boolean;
}

/** The build info for this bundle, for a version read from the manifest at runtime. */
export function currentBuild(version: string): BuildInfo {
  return { version, commit: BUILD_COMMIT, dirty: BUILD_DIRTY };
}

/** Short commit label: 'a1b2c3d', 'a1b2c3d-dirty', or 'unknown'. */
export function commitLabel({ commit, dirty }: BuildInfo): string {
  if (!commit) {
    return 'unknown';
  }
  return `${commit.slice(0, SHORT_COMMIT_LENGTH)}${dirty ? '-dirty' : ''}`;
}

/** One-line build identity for the UI: 'v2.0.0 (a1b2c3d)', or 'v2.0.0' if unknown. */
export function versionLabel(build: BuildInfo): string {
  const version = `v${build.version}`;
  return build.commit ? `${version} (${commitLabel(build)})` : version;
}

/** Tooltip for {@link versionLabel}, spelling out the full sha the short one hides. */
export function buildDescription(build: BuildInfo): string {
  if (!build.commit) {
    return `MarkSync ${build.version} — built from an unknown commit`;
  }
  const changes = build.dirty ? ' with uncommitted changes' : '';
  return `MarkSync ${build.version} — built from commit ${build.commit}${changes}`;
}
