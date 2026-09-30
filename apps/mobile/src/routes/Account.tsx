/**
 * The More tab: insights, the carrier, activity, trucks, drivers and people,
 * the plan, and the account links.
 *
 * iOS shows at most five tabs, and Pay (M3) took the fifth. Trucks, drivers
 * and people (M4) are weekly tasks rather than daily ones, so they live here
 * as rows instead of pushing Autopilot's badge off the bar, and so do
 * insights, the carrier profile and activity (M5). This is the standard iOS
 * "More" pattern.
 *
 * The plan is shown **read-only**: its name and nothing else. No price, no
 * change-plan or manage-billing control, no link to one. Apple allows an
 * app to show that a subscription bought elsewhere exists (Guideline
 * 3.1.3(b)). It does not allow steering someone to buy or change one outside
 * the app (3.1.1), and this app was already rejected once for that. Billing
 * stays on the web. See MOBILE_PARITY_PLAN.md section 2.
 */

import { canDispatch, planLabel, ROLE_LABEL, type Role } from '@haulq/client';
import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { DeleteAccountLink, SignOutLink, SwitchAccountLink, useOrgs, useSession } from '../components/AuthGate.tsx';
import { showsTabBar } from '../components/Shell.tsx';
import { Card } from '../components/ui.tsx';

export function AccountScreen() {
  const session = useSession();
  const orgs = useOrgs();
  const org = orgs.data?.items.find((o) => o.id === session?.orgId);
  const role = org?.role ?? session?.role;
  const hasOtherOrgs = (orgs.data?.items.length ?? 0) > 1;

  return (
    <div className="mx-auto max-w-md space-y-4 px-4 py-6">
      <h1 className="text-2xl">{showsTabBar(role) ? 'More' : 'Account'}</h1>

      {showsTabBar(role) && (
        <>
          <nav aria-label="Business" className="hq-card overflow-hidden">
            <ul className="divide-y divide-line">
              <NavRow to="/insights" label="Insights" hint="What loads made, by broker, lane and truck" />
              <NavRow to="/carrier" label="Carrier and costs" hint="MC and DOT, paperwork email, cost per mile" />
              <NavRow to="/activity" label="Activity" hint="Everything that happened, in plain words" />
              {canDispatch(role) && (
                <NavRow to="/integrations" label="Connected services" hint="Motive, and your work mailbox" />
              )}
              <NavRow to="/notifications" label="Notifications" hint="Which alerts this phone gets" />
              {canDispatch(role) && <NavRow to="/setup" label="Setting up" hint="What's left to set up, and what it unlocks" />}
            </ul>
          </nav>
          <nav aria-label="Fleet and people" className="hq-card overflow-hidden">
            <ul className="divide-y divide-line">
              <NavRow to="/trucks" label="Trucks" hint="Equipment, what each can haul, Motive" />
              <NavRow to="/drivers" label="Drivers" hint="Contacts, CDL and medical card dates" />
              <NavRow to="/people" label="People" hint="Who can sign in, and their roles" />
            </ul>
          </nav>
        </>
      )}

      <Card title="Carrier">
        <dl className="space-y-3">
          <Row label="Name">{org?.name ?? session?.orgName ?? '—'}</Row>
          <Row label="Your role">{ROLE_LABEL[role as Role] ?? '—'}</Row>
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

function NavRow({
  to,
  label,
  hint,
}: {
  to: '/trucks' | '/drivers' | '/people' | '/insights' | '/carrier' | '/activity' | '/integrations' | '/notifications' | '/setup';
  label: string;
  hint: string;
}) {
  return (
    <li>
      <Link to={to} className="flex items-center justify-between gap-3 px-4 py-3.5">
        <span>
          <span className="block font-semibold">{label}</span>
          <span className="block text-xs text-mute">{hint}</span>
        </span>
        <span className="text-mute" aria-hidden>
          ›
        </span>
      </Link>
    </li>
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
