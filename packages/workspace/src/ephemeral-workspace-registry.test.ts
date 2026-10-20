import { describe, expect, it } from 'vitest';
import { ephemeralWorkspaceId, EphemeralWorkspaceRegistry } from './ephemeral-workspace-registry.js';

describe('EphemeralWorkspaceRegistry', () => {
  it('gives one folder one stable id and reuses the entry', () => {
    const registry = new EphemeralWorkspaceRegistry(8, 'win32');
    const first = registry.remember({ displayName: 'Claude', rootPath: 'C:\\Users\\me\\AppData\\Roaming\\Claude', realRootPath: 'C:\\Users\\me\\AppData\\Roaming\\Claude' });
    const again = registry.remember({ displayName: 'Claude', rootPath: 'C:\\Users\\me\\AppData\\Roaming\\Claude', realRootPath: 'C:\\Users\\me\\AppData\\Roaming\\Claude' });

    expect(first).not.toBeNull();
    expect(again?.id).toBe(first?.id);
    expect(registry.size).toBe(1);
    expect(registry.get(first?.id ?? '')).toEqual(first);
    expect(ephemeralWorkspaceId('C:\\Users\\me\\AppData\\Roaming\\Claude', 'win32')).toBe(first?.id);
  });

  it('treats a Windows root case-insensitively but keeps POSIX roots exact', () => {
    const windows = new EphemeralWorkspaceRegistry(8, 'win32');
    const upper = windows.remember({ displayName: 'SDK', rootPath: 'C:\\Program Files\\Android', realRootPath: 'C:\\Program Files\\Android' });
    const mixed = windows.remember({ displayName: 'SDK', rootPath: 'C:\\PROGRAM FILES\\android', realRootPath: 'C:\\PROGRAM FILES\\android' });
    expect(mixed?.id).toBe(upper?.id);
    expect(windows.size).toBe(1);

    const posix = new EphemeralWorkspaceRegistry(8, 'linux');
    expect(posix.remember({ displayName: 'a', rootPath: '/srv/App', realRootPath: '/srv/App' })?.id)
      .not.toBe(posix.remember({ displayName: 'b', rootPath: '/srv/app', realRootPath: '/srv/app' })?.id);
  });

  it('keeps the newest folders when the bound is reached and forgets by id', () => {
    const registry = new EphemeralWorkspaceRegistry(2, 'linux');
    const oldest = registry.remember({ displayName: 'one', rootPath: '/srv/one', realRootPath: '/srv/one' });
    registry.remember({ displayName: 'two', rootPath: '/srv/two', realRootPath: '/srv/two' });
    const third = registry.remember({ displayName: 'three', rootPath: '/srv/three', realRootPath: '/srv/three' });

    expect(registry.size).toBe(2);
    expect(registry.get(oldest?.id ?? '')).toBeNull();
    expect(registry.get(third?.id ?? '')).not.toBeNull();
    expect(registry.forget(third?.id ?? '')).toBe(true);
    expect(registry.get(third?.id ?? '')).toBeNull();
    expect(registry.forget('never-existed')).toBe(false);
  });

  it('refuses a root that is not a native absolute path', () => {
    const registry = new EphemeralWorkspaceRegistry(8, 'win32');
    expect(registry.remember({ displayName: 'x', rootPath: '/etc/passwd', realRootPath: '/etc/passwd' })).toBeNull();
    expect(registry.size).toBe(0);
  });
});
