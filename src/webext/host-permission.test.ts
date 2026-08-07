import { describe, expect, it } from 'vitest';
import { HostPermissionGate, type PermissionsApi } from './host-permission';

/** Records the calls made to `browser.permissions`, and what was asked for. */
function fakePermissions(options: { granted?: string[]; answer?: boolean } = {}) {
  const calls: string[] = [];
  const requested: string[][] = [];
  const api: PermissionsApi = {
    getAll() {
      calls.push('getAll');
      return Promise.resolve({ origins: options.granted ?? [] });
    },
    request(permissions) {
      calls.push('request');
      requested.push(permissions.origins);
      return Promise.resolve(options.answer ?? true);
    },
  };
  return { api, calls, requested };
}

describe('HostPermissionGate', () => {
  it('requests the permission in the same task as the caller, with no await in front', async () => {
    // The point of the class: Firefox rejects permissions.request() as soon as the user
    // gesture is gone, and it is gone after the first await. A custom service is only
    // reachable if the request is issued before ensure() ever yields, so assert exactly
    // that — the call is already recorded when ensure() returns, without awaiting it.
    const { api, calls, requested } = fakePermissions();
    const gate = new HostPermissionGate(api);
    await gate.refresh();
    calls.length = 0;

    const pending = gate.ensure('https://sync.example.com');

    expect(calls).toEqual(['request']);
    expect(requested).toEqual([['https://sync.example.com/*']]);
    await expect(pending).resolves.toBeUndefined();
  });

  it('normalises the service URL down to its origin pattern', async () => {
    const { api, requested } = fakePermissions();
    const gate = new HostPermissionGate(api);
    await gate.refresh();

    await gate.ensure('https://sync.example.com:8443/xbs/');

    expect(requested).toEqual([['https://sync.example.com:8443/*']]);
  });

  it('does not ask again for a host granted at install', async () => {
    // The official service is a manifest host permission, so the popup must not prompt
    // for it — this is the path that kept working on Firefox while custom ones failed.
    const { api, calls } = fakePermissions({ granted: ['https://api.xbrowsersync.org/*'] });
    const gate = new HostPermissionGate(api);
    await gate.refresh();

    await gate.ensure('https://api.xbrowsersync.org');

    expect(calls).toEqual(['getAll']);
  });

  it('remembers a host it has just been granted', async () => {
    const { api, calls } = fakePermissions();
    const gate = new HostPermissionGate(api);
    await gate.refresh();

    await gate.ensure('https://sync.example.com');
    await gate.ensure('https://sync.example.com');

    expect(calls).toEqual(['getAll', 'request']);
  });

  it('reports a denied request as an error', async () => {
    const { api } = fakePermissions({ answer: false });
    const gate = new HostPermissionGate(api);
    await gate.refresh();

    await expect(gate.ensure('https://sync.example.com')).rejects.toThrow(
      'Permission to access this service was denied',
    );
  });

  it('rejects an unusable service URL without touching permissions', async () => {
    const { api, calls } = fakePermissions();
    const gate = new HostPermissionGate(api);
    await gate.refresh();
    calls.length = 0;

    await expect(gate.ensure('not a url')).rejects.toThrow();
    await expect(gate.ensure('https://user:pw@sync.example.com')).rejects.toThrow();
    await expect(gate.ensure('https://sync.example.com?token=1')).rejects.toThrow();
    expect(calls).toEqual([]);
  });

  it('refuses a plaintext host that is not already granted', async () => {
    // Only `https://*/*` is optional in the manifest, so requesting an http origin would
    // fail with the browser's wording about undeclared optional permissions.
    const { api, calls } = fakePermissions();
    const gate = new HostPermissionGate(api);
    await gate.refresh();

    await expect(gate.ensure('http://localhost:8080')).rejects.toThrow(
      'Only https services can be added',
    );
    expect(calls).toEqual(['getAll']);
  });

  it('allows a plaintext host granted at install (WXT_EXTRA_HOST)', async () => {
    const { api, calls } = fakePermissions({ granted: ['http://localhost:8080/*'] });
    const gate = new HostPermissionGate(api);
    await gate.refresh();

    await gate.ensure('http://localhost:8080');

    expect(calls).toEqual(['getAll']);
  });
});
