/** "Oct 12", or "Oct 12, 2025" when it isn't this year. */
export function shortDate(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' as const } : {}),
  });
}
