import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

const platform = { current: 'ios' };
const listeners: Record<string, (arg: unknown) => void> = {};

vi.mock('@capacitor/core', () => ({ Capacitor: { getPlatform: () => platform.current } }));
vi.mock('@capacitor/app', () => ({ App: { getInfo: vi.fn().mockResolvedValue({ version: '1.0.2' }) } }));
vi.mock('@capacitor/push-notifications', () => ({
  PushNotifications: {
    checkPermissions: vi.fn(),
    requestPermissions: vi.fn(),
    register: vi.fn().mockResolvedValue(undefined),
    addListener: vi.fn(async (name: string, fn: (arg: unknown) => void) => {
      listeners[name] = fn;
      return { remove: vi.fn() };
    }),
  },
}));
vi.mock('./api.ts', () => ({ request: vi.fn().mockResolvedValue(undefined) }));

import { PushNotifications } from '@capacitor/push-notifications';
import { request } from './api.ts';
import { askForPush, listenForPush, pushPermission, refreshPushRegistration, unregisterThisDevice } from './push.ts';

const onTap = vi.fn();

beforeEach(() => {
  platform.current = 'ios';
  localStorage.clear();
  (request as Mock).mockClear();
  (PushNotifications.register as Mock).mockClear();
});

describe('push on the phone', () => {
  it('does nothing at all off iOS, where Firebase is not set up yet', async () => {
    platform.current = 'android';
    expect(await pushPermission()).toBe('unsupported');
    expect(await askForPush()).toBe('unsupported');
    await refreshPushRegistration();
    expect(PushNotifications.register).not.toHaveBeenCalled();
  });

  it('re-registers on launch only when already allowed, and never asks', async () => {
    (PushNotifications.checkPermissions as Mock).mockResolvedValue({ receive: 'prompt' });
    await refreshPushRegistration();
    expect(PushNotifications.register).not.toHaveBeenCalled();
    expect(PushNotifications.requestPermissions).not.toHaveBeenCalled();

    (PushNotifications.checkPermissions as Mock).mockResolvedValue({ receive: 'granted' });
    await refreshPushRegistration();
    expect(PushNotifications.register).toHaveBeenCalledTimes(1);
  });

  it('sends the token to the API, and removes it on sign-out', async () => {
    listenForPush(onTap);
    listeners['registration']!({ value: 'abc123token' });
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith('/v1/push/devices', {
        method: 'POST',
        body: { token: 'abc123token', platform: 'ios', appVersion: '1.0.2' },
      }),
    );

    await unregisterThisDevice();
    expect(request).toHaveBeenCalledWith('/v1/push/devices/abc123token', { method: 'DELETE' });
    (request as Mock).mockClear();
    await unregisterThisDevice();
    expect(request).not.toHaveBeenCalled();
  });

  it('attaches its listeners once, and hands a tap to the app with its data', () => {
    listenForPush(vi.fn());
    listeners['pushNotificationActionPerformed']!({ notification: { data: { path: '/loads/L1', orgId: 'o' } } });
    expect(onTap).toHaveBeenCalledWith({ path: '/loads/L1', orgId: 'o' });
  });

  it('never blocks sign-out on a failed request', async () => {
    localStorage.setItem('haulq.push.token', 'tok');
    (request as Mock).mockRejectedValueOnce(new Error('offline'));
    await expect(unregisterThisDevice()).resolves.toBeUndefined();
    expect(localStorage.getItem('haulq.push.token')).toBeNull();
  });
});
