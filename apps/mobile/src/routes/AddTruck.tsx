/**
 * Add a truck — the first of three bare-minimum owner actions this app
 * needed once self-serve carrier signup meant a brand-new carrier could
 * land here with nothing to do (`AuthGate.tsx`'s `CreateOrgOrWait`'s own
 * note). `POST /v1/trucks` already accepts nothing but `label` — every
 * other field on `CreateTruckSchema` defaults — so this is the same
 * minimal body `apps/web`'s own `AddTruck` sends on its simplest path,
 * just without the rest of that form's optional fields.
 */

import { useMutation } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { request } from '../lib/api.ts';
import { ErrorNote } from '../components/ui.tsx';

export function AddTruckScreen() {
  const navigate = useNavigate();
  const [label, setLabel] = useState('');

  const create = useMutation({
    mutationFn: () => request('/v1/trucks', { body: { label } }),
    onSuccess: () => void navigate({ to: '/' }),
  });

  return (
    <div className="mx-auto max-w-md space-y-4 px-4 py-6">
      <button className="text-sm text-brand underline" onClick={() => void navigate({ to: '/' })}>
        ← Your loads
      </button>
      <h1 className="text-2xl">Add a truck</h1>
      <input
        className="hq-input"
        placeholder="Truck number or name"
        value={label}
        onChange={(e) => setLabel(e.target.value)}
      />
      <button
        type="button"
        className="hq-btn hq-btn-brand w-full"
        disabled={!label.trim() || create.isPending}
        onClick={() => create.mutate()}
      >
        {create.isPending ? 'Adding…' : 'Add truck'}
      </button>
      <ErrorNote error={create.error} />
    </div>
  );
}
