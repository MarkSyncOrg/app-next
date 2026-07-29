import { describe, expect, it } from 'vitest';
import {
  BUILD_COMMIT,
  BUILD_DIRTY,
  buildDescription,
  commitLabel,
  currentBuild,
  versionLabel,
} from './build-info';

const SHA = '0123456789abcdef0123456789abcdef01234567';

describe('commitLabel', () => {
  it('abbreviates the sha to seven characters', () => {
    expect(commitLabel({ version: '2.0.0', commit: SHA, dirty: false })).toBe('0123456');
  });

  it('marks a build made with uncommitted changes', () => {
    expect(commitLabel({ version: '2.0.0', commit: SHA, dirty: true })).toBe('0123456-dirty');
  });

  it('reports an unknown commit rather than an empty label', () => {
    expect(commitLabel({ version: '2.0.0', commit: '', dirty: false })).toBe('unknown');
  });
});

describe('versionLabel', () => {
  it('shows the version and the short commit', () => {
    expect(versionLabel({ version: '2.0.0', commit: SHA, dirty: false })).toBe('v2.0.0 (0123456)');
  });

  it('shows the version alone when the commit is unknown', () => {
    expect(versionLabel({ version: '2.0.0', commit: '', dirty: false })).toBe('v2.0.0');
  });
});

describe('buildDescription', () => {
  it('spells out the full sha the short label hides', () => {
    expect(buildDescription({ version: '2.0.0', commit: SHA, dirty: false })).toBe(
      `MarkSync 2.0.0 — built from commit ${SHA}`,
    );
  });

  it('calls out uncommitted changes', () => {
    expect(buildDescription({ version: '2.0.0', commit: SHA, dirty: true })).toContain(
      'with uncommitted changes',
    );
  });

  it('stays readable when the commit is unknown', () => {
    expect(buildDescription({ version: '2.0.0', commit: '', dirty: false })).toBe(
      'MarkSync 2.0.0 — built from an unknown commit',
    );
  });
});

describe('currentBuild', () => {
  // Outside a WXT build the injected constants are absent; the module must fall back
  // to "commit unknown" instead of throwing on an undeclared global.
  it('carries the injected build stamp alongside the runtime version', () => {
    expect(currentBuild('2.0.0')).toEqual({
      version: '2.0.0',
      commit: BUILD_COMMIT,
      dirty: BUILD_DIRTY,
    });
    expect(BUILD_COMMIT).toBe('');
    expect(BUILD_DIRTY).toBe(false);
  });
});
