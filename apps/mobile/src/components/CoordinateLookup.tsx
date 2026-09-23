/**
 * Turns a stop's address into coordinates, with no tap needed. The mobile
 * copy of web's `CoordinateLookup` in `apps/web/src/routes/Loads.tsx`, with
 * the same behaviour:
 *
 * - The lookup fires on its own once a stop has a city and a two-letter
 *   state, after a typing pause, and fills the coordinates straight from the
 *   top match.
 * - When the top match isn't a clear winner (`isClearGeocodeWinner`), the
 *   other candidates stay listed underneath as corrections. A bad guess
 *   always has a visible fix next to it, which is what protects feasibility
 *   checks from a wrong location (`here-geocode.ts`'s module note).
 * - Once coordinates exist, however they got there, it stops firing, so a
 *   manual entry is never silently overwritten.
 */

import { isClearGeocodeWinner, type GeocodeCandidate } from '@haulq/client';
import { useMutation } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { request } from '../lib/api.ts';
import { ErrorNote } from './ui.tsx';

const AUTO_LOOKUP_DEBOUNCE_MS = 700;

export interface LookupAddress {
  addressLine1?: string;
  city: string;
  state: string;
  postalCode?: string;
}

export function CoordinateLookup({
  address,
  hasCoordinates,
  onPick,
}: {
  address: LookupAddress;
  hasCoordinates: boolean;
  onPick: (candidate: GeocodeCandidate) => void;
}) {
  const [alternates, setAlternates] = useState<GeocodeCandidate[]>([]);
  const [resolvedLabel, setResolvedLabel] = useState<string | null>(null);
  const [noMatch, setNoMatch] = useState(false);

  const canLookup = address.city.trim() !== '' && address.state.trim().length === 2;

  const lookup = useMutation({
    mutationFn: () =>
      request<{ candidates: GeocodeCandidate[] }>(
        `/v1/geocode?${new URLSearchParams({
          ...(address.addressLine1 ? { addressLine1: address.addressLine1 } : {}),
          city: address.city,
          state: address.state,
          ...(address.postalCode ? { postalCode: address.postalCode } : {}),
        })}`,
      ),
    onSuccess: (res) => {
      const [top] = res.candidates;
      if (!top) {
        setNoMatch(true);
        setResolvedLabel(null);
        setAlternates([]);
        return;
      }
      setNoMatch(false);
      setResolvedLabel(top.label);
      setAlternates(isClearGeocodeWinner(res.candidates) ? [] : res.candidates.filter((c) => c !== top));
      onPick(top);
    },
  });

  useEffect(() => {
    if (!canLookup || hasCoordinates || lookup.isPending) return;
    const id = setTimeout(() => lookup.mutate(), AUTO_LOOKUP_DEBOUNCE_MS);
    return () => clearTimeout(id);
    // Every address field, not just city/state: a street or postal code
    // typed after the first lookup is exactly what should sharpen it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address.addressLine1, address.city, address.state, address.postalCode, hasCoordinates]);

  const pick = (c: GeocodeCandidate) => {
    setResolvedLabel(c.label);
    setAlternates((prev) => prev.filter((a) => a !== c));
    onPick(c);
  };

  return (
    <div className="space-y-1.5 text-xs">
      {resolvedLabel ? (
        <p className="text-mute">
          Matched to <span className="text-slate">{resolvedLabel}</span>.{' '}
          <button
            type="button"
            className="text-brand underline disabled:text-mute disabled:no-underline"
            disabled={!canLookup || lookup.isPending}
            onClick={() => {
              setResolvedLabel(null);
              setAlternates([]);
              lookup.mutate();
            }}
          >
            Search again
          </button>
        </p>
      ) : (
        <button
          type="button"
          className="text-brand underline disabled:text-mute disabled:no-underline"
          disabled={!canLookup || lookup.isPending}
          onClick={() => {
            setNoMatch(false);
            lookup.mutate();
          }}
        >
          {lookup.isPending ? 'Finding coordinates…' : 'Find coordinates from this address'}
        </button>
      )}
      <ErrorNote error={lookup.error} />
      {noMatch && <p className="text-mute">No address matched. Enter coordinates by hand, or adjust the address.</p>}
      {alternates.length > 0 && (
        <div className="space-y-1 border-l-2 border-line pl-2">
          <p className="text-mute">Not a clear match. If it's wrong, tap the right one:</p>
          {alternates.map((c, i) => (
            <button key={i} type="button" className="block text-left text-slate underline decoration-dotted" onClick={() => pick(c)}>
              {c.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
