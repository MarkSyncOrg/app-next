import { describe, expect, it } from 'vitest';
import { MemoryStorageArea } from '@marksyncorg/core';
import { clearSetupDraft, loadSetupDraft, saveSetupDraft, type SetupDraft } from './setup-draft';

const DRAFT: SetupDraft = {
  serviceUrl: 'https://sync.example.com',
  mode: 'existing',
  syncId: 'abc123',
  password: 'correct-horse-battery-staple',
  direction: 'push-only',
};

describe('setup draft', () => {
  it('has nothing to load before anything is saved', async () => {
    const storage = new MemoryStorageArea();
    await expect(loadSetupDraft(storage)).resolves.toBeUndefined();
  });

  it('returns exactly what was saved', async () => {
    const storage = new MemoryStorageArea();
    await saveSetupDraft(storage, DRAFT);
    await expect(loadSetupDraft(storage)).resolves.toEqual(DRAFT);
  });

  it('overwrites an earlier draft rather than merging into it', async () => {
    const storage = new MemoryStorageArea();
    await saveSetupDraft(storage, DRAFT);
    const next: SetupDraft = { ...DRAFT, syncId: 'xyz789', password: '' };
    await saveSetupDraft(storage, next);
    await expect(loadSetupDraft(storage)).resolves.toEqual(next);
  });

  it('leaves nothing behind once cleared', async () => {
    const storage = new MemoryStorageArea();
    await saveSetupDraft(storage, DRAFT);
    await clearSetupDraft(storage);
    await expect(loadSetupDraft(storage)).resolves.toBeUndefined();
  });
});
