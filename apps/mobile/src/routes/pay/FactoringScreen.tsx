/**
 * The factoring companies this carrier sends packets to. Web's
 * `FactoringCompanies` card, as its own screen, reached from the bottom of
 * Pay and from an invoice that has none to pick from.
 *
 * Adding one is owner or accountant only (`POST /v1/factoring-companies`
 * refuses dispatchers); everyone on Pay can see the list.
 */

import { canManageMoney, useAddFactoringCompany, useFactoringCompanies } from '@haulq/client';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { useSession } from '../../components/AuthGate.tsx';
import { Card, Empty, ErrorNote, Field, LoadMore } from '../../components/ui.tsx';

export function FactoringScreen() {
  const role = useSession()?.role;
  const companies = useFactoringCompanies();
  const list = companies.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <div className="mx-auto max-w-md space-y-4 px-4 py-6">
      <Link to="/pay" className="text-sm text-brand">
        ‹ Pay
      </Link>
      <h1 className="text-2xl">Factoring companies</h1>

      <div className="hq-card px-4">
        <ErrorNote error={companies.error} />
        {companies.isLoading && <Empty>Loading…</Empty>}
        {companies.isSuccess && list.length === 0 && <Empty>None on file yet.</Empty>}
        <ul className="divide-y divide-line">
          {list.map((c) => (
            <li key={c.id} className="py-3">
              <p className="font-medium">{c.name}</p>
              <p className="text-sm text-mute">{[c.email, c.phone].filter(Boolean).join(' · ') || c.submissionMethod}</p>
            </li>
          ))}
        </ul>
      </div>
      <LoadMore onClick={() => void companies.fetchNextPage()} loading={companies.isFetchingNextPage} hasMore={companies.hasNextPage} />

      {canManageMoney(role) && <AddCompany />}
    </div>
  );
}

function AddCompany() {
  const add = useAddFactoringCompany();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');

  return (
    <Card title="Add one">
      <div className="space-y-3">
        <Field label="Name">
          <input className="hq-input" value={name} onChange={(e) => setName(e.target.value)} autoCapitalize="words" />
        </Field>
        <Field label="Email" hint="Where packets go.">
          <input className="hq-input" type="email" inputMode="email" autoCapitalize="none" value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field label="Phone">
          <input className="hq-input" type="tel" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
        </Field>
        <button
          type="button"
          className="hq-btn hq-btn-brand w-full"
          disabled={!name.trim() || add.isPending}
          onClick={() =>
            add.mutate(
              {
                name: name.trim(),
                ...(email.trim() ? { email: email.trim() } : {}),
                ...(phone.trim() ? { phone: phone.trim() } : {}),
              },
              {
                onSuccess: () => {
                  setName('');
                  setEmail('');
                  setPhone('');
                },
              },
            )
          }
        >
          {add.isPending ? 'Adding…' : 'Add'}
        </button>
        <ErrorNote error={add.error} />
      </div>
    </Card>
  );
}
