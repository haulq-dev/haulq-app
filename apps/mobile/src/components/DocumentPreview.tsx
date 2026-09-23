/**
 * The file itself: fetched with auth, then shown inline.
 *
 * It can't be an `<img src>` pointing at the API, because the request needs
 * the tenant header and a bearer token. So the bytes come through
 * `requestBlob` and become an object URL, which is revoked when the preview
 * goes away.
 *
 * **PDFs differ by platform.** iOS's WKWebView renders a PDF in an iframe
 * natively. Android's WebView does not render PDFs at all. There, pdf.js draws
 * each page to a canvas. It is imported only on Android, so it never enters
 * the iOS bundle's startup path.
 */

import { Capacitor } from '@capacitor/core';
import { useEffect, useRef, useState } from 'react';
import { requestBlob } from '../lib/api.ts';
import { ErrorNote } from './ui.tsx';

export function DocumentPreview({ id, contentType, filename }: { id: string; contentType: string | null; filename: string | null }) {
  const [blob, setBlob] = useState<Blob | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    let cancelled = false;
    let made: string | null = null;
    setBlob(null);
    setUrl(null);
    setError(null);
    requestBlob(`/v1/documents/${id}/content`)
      .then((b) => {
        if (cancelled) return;
        made = URL.createObjectURL(b);
        setBlob(b);
        setUrl(made);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err);
      });
    return () => {
      cancelled = true;
      if (made) URL.revokeObjectURL(made);
    };
  }, [id]);

  if (error) return <ErrorNote error={error} />;
  if (!url || !blob) return <p className="py-8 text-center text-sm text-mute">Loading the file…</p>;

  const type = contentType ?? blob.type;
  const label = filename ?? 'Document';

  if (type.startsWith('image/')) {
    return <img src={url} alt={label} className="max-h-[70vh] w-full rounded-[var(--radius-sm)] bg-wash object-contain" />;
  }
  if (Capacitor.getPlatform() === 'android') return <PdfPages blob={blob} />;
  return <iframe src={url} title={label} className="h-[70vh] w-full rounded-[var(--radius-sm)] bg-wash" />;
}

/** Up to this many pages drawn. A 40-page carrier packet on a phone is a list nobody scrolls. */
const MAX_PAGES = 10;

function PdfPages({ blob }: { blob: Blob }) {
  const host = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<{ total: number } | { error: unknown } | null>(null);

  useEffect(() => {
    let cancelled = false;
    const container = host.current;
    void (async () => {
      try {
        // The legacy build carries the polyfills older Android WebViews need.
        const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
        const worker = await import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url');
        pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
        const doc = await pdfjs.getDocument({ data: new Uint8Array(await blob.arrayBuffer()) }).promise;
        if (cancelled || !container) return;
        container.replaceChildren();
        const width = container.clientWidth || 360;
        for (let n = 1; n <= Math.min(doc.numPages, MAX_PAGES); n += 1) {
          const page = await doc.getPage(n);
          const base = page.getViewport({ scale: 1 });
          const viewport = page.getViewport({ scale: (width / base.width) * window.devicePixelRatio });
          const canvas = document.createElement('canvas');
          canvas.width = viewport.width;
          canvas.height = viewport.height;
          canvas.style.width = '100%';
          canvas.className = 'rounded-[var(--radius-sm)] bg-white';
          const context = canvas.getContext('2d');
          if (!context) continue;
          await page.render({ canvasContext: context, viewport }).promise;
          if (cancelled) return;
          container.appendChild(canvas);
        }
        setState({ total: doc.numPages });
      } catch (error) {
        if (!cancelled) setState({ error });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [blob]);

  return (
    <div className="space-y-2">
      <div ref={host} className="space-y-2" />
      {state === null && <p className="py-8 text-center text-sm text-mute">Drawing the pages…</p>}
      {state && 'error' in state && <ErrorNote error={state.error} />}
      {state && 'total' in state && state.total > MAX_PAGES && (
        <p className="text-xs text-mute">Showing the first {MAX_PAGES} of {state.total} pages.</p>
      )}
    </div>
  );
}
