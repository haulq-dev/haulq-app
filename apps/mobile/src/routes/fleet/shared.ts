/** A credential date as a person reads it: "Mar 4, 2027". Read in UTC, the way it was written (noon UTC). */
export function credentialDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}
