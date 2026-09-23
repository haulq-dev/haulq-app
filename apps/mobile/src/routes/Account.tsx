/**
 * The Account tab: which carrier, your role, the plan, and the account links.
 *
 * The plan is shown **read-only**: its name and nothing else. No price, no
 * change-plan or manage-billing control, no link to one. Apple allows an
 * app to show that a subscription bought elsewhere exists (Guideline
 * 3.1.3(b)). It does not allow steering someone to buy or change one outside
 * the app (3.1.1), and this app was already rejected once for that. Billing
 * stays on the web. See MOBILE_PARITY_PLAN.md section 2 and M5, which fills
 * the rest of this screen in (identity, operating costs, usage).
 */

import { planLabel } from '@haulq/client';
import type { ReactNode } from 'react';
import { DeleteAccountLink, SignOutLink, SwitchAccountLink, useOrgs, useSession } from '../components/AuthGate.tsx';
import { Card } from '../components/ui.tsx';

const ROLE_LABEL: Record<string, string> = {
  owner: 'Owner',
  dispatcher: 'Dispatcher',
  accountant: 'Accountant',
  driver: 'Driver',
};

export function AccountScreen() {
  const session = useSession();
  const orgs = useOrgs();
  const org = orgs.data?.items.find((o) => o.id === session?.orgId);
  const hasOtherOrgs = (orgs.data?.items.length ?? 0) > 1;

  return (
    <div className="mx-auto max-w-md space-y-4 px-4 py-6">
      <h1 className="text-2xl">Account</h1>

      <Card title="Carrier">
        <dl className="space-y-3">
          <Row label="Name">{org?.name ?? session?.orgName ?? '—'}</Row>
          <Row label="Your role">{ROLE_LABEL[org?.role ?? session?.role ?? ''] ?? '—'}</Row>
          <Row label="Plan">{planLabel(org?.plan)}</Row>
        </dl>
      </Card>

      <div className="hq-card flex flex-col items-start gap-3 p-4">
        {hasOtherOrgs && <SwitchAccountLink />}
        <SignOutLink />
        <DeleteAccountLink />
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="field-label">{label}</dt>
      <dd className="text-right">{children}</dd>
    </div>
  );
}
