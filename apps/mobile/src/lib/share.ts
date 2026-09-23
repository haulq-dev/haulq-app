/**
 * Hand a link or code to the native share sheet: Messages, WhatsApp, Mail,
 * whatever the dispatcher uses to reach a broker or driver. That beats a
 * web page's copy button on a phone.
 *
 * Falls back to the clipboard where there is no share sheet (a desktop
 * browser running `vite dev`), and says which happened so the button can
 * answer "Shared" or "Copied".
 */

import { Share } from '@capacitor/share';

export async function shareOrCopy(payload: { title: string; text: string; url?: string }): Promise<'shared' | 'copied' | 'cancelled'> {
  try {
    const { value } = await Share.canShare();
    if (value) {
      await Share.share({ title: payload.title, text: payload.text, ...(payload.url ? { url: payload.url } : {}), dialogTitle: payload.title });
      return 'shared';
    }
  } catch (err) {
    // Dismissing the share sheet rejects with "Share canceled". That is not
    // a failure, and falling through to the clipboard would surprise someone
    // who just backed out.
    if (err instanceof Error && /cancel/i.test(err.message)) return 'cancelled';
  }
  await navigator.clipboard.writeText(payload.url ? `${payload.text} ${payload.url}` : payload.text);
  return 'copied';
}

/**
 * Where `apps/web` is served. A broker's tracking link lives there, at
 * `/track/:token`, not in this app. Inside the native shell
 * `window.location.origin` is `capacitor://localhost`, which is useless to a
 * broker, so it can't be derived the way web does it.
 */
export const WEB_ORIGIN: string = import.meta.env['VITE_WEB_ORIGIN'] ?? 'https://app.haulq.ai';
