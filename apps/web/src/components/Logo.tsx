/**
 * HaulQ wordmark.
 *
 * The same two prepared rasters the marketing site uses, both with transparent
 * backgrounds:
 *   /logo.png        navy wordmark, for light surfaces
 *   /logo-white.png  white wordmark with the orange tail, for dark surfaces
 *
 * The files are COPIED from `haulq-site/public/` rather than imported, for the
 * reason `styles.css` records for the brand tokens: the two builds are
 * deliberately independent (Astro on a Cloudflare Worker, Vite on Render) and a
 * copy fix must not be able to break the app — build plan section 6. If the
 * artwork changes, both `public/` folders change. That is the trade.
 *
 * This is the ONLY place the app references the logo, mirroring the convention
 * `haulq-site/src/components/Logo.astro` holds for the marketing site (build
 * plan section 15). If a vector version ever arrives, swap the <img> for an
 * inline <svg> in these two files and nowhere else.
 *
 * `width`/`height` are the real pixel dimensions (900x250, 3.6:1). They are
 * declared so the browser reserves the right box before the image loads —
 * without them the header reflows on every cold load.
 */
export function Logo({
  className = '',
  tone = 'dark',
}: {
  className?: string;
  tone?: 'dark' | 'light';
}) {
  return (
    <img
      src={tone === 'light' ? '/logo-white.png' : '/logo.png'}
      alt="HaulQ"
      width={900}
      height={250}
      decoding="async"
      className={`h-8 w-auto ${className}`}
    />
  );
}
