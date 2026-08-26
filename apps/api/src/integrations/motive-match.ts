/**
 * Suggesting which Motive vehicle is which HaulQ truck.
 *
 * The manual alternative — a carrier opening the Motive dashboard, finding
 * a numeric vehicle id, and typing it into a HaulQ text box — is the actual
 * friction "hands-off onboarding" is about. Most fleets already name a
 * Motive vehicle the same thing they call the truck ("12", "Unit 12"), so a
 * normalized-string match against `trucks.label` clears the common case
 * without a carrier doing anything. What it must never do is guess wrong
 * silently: this only *suggests* a match for a human to confirm — see
 * `routes/integrations.ts`'s vehicles route and `SetTruckMotiveVehicleSchema`,
 * the same confirm step a manual pick already goes through.
 */

const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/** The bare digits, leading zeros stripped — "Unit 012" and "12" both become "12". */
const digitsOf = (s: string) => s.replace(/\D/g, '').replace(/^0+(?=\d)/, '');

export interface MatchableTruck {
  id: string;
  label: string;
  motiveVehicleId: number | null;
}

export interface MatchableVehicle {
  id: number;
  number: string;
}

export interface MotiveMatchSuggestion {
  truckId: string;
  truckLabel: string;
  motiveVehicleId: number;
  motiveVehicleNumber: string;
}

/**
 * One suggestion per unmatched truck, at most — never two trucks pointed at
 * the same vehicle, and never a truck that already has a match touched.
 * Exact normalized equality wins over a bare-digit match; first truck to
 * claim a vehicle in input order keeps it, so a genuine collision (two
 * trucks both plausibly "12") surfaces as one suggestion and one truck left
 * for the carrier to pick manually, rather than two guesses either of which
 * could be wrong.
 */
export function suggestMotiveMatches(
  trucks: MatchableTruck[],
  vehicles: MatchableVehicle[],
): MotiveMatchSuggestion[] {
  const claimed = new Set(
    trucks.map((t) => t.motiveVehicleId).filter((id): id is number => id !== null),
  );

  const unmatched = trucks.filter((t) => t.motiveVehicleId === null);
  const suggestions: MotiveMatchSuggestion[] = [];

  for (const truck of unmatched) {
    const truckNorm = normalize(truck.label);
    const truckDigits = digitsOf(truck.label);

    const exact = vehicles.find((v) => !claimed.has(v.id) && normalize(v.number) === truckNorm);
    const byDigits =
      !exact && truckDigits
        ? vehicles.find((v) => !claimed.has(v.id) && digitsOf(v.number) === truckDigits)
        : undefined;

    const match = exact ?? byDigits;
    if (!match) continue;

    claimed.add(match.id);
    suggestions.push({
      truckId: truck.id,
      truckLabel: truck.label,
      motiveVehicleId: match.id,
      motiveVehicleNumber: match.number,
    });
  }

  return suggestions;
}
