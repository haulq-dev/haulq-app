/**
 * Documents, for owners, dispatchers and accountants. Web's `Documents.tsx`
 * on a phone (MOBILE_PARITY_PLAN.md M2).
 *
 * The inbox ("Needs a load") is the default, because a rate confirmation
 * sitting unattached is the one state where paperwork silently stops
 * moving. Rejected documents, the ones that disagree with their load, get a
 * banner, since those are worth opening first.
 *
 * Adding paperwork is at the top: the camera or a file, plus the email
 * address brokers can send to. The custom-address setting stays on the web
 * for now; it's a one-time setup, and it belongs with the profile (M5).
 */

import { useCarrierProfile, useDocumentCounts, useDocuments } from '@haulq/client';
import { useState } from 'react';
import { DocumentCapture } from '../../components/DocumentCapture.tsx';
import { DocumentRows } from '../../components/DocumentRows.tsx';
import { Card, Empty, ErrorNote, LoadMore } from '../../components/ui.tsx';
import { shareOrCopy } from '../../lib/share.ts';

export function DocumentsScreen() {
  const [view, setView] = useState<'inbox' | 'all'>('inbox');
  const docs = useDocuments({ view });
  const counts = useDocumentCounts();
  const items = docs.data?.pages.flatMap((p) => p.items) ?? [];
  const rejected = counts.data?.counts['rejected'] ?? 0;

  return (
    <div className="mx-auto max-w-md space-y-4 px-4 py-6">
      <h1 className="text-2xl">Documents</h1>

      <Card title="Add paperwork">
        <p className="mb-3 text-sm text-slate">
          Rate confirmations, BOLs, PODs, receipts. A photo taken at the dock is fine. Sending the same file twice is
          harmless.
        </p>
        <DocumentCapture />
      </Card>

      <InboundEmail />

      {rejected > 0 && (
        <p className="hq-card bg-bad-50 px-3 py-2.5 text-sm text-bad shadow-none">
          {rejected === 1 ? '1 document does not match its load.' : `${rejected} documents do not match their loads.`}{' '}
          Those are worth opening first.
        </p>
      )}

      <div className="grid grid-cols-2 rounded-[var(--radius-sm)] bg-line/60 p-0.5" role="tablist">
        {(['inbox', 'all'] as const).map((v) => (
          <button
            key={v}
            type="button"
            role="tab"
            aria-selected={view === v}
            onClick={() => setView(v)}
            className={`rounded-[8px] py-1.5 text-sm font-semibold ${view === v ? 'bg-card text-ink shadow-sm' : 'text-slate'}`}
          >
            {v === 'inbox' ? 'Needs a load' : 'All'}
          </button>
        ))}
      </div>

      <div className="hq-card px-4">
        <ErrorNote error={docs.error} />
        {docs.isLoading && <Empty>Loading…</Empty>}
        {docs.isSuccess && items.length === 0 && (
          <Empty>{view === 'inbox' ? 'Nothing waiting. Every document is on a load.' : 'No documents yet.'}</Empty>
        )}
        <DocumentRows items={items} />
      </div>
      <LoadMore onClick={() => void docs.fetchNextPage()} loading={docs.isFetchingNextPage} hasMore={docs.hasNextPage} />
    </div>
  );
}

/**
 * The address a broker or the carrier's own mail app forwards paperwork to.
 * Shared rather than only copied, because on a phone the next step is
 * usually pasting it into a text to a broker.
 */
function InboundEmail() {
  const profile = useCarrierProfile();
  const [result, setResult] = useState<string | null>(null);
  const slug = profile.data?.slug;
  if (!slug) return null;
  const address = `docs+${slug}@docs.haulq.ai`;

  return (
    <Card title="Or email it in">
      <p className="text-sm text-slate">Forward paperwork to this address and it lands here the same way.</p>
      {profile.data?.customDocsEmail && (
        <p className="mt-1 text-xs text-mute">Mail forwarded from {profile.data.customDocsEmail} arrives here too.</p>
      )}
      <code className="num mt-3 block break-all rounded-[var(--radius-sm)] bg-wash px-3 py-2 text-sm">{address}</code>
      <div className="mt-2 flex items-center gap-2">
        <button
          type="button"
          className="hq-btn hq-btn-ghost"
          onClick={async () => {
            const r = await shareOrCopy({ title: 'Send paperwork to HaulQ', text: address });
            setResult(r === 'copied' ? 'Copied' : r === 'shared' ? 'Sent' : null);
          }}
        >
          Share address
        </button>
        {result && <span className="text-sm text-ok">{result}</span>}
      </div>
    </Card>
  );
}
