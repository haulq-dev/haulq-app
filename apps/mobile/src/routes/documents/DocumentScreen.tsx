/**
 * One document: the file, what HaulQ read off it against its load, and the
 * two corrections an office role can make (attach it to a load, or type in
 * a field the reader missed). Web's `Detail` panel, as its own screen.
 *
 * The verdict comes from `summarizeValidation` in `@haulq/contracts`, the same
 * function the API stored the status with. A document not checked yet says
 * so rather than showing a green tick it hasn't earned.
 *
 * Attaching and manual entry are office-only on the API (`/attach` and
 * `/manual-fields` refuse drivers). A driver never reaches this screen from
 * the app.
 */

import {
  EXPECTED_FIELDS_BY_KIND,
  FIELD_METADATA,
  FIELD_NAMES_BY_KIND,
  summarizeValidation,
} from '@haulq/contracts';
import {
  documentTitle,
  DOCUMENT_STATUS_TONE,
  extractedRaw,
  humanizeField,
  laneEnds,
  queryKeys,
  useDocument,
  type DocumentRow,
  type Load,
} from '@haulq/client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { useState } from 'react';
import { DocumentPreview } from '../../components/DocumentPreview.tsx';
import { Card, ErrorNote, Field, Pill } from '../../components/ui.tsx';
import { request } from '../../lib/api.ts';

const when = (iso: string) =>
  new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

export function DocumentScreen() {
  const { documentId } = useParams({ from: '/documents/$documentId' });
  const doc = useDocument(documentId);

  return (
    <div className="mx-auto max-w-md space-y-4 px-4 py-6">
      <Link to="/documents" className="text-sm text-brand">
        ‹ Documents
      </Link>
      {doc.isError && <ErrorNote error={doc.error} />}
      {doc.isLoading && <p className="text-sm text-mute">Loading…</p>}
      {doc.data && <Body document={doc.data} />}
    </div>
  );
}

function Body({ document }: { document: DocumentRow }) {
  return (
    <>
      <header className="space-y-1">
        <div className="flex items-center gap-2">
          <h1 className="text-2xl">{documentTitle(document.kind)}</h1>
          <Pill tone={DOCUMENT_STATUS_TONE[document.status] ?? 'neutral'} onPage>
            {document.status}
          </Pill>
        </div>
        <p className="truncate text-sm text-mute">
          {document.filename ?? 'Untitled'} · {when(document.receivedAt)}
        </p>
        <p className="text-sm text-mute">
          {document.source.replace(/_/g, ' ')}
          {document.receivedFrom && ` · from ${document.receivedFrom}`}
        </p>
      </header>

      <DocumentPreview id={document.id} contentType={document.contentType} filename={document.filename} />

      <Card title="Load">
        <AttachControl document={document} />
      </Card>

      <Card title="Against the load">
        <Disagreements document={document} />
        <ManualFields key={document.id} document={document} />
      </Card>
    </>
  );
}

function loadLabel(load: Load): string {
  const { pickup, delivery } = laneEnds(load.stops);
  const lane = pickup && delivery ? ` · ${pickup.city} → ${delivery.city}` : '';
  return `Load ${load.reference}${load.brokerName ? ` · ${load.brokerName}` : ''}${lane}`;
}

/**
 * Attach, or re-attach to a different load. A rejected document is corrected
 * by pointing it at the right load, and the API treats re-attaching as a
 * normal write.
 */
function AttachControl({ document }: { document: DocumentRow }) {
  const queryClient = useQueryClient();
  const [choice, setChoice] = useState(document.loadId ?? '');

  // A `loads` prefix key, so any load change refreshes these options too.
  const loads = useQuery({
    queryKey: [...queryKeys.loads, 'attach-options'],
    queryFn: () => request<{ items: Load[] }>('/v1/loads?limit=100'),
  });

  const attach = useMutation({
    mutationFn: () => request(`/v1/documents/${document.id}/attach`, { method: 'POST', body: { loadId: choice } }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.documents }),
  });

  const options = loads.data?.items ?? [];
  if (loads.isSuccess && options.length === 0) return <p className="text-sm text-mute">No loads yet. Add one before attaching this.</p>;

  return (
    <div className="space-y-2">
      {document.loadId && (
        <Link to="/loads/$loadId" params={{ loadId: document.loadId }} className="text-sm text-brand underline">
          Open the load it's on
        </Link>
      )}
      <Field label={document.loadId ? 'Move to a different load' : 'Attach to a load'}>
        <select className="hq-input" value={choice} onChange={(e) => setChoice(e.target.value)}>
          <option value="">Choose a load…</option>
          {options.map((l) => (
            <option key={l.id} value={l.id}>
              {loadLabel(l)}
            </option>
          ))}
        </select>
      </Field>
      <button
        type="button"
        className="hq-btn hq-btn-primary"
        disabled={!choice || choice === document.loadId || attach.isPending}
        onClick={() => attach.mutate()}
      >
        {attach.isPending ? 'Attaching…' : document.loadId ? 'Move' : 'Attach'}
      </button>
      <ErrorNote error={attach.error} />
    </div>
  );
}

function Disagreements({ document }: { document: DocumentRow }) {
  if (!document.validation) {
    return (
      <p className="text-sm text-mute">
        {document.extractedAt
          ? 'Read, but not checked against a load yet.'
          : 'Not read yet. HaulQ checks a document against its load once it has been read.'}
      </p>
    );
  }

  const verdict = summarizeValidation(document.validation);
  return (
    <div className="space-y-2">
      <p className={`text-sm ${verdict.outcome === 'validated' ? 'text-ok' : 'text-bad'}`}>
        {verdict.outcome === 'validated' ? 'Everything on this document agrees with the load.' : verdict.reason}
      </p>
      <ul className="divide-y divide-line">
        {document.validation.map((f) => (
          <li key={f.field} className="space-y-1 py-2">
            <div className="flex items-center justify-between gap-2">
              <span className="capitalize">{humanizeField(f.field)}</span>
              {/* Colour is never the only signal: the pill says it in words. */}
              {!f.agrees && <Pill tone={f.severity === 'error' ? 'warn' : 'neutral'}>{f.severity}</Pill>}
            </div>
            <div className="grid grid-cols-2 gap-2 text-sm">
              <div>
                <p className="field-label">Document says</p>
                <p className={`num ${f.agrees ? '' : 'text-bad'}`}>{f.documentValue ?? '—'}</p>
              </div>
              <div>
                <p className="field-label">Load says</p>
                <p className="num">{f.loadValue ?? '—'}</p>
              </div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Type in what a document says, for a kind the pipeline has field rules for.
 * Opens on its own when the document was never read, or an expected field is
 * missing. Only fields that actually changed are sent. A blank field means
 * "leave it alone", never "clear it".
 */
function ManualFields({ document }: { document: DocumentRow }) {
  const queryClient = useQueryClient();
  const names = FIELD_NAMES_BY_KIND[document.kind as keyof typeof FIELD_NAMES_BY_KIND] ?? [];
  const expected = EXPECTED_FIELDS_BY_KIND[document.kind as keyof typeof EXPECTED_FIELDS_BY_KIND] ?? [];
  const [drafts, setDrafts] = useState<Record<string, string>>(() =>
    Object.fromEntries(names.map((field) => [field, extractedRaw(document, field)])),
  );
  const missingExpected = expected.some((field) => !document.extracted || !(field in document.extracted));
  const [open, setOpen] = useState(document.status === 'received' || missingExpected);

  const save = useMutation({
    mutationFn: (fields: Record<string, string>) =>
      request(`/v1/documents/${document.id}/manual-fields`, { method: 'POST', body: { fields } }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.documents }),
  });

  if (names.length === 0) return null;
  if (!open) {
    return (
      <button type="button" className="mt-3 text-sm text-brand underline" onClick={() => setOpen(true)}>
        Correct a field
      </button>
    );
  }

  const changed = Object.fromEntries(
    Object.entries(drafts).filter(([field, value]) => value.trim() !== '' && value.trim() !== extractedRaw(document, field)),
  );

  return (
    <div className="mt-4 space-y-3 border-t border-line pt-4">
      <p className="field-label">Type in what the document says</p>
      {names.map((field) => {
        const meta = FIELD_METADATA[field];
        if (!meta) return null;
        const was = extractedRaw(document, field);
        const draft = drafts[field] ?? '';
        const hint = was && draft.trim() !== was ? `Was: ${was}` : undefined;
        return (
          <Field key={field} label={meta.label} {...(hint ? { hint } : {})}>
            <input
              className="hq-input"
              {...(meta.type !== 'text' ? { inputMode: meta.type === 'money' ? ('decimal' as const) : ('numeric' as const) } : {})}
              value={draft}
              onChange={(e) => setDrafts((d) => ({ ...d, [field]: e.target.value }))}
            />
          </Field>
        );
      })}
      <button
        type="button"
        className="hq-btn hq-btn-primary"
        disabled={Object.keys(changed).length === 0 || save.isPending}
        onClick={() => save.mutate(changed)}
      >
        {save.isPending ? 'Saving…' : 'Save'}
      </button>
      {save.isSuccess && !save.isPending && <p className="text-sm text-ok">Saved.</p>}
      <ErrorNote error={save.error} />
    </div>
  );
}
