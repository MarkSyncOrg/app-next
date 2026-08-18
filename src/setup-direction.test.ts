import { describe, expect, it } from 'vitest';
import type { SyncDirection } from '@marksyncorg/core';
import { type SetupMode, setupDirectionHint } from './setup-direction';

const MODES: SetupMode[] = ['new', 'existing'];
const ONE_WAY: Exclude<SyncDirection, 'two-way'>[] = ['push-only', 'pull-only'];

describe('setupDirectionHint', () => {
  it('says nothing for the default direction', () => {
    // Two-way is what the extension always did; explaining it would cost a row of the
    // popup for every user who never asked for a one-way sync.
    for (const mode of MODES) {
      expect(setupDirectionHint(mode, 'two-way')).toBeNull();
    }
  });

  it('has a sentence for every one-way choice', () => {
    for (const mode of MODES) {
      for (const direction of ONE_WAY) {
        expect(setupDirectionHint(mode, direction)).toMatch(/\S/);
      }
    }
  });

  it('says the sync is seeded from this browser whatever the direction, when creating one', () => {
    // A new sync has to come from somewhere, so even a receive-only device uploads once.
    for (const direction of ONE_WAY) {
      expect(setupDirectionHint('new', direction)).toContain('start the sync');
    }
  });

  it('warns that joining as send-only overwrites the sync, and only then', () => {
    expect(setupDirectionHint('existing', 'push-only')).toContain('Careful');
    expect(setupDirectionHint('existing', 'push-only')).toContain(
      'replaces the bookmarks already in the sync',
    );
    expect(setupDirectionHint('existing', 'pull-only')).not.toContain('Careful');
    expect(setupDirectionHint('new', 'push-only')).not.toContain('Careful');
  });

  it('says this browser loses its bookmarks when joining a sync to receive from it', () => {
    expect(setupDirectionHint('existing', 'pull-only')).toContain('Replaced by');
  });

  it('distinguishes creating from joining for every one-way direction', () => {
    // The two halves must never read the same: which side survives is exactly what
    // differs between seeding a sync and joining one that already has bookmarks.
    for (const direction of ONE_WAY) {
      expect(setupDirectionHint('new', direction)).not.toBe(
        setupDirectionHint('existing', direction),
      );
    }
  });
});
