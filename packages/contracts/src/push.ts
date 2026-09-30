/**
 * Push notifications: what can be sent, to whom, and what a device registers
 * with. MOBILE_PARITY_PLAN.md section 7. Shared so the API's handlers and the
 * app's settings screen agree on the categories and who gets each.
 *
 * **Lock-screen content is minimal**, whatever the category: a load number,
 * a count, a stop number. No dollar amounts and no broker names, because a
 * phone on a dashboard is read by whoever is next to it.
 */

import { z } from 'zod';

type Role = 'owner' | 'dispatcher' | 'driver' | 'accountant';

/**
 * Every kind of notification, in the order the settings screen lists them.
 * `roles` is who receives it; the settings screen shows a person only the
 * ones their role gets. All are on until muted. There are no marketing
 * pushes, and there never will be (Guideline 4.5.3).
 */
export const PUSH_CATEGORIES = [
  { id: 'assigned', label: 'A load assigned to you', roles: ['driver'] },
  { id: 'load_quiet', label: 'A load went quiet', roles: ['owner', 'dispatcher'] },
  { id: 'proposals', label: 'A rate confirmation is ready to become a load', roles: ['owner', 'dispatcher'] },
  { id: 'detention', label: 'Detention started at a stop', roles: ['owner', 'dispatcher'] },
  { id: 'documents', label: "A document doesn't match its load", roles: ['owner', 'dispatcher'] },
  { id: 'broker_authority', label: "A broker's authority changed", roles: ['owner', 'dispatcher'] },
  { id: 'approvals', label: 'Messages waiting for your OK', roles: ['owner', 'dispatcher', 'accountant'] },
  { id: 'invoice_paid', label: 'An invoice was paid', roles: ['owner', 'accountant'] },
] as const satisfies readonly { id: string; label: string; roles: readonly Role[] }[];

export type PushCategory = (typeof PUSH_CATEGORIES)[number]['id'];

export const PUSH_CATEGORY_IDS = PUSH_CATEGORIES.map((c) => c.id) as [PushCategory, ...PushCategory[]];

/** The categories a role receives, for the settings screen. */
export function pushCategoriesFor(role: string | undefined): (typeof PUSH_CATEGORIES)[number][] {
  return PUSH_CATEGORIES.filter((c) => (c.roles as readonly string[]).includes(role ?? ''));
}

export const RegisterPushDeviceSchema = z.object({
  /** The raw APNs device token (hex) on iOS, or an FCM token on Android once that ships. */
  token: z.string().min(8).max(4096),
  platform: z.enum(['ios', 'android']),
  appVersion: z.string().max(40).optional(),
});
export type RegisterPushDevice = z.infer<typeof RegisterPushDeviceSchema>;

export const PushPreferencesSchema = z.object({
  /** Categories switched off. Everything not listed is on. */
  muted: z.array(z.enum(PUSH_CATEGORY_IDS)).max(PUSH_CATEGORY_IDS.length),
});
export type PushPreferences = z.infer<typeof PushPreferencesSchema>;
