/**
 * Notifications: whether this phone gets them, and which kinds. Per person,
 * per category, on by default (MOBILE_PARITY_PLAN.md section 7). Only the
 * categories this person's role receives are listed.
 *
 * "Send a test" is how someone checks the whole chain works on their phone,
 * and how the first device build proves it.
 */

import { pushCategoriesFor } from '@haulq/contracts';
import { usePushPreferences, useSendTestPush, useSetPushPreferences } from '@haulq/client';
import { Link } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { useSession } from '../../components/AuthGate.tsx';
import { showsTabBar } from '../../components/Shell.tsx';
import { Card, ErrorNote, Note } from '../../components/ui.tsx';
import { askForPush, pushPermission, type PushPermission } from '../../lib/push.ts';

export function NotificationsScreen() {
  const role = useSession()?.role;
  const [permission, setPermission] = useState<PushPermission | null>(null);

  useEffect(() => {
    void pushPermission().then(setPermission);
  }, []);

  return (
    <div className="mx-auto max-w-md space-y-4 px-4 py-6">
      <Link to="/account" className="text-sm text-brand">
        ‹ {showsTabBar(role) ? 'More' : 'Account'}
      </Link>
      <h1 className="text-2xl">Notifications</h1>

      {permission === 'unsupported' && <Note>Notifications come to the HaulQ iPhone app.</Note>}
      {permission === 'denied' && (
        <Note>Notifications are off for HaulQ on this iPhone. Turn them on in the iPhone’s Settings, under HaulQ.</Note>
      )}
      {permission === 'prompt' && (
        <Card>
          <p className="mb-3 text-sm text-slate">This phone isn’t set up for notifications yet.</p>
          <button type="button" className="hq-btn hq-btn-primary w-full" onClick={async () => setPermission(await askForPush())}>
            Turn on notifications
          </button>
        </Card>
      )}

      <Categories role={role} />
      {permission === 'granted' && <TestSend />}
    </div>
  );
}

function Categories({ role }: { role: string | undefined }) {
  const prefs = usePushPreferences();
  const save = useSetPushPreferences();
  const categories = pushCategoriesFor(role);
  if (categories.length === 0) return null;
  const muted = new Set(save.variables ?? prefs.data?.muted ?? []);

  return (
    <Card title="Tell me when">
      <ErrorNote error={prefs.error ?? save.error} />
      <ul className="divide-y divide-line">
        {categories.map((c) => {
          const on = !muted.has(c.id);
          return (
            <li key={c.id}>
              <label className="flex cursor-pointer items-center justify-between gap-3 py-3">
                <span>{c.label}</span>
                <input
                  type="checkbox"
                  role="switch"
                  className="h-6 w-6 accent-[--color-brand]"
                  checked={on}
                  disabled={!prefs.data || save.isPending}
                  onChange={(e) => {
                    const next = new Set(muted);
                    if (e.target.checked) next.delete(c.id);
                    else next.add(c.id);
                    save.mutate([...next]);
                  }}
                />
              </label>
            </li>
          );
        })}
      </ul>
      <p className="mt-2 text-xs text-mute">Email alerts aren’t affected.</p>
    </Card>
  );
}

function TestSend() {
  const test = useSendTestPush();
  return (
    <Card>
      <button type="button" className="hq-btn hq-btn-ghost w-full" disabled={test.isPending} onClick={() => test.mutate()}>
        {test.isPending ? 'Sending…' : 'Send a test notification'}
      </button>
      {test.isSuccess && <p className="mt-2 text-center text-sm text-ok">Sent. It should arrive in a few seconds.</p>}
      <div className="mt-2">
        <ErrorNote error={test.error} />
      </div>
    </Card>
  );
}
