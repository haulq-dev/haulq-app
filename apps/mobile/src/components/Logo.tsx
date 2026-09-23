/**
 * HaulQ wordmark. Same file, same reasoning, as `apps/web/src/components/Logo.tsx`
 * — copied rather than imported so a shared-package fix cannot break this
 * deploy. If the artwork changes, every copy changes; see that file's note.
 */
export function Logo({ className = '' }: { className?: string }) {
  return (
    <img
      src="/logo.png"
      alt="HaulQ"
      width={900}
      height={250}
      decoding="async"
      className={`h-7 w-auto ${className}`}
    />
  );
}
