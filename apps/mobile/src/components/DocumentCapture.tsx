/**
 * Take a photo of paperwork, or pick a file, and send it.
 *
 * Two plain `<input type="file">`s rather than a native camera plugin. With
 * `capture="environment"`, iOS's WKWebView and Capacitor's Android WebView
 * both open the rear camera, and without it they offer the photo library and
 * Files, PDFs included. That covers a BOL at the dock and a rate con
 * forwarded as a PDF, with nothing new to keep in step across two native
 * projects. iOS needs `NSCameraUsageDescription` in Info.plist for the camera,
 * and has it. Android's WebView launches the camera intent through
 * Capacitor's FileProvider.
 *
 * `kinds`, when given, asks "what is it?" before the camera opens, so a
 * driver's POD arrives labelled as a POD instead of relying on the classifier
 * to read a crumpled photo.
 */

import { DOCUMENT_ACCEPT, queryKeys } from '@haulq/client';
import { useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { successFeedback, tapFeedback } from '../lib/haptics.ts';
import { uploadDocuments, type UploadResult, type UploadTarget } from '../lib/upload.ts';
import { ErrorNote } from './ui.tsx';

export function DocumentCapture({
  loadId,
  kinds,
  onUploaded,
}: {
  loadId?: string;
  kinds?: ReadonlyArray<{ kind: string; label: string }>;
  onUploaded?: (result: UploadResult) => void;
}) {
  const queryClient = useQueryClient();
  const camera = useRef<HTMLInputElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const [kind, setKind] = useState<string>(kinds?.[0]?.kind ?? '');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<UploadResult | null>(null);

  const send = async (list: FileList | null) => {
    if (!list?.length) return;
    setBusy(true);
    setResult(null);
    const target: UploadTarget = { ...(loadId ? { loadId } : {}), ...(kind ? { kind } : {}) };
    const res = await uploadDocuments(Array.from(list), target);
    setResult(res);
    setBusy(false);
    if (res.added + res.already > 0) void successFeedback();
    await queryClient.invalidateQueries({ queryKey: queryKeys.documents });
    onUploaded?.(res);
  };

  return (
    <div className="space-y-3">
      {kinds && (
        <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="What is it?">
          {kinds.map((k) => (
            <button
              key={k.kind}
              type="button"
              role="radio"
              aria-checked={kind === k.kind}
              onClick={() => setKind(k.kind)}
              className={`hq-pill px-3 py-1.5 text-[0.8125rem] ${
                kind === k.kind ? 'bg-ink text-white' : 'bg-card text-slate shadow-[inset_0_0_0_1px_var(--color-line)]'
              }`}
            >
              {k.label}
            </button>
          ))}
        </div>
      )}

      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          className="hq-btn hq-btn-brand"
          disabled={busy}
          onClick={() => {
            void tapFeedback();
            camera.current?.click();
          }}
        >
          {busy ? 'Sending…' : 'Take photo'}
        </button>
        <button type="button" className="hq-btn hq-btn-ghost" disabled={busy} onClick={() => picker.current?.click()}>
          Choose file
        </button>
      </div>

      <input
        ref={camera}
        type="file"
        accept="image/*"
        capture="environment"
        className="sr-only"
        aria-label="Take a photo"
        tabIndex={-1}
        onChange={(e) => {
          void send(e.target.files);
          e.target.value = '';
        }}
      />
      <input
        ref={picker}
        type="file"
        accept={DOCUMENT_ACCEPT}
        multiple
        className="sr-only"
        aria-label="Choose files"
        tabIndex={-1}
        onChange={(e) => {
          void send(e.target.files);
          e.target.value = '';
        }}
      />

      {result?.summary && <p className="text-sm text-ok">{result.summary}.</p>}
      {result?.failed.map((f) => (
        <div key={f.name} className="space-y-1">
          <p className="text-xs text-mute">{f.name}</p>
          <ErrorNote error={f.error} />
        </div>
      ))}
    </div>
  );
}
