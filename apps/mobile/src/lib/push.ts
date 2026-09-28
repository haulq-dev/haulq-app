/**
 * Push notifications on the phone. MOBILE_PARITY_PLAN.md section 7.
 *
 * **iOS only for now.** On Android, `@capacitor/push-notifications` needs
 * Firebase configured (a `google-services.json`), which doesn't exist until
 * Android ships. Calling `register()` without it throws, so every entry point
 * here checks `pushSupported()` first and does nothing elsewhere.
 *
 * The lifecycle:
 *  - **Asking** happens at a moment that explains itself (`PushPrompt`, on the
 *    first loads screen), never at cold launch. The app works fully if the
 *    answer is no (Guideline 4.5.4).
 *  - **Registering** happens on every launch once permission is granted, so
 *    `last_seen_at` stays fresh and a rotated token replaces the old one.
 *  - **Unregistering** happens on sign-out (`AuthGate`'s `SignOutLink`). It
 *    has to, or the next person signing in on a shared cab phone gets the
 *    last one's alerts.
 *  - **Tapping** opens the notification's path, switching carrier first if
 *    it's about a different one (`main.tsx` owns the navigation).
 */

import { App } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
import { PushNotifications, type ActionPerformed } from '@capacitor/push-notifications';
import { request } from './api.ts';

const TOKEN_KEY = 'haulq.push.token';

export function pushSupported(): boolean {
  return Capacitor.getPlatform() === 'ios';
}

export type PushPermission = 'granted' | 'denied' | 'prompt' | 'unsupported';

export async function pushPermission(): Promise<PushPermission> {
  if (!pushSupported()) return 'unsupported';
  const { receive } = await PushNotifications.checkPermissions();
  return receive === 'granted' ? 'granted' : receive === 'denied' ? 'denied' : 'prompt';
}

function storedToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

function storeToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // Private mode: the token still works for this run.
  }
}

async function sendToken(token: string): Promise<void> {
  let appVersion: string | undefined;
  try {
    appVersion = (await App.getInfo()).version;
  } catch {
    appVersion = undefined;
  }
  await request('/v1/push/devices', { method: 'POST', body: { token, platform: 'ios', ...(appVersion ? { appVersion } : {}) } });
}

let listening = false;

/**
 * Attach the plugin's listeners, once. `onTap` gets the notification's data
 * (`path`, `orgId`). Capacitor holds a tap that launched the app until a
 * listener exists, so calling this at startup catches a cold-start tap too.
 */
export function listenForPush(onTap: (data: unknown) => void): void {
  if (listening || !pushSupported()) return;
  listening = true;
  void PushNotifications.addListener('registration', ({ value }) => {
    storeToken(value);
    // Only with someone signed in: the API files a device under the user.
    void sendToken(value).catch(() => {
      // Offline, or signed out meanwhile. The next launch registers again.
    });
  });
  void PushNotifications.addListener('registrationError', () => {
    // Nothing to tell the person: alerts still come by email.
  });
  void PushNotifications.addListener('pushNotificationActionPerformed', (action: ActionPerformed) => {
    onTap(action.notification.data);
  });
}

/** On launch or sign-in: re-register if already allowed. Never asks. */
export async function refreshPushRegistration(): Promise<void> {
  if ((await pushPermission()) !== 'granted') return;
  await PushNotifications.register();
}

/** Ask, then register if allowed. Returns the answer. */
export async function askForPush(): Promise<PushPermission> {
  if (!pushSupported()) return 'unsupported';
  const { receive } = await PushNotifications.requestPermissions();
  if (receive !== 'granted') return receive === 'denied' ? 'denied' : 'prompt';
  await PushNotifications.register();
  return 'granted';
}

/**
 * Stop this phone getting this person's alerts. Called before sign-out,
 * while the request can still say who is signing out. Best effort: failing
 * to reach the API must never stop someone signing out.
 */
export async function unregisterThisDevice(): Promise<void> {
  const token = storedToken();
  if (!token) return;
  try {
    await request(`/v1/push/devices/${encodeURIComponent(token)}`, { method: 'DELETE' });
  } catch {
    // Offline. The token moves to whoever signs in next on this phone anyway.
  }
  storeToken(null);
}

const PROMPT_DISMISSED_KEY = 'haulq.push.prompt-dismissed';

/** "Not now" is remembered, so the prompt card never nags. Settings still has the switch. */
export function promptDismissed(): boolean {
  try {
    return localStorage.getItem(PROMPT_DISMISSED_KEY) === '1';
  } catch {
    return false;
  }
}

export function dismissPrompt(): void {
  try {
    localStorage.setItem(PROMPT_DISMISSED_KEY, '1');
  } catch {
    // Shows again next time, which is harmless.
  }
}
