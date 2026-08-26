/**
 * Documents.
 *
 * Three views of the same table, in the order a carrier meets them:
 *
 * **The inbox** is documents no load claims yet. That is the pile that has to be
 * worked, and it is the default because a rate confirmation sitting unattached
 * is the one state where paperwork silently stops moving.
 *
 * **The detail panel** shows the file itself. A carrier checking whether HaulQ
 * read something correctly wants to look at the page, not at a JSON dump of what
 * a model thought was on it.
 *
 * **The disagreement view** is the one that matters. Extraction says the model
 * read $2,400 off the PDF; validation says whether that is what the broker
 * agreed to. Until the extraction and validation passes land, `validation` is
 * null on every row and this view says so honestly rather than showing a green
 * tick it has not earned.
 *
 * The verdict here comes from `summarizeValidation` in `@haulq/contracts` — the
 * same function the repository used to decide the stored status. The screen and
 * the database cannot disagree about what "rejected" means, because there is
 * only one implementation of the rule.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import {
  documentKindLabel,
  EXPECTED_FIELDS_BY_KIND,
  FIELD_METADATA,
  FIELD_NAMES_BY_KIND,
  summarizeValidation,
  type ValidationFinding,
} from '@haulq/contracts';
import { request, requestBlob, type CarrierProfile } from '../lib/api.ts';
import { useSession } from '../components/AuthGate.tsx';
import { Card, Empty, ErrorNote, Field, Pill } from '../components/ui.tsx';

interface DocumentRow {
  id: string;
  kind: string;
  kindConfidence: number | null;
  status: string;
  source: string;
  filename: string | null;
  contentType: string | null;
  byteSize: number | null;
  pageCount: number | null;
  sha256: string;
  loadId: string | null;
  receivedFrom: string | null;
  receivedAt: string;
  extracted: Record<string, unknown> | null;
  extractedAt: string | null;
  extractorVersion: string | null;
  validation: ValidationFinding[] | null;
  validatedAt: string | null;
  rejectionReason: string | null;
}

interface LoadOption {
  id: string;
  reference: number;
  brokerName: string | null;
  stops: Array<{ type: string; city: string; state: string }>;
}

const STATUS_TONE: Record<string, 'ok' | 'warn' | 'neutral'> = {
  validated: 'ok',
  rejected: 'warn',
  quarantined: 'warn',
};

/** Accepted by the API's sniffer. Advisory only — the bytes are what decide. */
const ACCEPT = '.pdf,.jpg,.jpeg,.png,.tif,.tiff,.heic,application/pdf,image/*';

function fileSize(bytes: number | null): string {
  if (bytes === null) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const when = (iso: string) =>
  new Date(iso).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });

function loadLabel(load: LoadOption): string {
  const pickup = load.stops.find((s) => s.type === 'pickup');
  const delivery = [...load.stops].reverse().find((s) => s.type === 'delivery');
  const lane =
    pickup && delivery
      ? ` · ${pickup.city}, ${pickup.state} → ${delivery.city}, ${delivery.state}`
      : '';
  return `Load ${load.reference}${load.brokerName ? ` · ${load.brokerName}` : ''}${lane}`;
}

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

/**
 * Reports what happened to each file, including the ones already held.
 *
 * A silent no-op on a duplicate is the wrong answer: someone who re-sends a
 * rate confirmation and sees nothing change assumes the upload failed and does
 * it again. Deduping is a feature, so it gets said out loud.
 */
function Dropzone() {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [note, setNote] = useState<string | null>(null);

  const send = async (files: FileList) => {
    setBusy(true);
    setError(null);
    setNote(null);

    let added = 0;
    let already = 0;

    try {
      for (const file of Array.from(files)) {
        const res = await request<{ deduped: boolean }>(
          `/v1/documents?filename=${encodeURIComponent(file.name)}`,
          {
            raw: {
              body: file,
              // The API sniffs the bytes regardless. Sending the browser's
              // guess only has to get the request past the content type parser.
              contentType: file.type || 'application/octet-stream',
            },
          },
        );
        if (res.deduped) already += 1;
        else added += 1;
      }

      setNote(
        [
          added ? `${added} added` : null,
          already ? `${already} you already had` : null,
        ]
          .filter(Boolean)
          .join(', '),
      );
      await queryClient.invalidateQueries({ queryKey: ['documents'] });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Add paperwork">
      <p className="mb-5 max-w-prose text-sm text-slate">
        Rate confirmations, bills of lading, PODs, invoices. PDFs and photos both
        work — a picture of a signed BOL taken at the dock is fine. Sending the
        same file twice is harmless; HaulQ keeps one copy.
      </p>

      <label className="block cursor-pointer border-2 border-dashed border-line bg-wash p-10 text-center hover:border-brand">
        <input
          type="file"
          multiple
          accept={ACCEPT}
          className="sr-only"
          disabled={busy}
          onChange={(e) => {
            const files = e.target.files;
            if (files?.length) void send(files);
            e.target.value = '';
          }}
        />
        <span className="block text-lg">
          {busy ? 'Uploading…' : 'Choose files'}
        </span>
        <span className="mt-1 block text-xs text-mute">
          PDF, JPEG, PNG, TIFF or HEIC, up to 25 MB each
        </span>
      </label>

      {note && <p className="mt-3 text-sm text-ok">{note}.</p>}
      <div className="mt-3">
        <ErrorNote error={error} />
      </div>
    </Card>
  );
}

/**
 * The other way paperwork gets here.
 *
 * A carrier already forwarding a rate confirmation from their phone's mail app
 * is not going to switch to a browser upload for it. Same copy-to-clipboard
 * pattern as `TokenPanel` in Members.tsx; not shared, because the two carry
 * different caveats and forcing one component to say both is how a caveat
 * quietly goes missing from one of them.
 */
function InboundEmailPanel({ slug }: { slug: string }) {
  const address = `docs+${slug}@docs.haulq.ai`;
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Same reasoning as TokenPanel: clipboard access can be denied, and the
      // address is selectable text regardless, so this is a convenience
      // failing rather than the feature failing.
      setCopied(false);
    }
  };

  return (
    <div className="border-l-2 border-brand bg-brand-50 p-4">
      <p className="field-label text-brand">Or send it by email</p>
      <p className="mt-2 max-w-prose text-sm text-slate">
        Forward a rate confirmation, BOL, or POD to this address and it lands
        here the same way a drag-and-drop upload does — sending the same email
        twice is harmless.
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <code className="num min-w-0 flex-1 border border-line bg-white px-3 py-2 text-xs break-all">
          {address}
        </code>
        <button className="hq-btn hq-btn-primary shrink-0" onClick={() => void copy()}>
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
    </div>
  );
}

/**
 * A carrier's own address, forwarding into the one above.
 *
 * Not a second inbound address HaulQ actually receives on — Postmark can only
 * be configured to accept mail for one domain per inbound stream, so giving
 * every carrier native receiving on their own domain would mean a dedicated
 * mail server per tenant (see the schema note on
 * `carrier_profiles.custom_docs_email`). Instead the carrier hands this
 * address to brokers and sets up a forwarding rule on their own mail
 * provider to the shared address above; a forwarded message still carries
 * the plus-address tag, so email intake needs no other change. This panel
 * just remembers what they told HaulQ they set up.
 */
function CustomEmailPanel({ profile }: { profile: CarrierProfile }) {
  const queryClient = useQueryClient();
  const current = profile.customDocsEmail;
  const [editing, setEditing] = useState(!current);
  const [draft, setDraft] = useState(current ?? '');

  const save = useMutation({
    mutationFn: (value: string | null) =>
      request<CarrierProfile>('/v1/org/profile', {
        method: 'PATCH',
        body: { customDocsEmail: value },
      }),
    onSuccess: () => {
      setEditing(false);
      void queryClient.invalidateQueries({ queryKey: ['profile'] });
    },
  });

  if (current && !editing) {
    return (
      <div className="border-l-2 border-line bg-wash p-4">
        <p className="field-label text-mute">Also comes in from your own address</p>
        <p className="mt-2 max-w-prose text-sm text-slate">
          Mail forwarded from <code className="num">{current}</code> lands here
          the same way a direct send does — as long as the forward is still set
          up on your end.
        </p>
        <button
          type="button"
          className="mt-3 text-xs text-brand underline"
          onClick={() => {
            setDraft(current);
            setEditing(true);
          }}
        >
          Change or remove
        </button>
      </div>
    );
  }

  return (
    <div className="border-l-2 border-line bg-wash p-4">
      <p className="field-label text-mute">Use your own email instead</p>
      <p className="mt-2 max-w-prose text-sm text-slate">
        Give brokers an address on your own domain —{' '}
        <code className="num">docs@yourcompany.com</code>, say — instead of the
        one above. Set up a forwarding rule for it on your mail provider that
        sends everything to the address above, then tell HaulQ what the
        address is so it shows up here.
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <input
          className="hq-input w-auto min-w-0 flex-1"
          type="email"
          placeholder="docs@yourcompany.com"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
        <button
          type="button"
          className="hq-btn hq-btn-primary"
          disabled={!draft.trim() || save.isPending}
          onClick={() => save.mutate(draft.trim())}
        >
          {save.isPending ? 'Saving…' : 'Save'}
        </button>
        {current && (
          <button
            type="button"
            className="hq-btn hq-btn-ghost text-bad"
            disabled={save.isPending}
            onClick={() => save.mutate(null)}
          >
            Remove
          </button>
        )}
      </div>
      <ErrorNote error={save.error} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Attaching
// ---------------------------------------------------------------------------

/**
 * Attach, or re-attach to a different load.
 *
 * Not gated on `document.loadId === null` — a rejected document is corrected
 * by pointing it at the right load, not by some separate "move" action, and
 * `attachToLoad` on the API side already treats re-attaching as a normal
 * write, not a special case. `choice` starts on the document's current load
 * so the dropdown reflects where it already is, and the button disables on
 * a no-op re-selection of the same one rather than firing a request that
 * would just return the row unchanged.
 */
function AttachControl({ document }: { document: DocumentRow }) {
  const queryClient = useQueryClient();
  const [choice, setChoice] = useState(document.loadId ?? '');

  const loads = useQuery({
    queryKey: ['loads'],
    queryFn: () => request<{ items: LoadOption[] }>('/v1/loads?limit=100'),
  });

  const attach = useMutation({
    mutationFn: (loadId: string) =>
      request(`/v1/documents/${document.id}/attach`, {
        method: 'POST',
        body: { loadId },
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['documents'] }),
  });

  const options = loads.data?.items ?? [];

  if (loads.isSuccess && options.length === 0) {
    return (
      <span className="text-xs text-mute">
        No loads yet — create one before attaching this.
      </span>
    );
  }

  return (
    <span className="flex flex-wrap items-center gap-2">
      <select
        aria-label={document.loadId ? 'Re-attach to a different load' : 'Attach to load'}
        className="border border-line bg-white px-2 py-1 text-sm"
        value={choice}
        onChange={(e) => setChoice(e.target.value)}
      >
        <option value="">Attach to…</option>
        {options.map((load) => (
          <option key={load.id} value={load.id}>
            {loadLabel(load)}
          </option>
        ))}
      </select>
      <button
        type="button"
        className="border border-line px-3 py-1 text-sm disabled:opacity-40"
        disabled={!choice || choice === document.loadId || attach.isPending}
        onClick={() => attach.mutate(choice)}
      >
        {attach.isPending ? 'Attaching…' : document.loadId ? 'Re-attach' : 'Attach'}
      </button>
      <ErrorNote error={attach.error} />
    </span>
  );
}

// ---------------------------------------------------------------------------
// The file itself
// ---------------------------------------------------------------------------

/**
 * Preview the bytes.
 *
 * Fetched through the API client rather than pointed at with a `src`, because
 * the request needs auth headers. The object URL is revoked when the panel
 * closes — a few unrevoked PDFs is a real leak on a dispatcher's tab that stays
 * open all day.
 */
function Preview({ document }: { document: DocumentRow }) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const current = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setUrl(null);
    setError(null);

    requestBlob(`/v1/documents/${document.id}/content`)
      .then((blob) => {
        if (cancelled) return;
        const next = URL.createObjectURL(blob);
        current.current = next;
        setUrl(next);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err);
      });

    return () => {
      cancelled = true;
      if (current.current) {
        URL.revokeObjectURL(current.current);
        current.current = null;
      }
    };
  }, [document.id]);

  if (error) return <ErrorNote error={error} />;
  if (!url) return <Empty>Loading the file…</Empty>;

  const isImage = (document.contentType ?? '').startsWith('image/');

  return isImage ? (
    <img
      src={url}
      alt={document.filename ?? 'Document'}
      className="max-h-[36rem] w-full border border-line object-contain"
    />
  ) : (
    <iframe
      src={url}
      title={document.filename ?? 'Document'}
      className="h-[36rem] w-full border border-line"
    />
  );
}

// ---------------------------------------------------------------------------
// The disagreement view
// ---------------------------------------------------------------------------

function Disagreements({ document }: { document: DocumentRow }) {
  if (!document.validation) {
    return (
      <Empty>
        {document.extractedAt
          ? 'Read, but not yet checked against a load.'
          : 'Not read yet. HaulQ checks a document against its load once it has been extracted.'}
      </Empty>
    );
  }

  const verdict = summarizeValidation(document.validation);

  return (
    <div>
      <p className="mb-3 text-sm">
        {verdict.outcome === 'validated' ? (
          <span className="text-ok">
            Everything on this document agrees with the load.
          </span>
        ) : (
          <span className="text-bad">{verdict.reason}</span>
        )}
      </p>

      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-line text-left">
            <th className="field-label py-2 text-mute">Field</th>
            <th className="field-label py-2 text-mute">Document says</th>
            <th className="field-label py-2 text-mute">Load says</th>
          </tr>
        </thead>
        <tbody>
          {document.validation.map((f) => (
            <tr key={f.field} className="border-b border-line last:border-0">
              <td className="py-2">
                {f.field}
                {!f.agrees && (
                  <span className="ml-2">
                    <Pill tone={f.severity === 'error' ? 'warn' : 'neutral'}>
                      {f.severity}
                    </Pill>
                  </span>
                )}
              </td>
              {/* Colour is never the only signal — the severity pill above
                  carries the same information as a word. */}
              <td className={`num py-2 ${f.agrees ? '' : 'text-bad'}`}>
                {f.documentValue ?? '—'}
              </td>
              <td className="num py-2">{f.loadValue ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Manual field entry — for a document automated reading couldn't get through
// ---------------------------------------------------------------------------

/** What a field's own extraction says was printed, or '' if it was never found. */
function originalRaw(document: DocumentRow, field: string): string {
  const found = document.extracted?.[field] as { raw?: unknown } | undefined;
  return typeof found?.raw === 'string' ? found.raw : '';
}

/**
 * Type in what a document says, for a kind the pipeline has field rules for.
 * Renders nothing for a kind with none (`pod`, `w9`, `insurance_certificate`,
 * `carrier_packet` and anything else `FIELD_NAMES_BY_KIND` has no entry
 * for) — there is nothing on those worth typing in.
 */
function ManualFieldsForm({ document }: { document: DocumentRow }) {
  const queryClient = useQueryClient();
  const names = FIELD_NAMES_BY_KIND[document.kind as keyof typeof FIELD_NAMES_BY_KIND] ?? [];
  const expected = EXPECTED_FIELDS_BY_KIND[document.kind as keyof typeof EXPECTED_FIELDS_BY_KIND] ?? [];

  const [drafts, setDrafts] = useState<Record<string, string>>(() =>
    Object.fromEntries(names.map((field) => [field, originalRaw(document, field)])),
  );

  // A document still sitting `received` has never been read at all, and an
  // expected field the extraction missed is exactly the case this form
  // exists for — both open the form without making someone go looking for
  // the toggle first.
  const missingExpected = expected.some(
    (field) => !document.extracted || !(field in document.extracted),
  );
  const [open, setOpen] = useState(document.status === 'received' || missingExpected);

  const save = useMutation({
    mutationFn: (fields: Record<string, string>) =>
      request(`/v1/documents/${document.id}/manual-fields`, {
        method: 'POST',
        body: { fields },
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['documents'] }),
  });

  if (names.length === 0) return null;

  if (!open) {
    return (
      <button
        type="button"
        className="text-xs text-brand underline"
        onClick={() => setOpen(true)}
      >
        Correct a field
      </button>
    );
  }

  // Only what actually changed goes on the wire. A blank draft is "leave this
  // alone", not "clear it" — there is no way to un-read a field this form
  // offers, only to add or correct one.
  const changed = Object.fromEntries(
    Object.entries(drafts).filter(([field, value]) => {
      const trimmed = value.trim();
      return trimmed !== '' && trimmed !== originalRaw(document, field);
    }),
  );

  return (
    <div className="mt-4 border-t border-line pt-4">
      <h4 className="field-label mb-2 text-mute">Type in what the document says</h4>
      <div className="grid gap-4 sm:grid-cols-2">
        {names.map((field) => {
          const meta = FIELD_METADATA[field];
          if (!meta) return null;
          const was = originalRaw(document, field);
          const draft = drafts[field] ?? '';
          const hint = was && draft.trim() !== was ? `Was: ${was}` : undefined;
          return (
            <Field key={field} label={meta.label} {...(hint ? { hint } : {})}>
              <input
                className="hq-input"
                {...(meta.type !== 'text'
                  ? { 'data-numeric': 'true', inputMode: meta.type === 'money' ? 'decimal' : 'numeric' }
                  : {})}
                value={draft}
                onChange={(e) =>
                  setDrafts((d) => ({ ...d, [field]: e.target.value }))
                }
              />
            </Field>
          );
        })}
      </div>
      <div className="mt-3 flex items-center gap-2">
        <button
          type="button"
          className="hq-btn hq-btn-primary disabled:opacity-40"
          disabled={Object.keys(changed).length === 0 || save.isPending}
          onClick={() => save.mutate(changed)}
        >
          {save.isPending ? 'Saving…' : 'Save'}
        </button>
        <ErrorNote error={save.error} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The screen
// ---------------------------------------------------------------------------

function Detail({ document }: { document: DocumentRow }) {
  return (
    <div className="border-t border-line bg-wash px-5 py-5">
      <div className="grid gap-6 lg:grid-cols-2">
        <div>
          <h3 className="field-label mb-2 text-mute">The document</h3>
          <Preview document={document} />
          <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-slate">
            <dt className="text-mute">Received</dt>
            <dd>{when(document.receivedAt)}</dd>
            <dt className="text-mute">Source</dt>
            <dd>{document.source.replace(/_/g, ' ')}</dd>
            {document.receivedFrom && (
              <>
                <dt className="text-mute">From</dt>
                <dd>{document.receivedFrom}</dd>
              </>
            )}
            {document.extractorVersion && (
              <>
                <dt className="text-mute">Read by</dt>
                <dd className="num">{document.extractorVersion}</dd>
              </>
            )}
            <dt className="text-mute">Digest</dt>
            <dd className="num" title={document.sha256}>
              {document.sha256.slice(0, 12)}…
            </dd>
          </dl>
        </div>

        <div>
          <h3 className="field-label mb-2 text-mute">Against the load</h3>
          <Disagreements document={document} />
          <ManualFieldsForm document={document} />
        </div>
      </div>
    </div>
  );
}

export function DocumentsScreen() {
  const session = useSession();
  const [view, setView] = useState<'inbox' | 'all'>('inbox');
  const [open, setOpen] = useState<string | null>(null);

  const query = useQuery({
    queryKey: ['documents', view],
    queryFn: () =>
      request<{ items: DocumentRow[] }>(
        view === 'inbox' ? '/v1/documents?unattached=true' : '/v1/documents',
      ),
    enabled: Boolean(session?.orgId),
  });

  const counts = useQuery({
    queryKey: ['documents', 'counts'],
    queryFn: () => request<{ counts: Record<string, number> }>('/v1/documents/counts'),
    enabled: Boolean(session?.orgId),
  });

  // Same query key Profile.tsx uses — the two screens share one cache entry
  // rather than each fetching the org profile on its own.
  const profile = useQuery({
    queryKey: ['profile'],
    queryFn: () => request<CarrierProfile>('/v1/org/profile'),
    enabled: Boolean(session?.orgId),
  });

  const items = query.data?.items ?? [];
  const rejected = counts.data?.counts['rejected'] ?? 0;

  return (
    <div className="space-y-6">
      <Dropzone />

      {profile.data?.slug && <InboundEmailPanel slug={profile.data.slug} />}
      {profile.data && <CustomEmailPanel profile={profile.data} />}

      {rejected > 0 && (
        <p className="border-l-2 border-bad bg-bad-50 px-3 py-2 text-sm text-bad">
          {rejected === 1
            ? '1 document does not match its load.'
            : `${rejected} documents do not match their loads.`}{' '}
          Those are the ones worth opening first.
        </p>
      )}

      <Card
        title={view === 'inbox' ? 'Needs a load' : 'All documents'}
        action={
          <span className="flex gap-1">
            {(['inbox', 'all'] as const).map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => setView(v)}
                aria-pressed={view === v}
                className={`field-label px-3 py-1 ${
                  view === v ? 'border-b-2 border-brand text-ink' : 'text-mute'
                }`}
              >
                {v === 'inbox' ? 'Needs a load' : 'All'}
              </button>
            ))}
          </span>
        }
      >
        <ErrorNote error={query.error} />

        {query.isLoading && <Empty>Loading…</Empty>}

        {query.isSuccess && items.length === 0 && (
          <Empty>
            {view === 'inbox'
              ? 'Nothing waiting. Every document you have is on a load.'
              : 'No documents yet. Add one above, and email intake will fill this in once it is switched on.'}
          </Empty>
        )}

        {items.length > 0 && (
          <ul className="divide-y divide-line">
            {items.map((doc) => (
              <li key={doc.id}>
                <div className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3">
                  <button
                    type="button"
                    className="min-w-0 flex-1 text-left"
                    onClick={() => setOpen(open === doc.id ? null : doc.id)}
                    aria-expanded={open === doc.id}
                  >
                    <span className="block truncate">
                      {doc.filename ?? 'Untitled'}
                    </span>
                    <span className="block text-xs text-mute">
                      {documentKindLabel(doc.kind)} · {when(doc.receivedAt)}
                      {doc.byteSize ? ` · ${fileSize(doc.byteSize)}` : ''}
                    </span>
                  </button>

                  <Pill tone={STATUS_TONE[doc.status] ?? 'neutral'}>{doc.status}</Pill>

                  <AttachControl document={doc} />
                </div>

                {open === doc.id && <Detail document={doc} />}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
