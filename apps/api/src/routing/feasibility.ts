/**
 * 3a — single-load feasibility.
 *
 * PHASE_3_PLAN.md section 4's 3a exit gate, split into what this file owns:
 * given a computed route, a truck and a load's stops, decide feasible or
 * infeasible and name the one constraint that decided it. The route call and
 * the HTTP surface live elsewhere (`integrations/here.ts`,
 * `routes/feasibility.ts`); this file is the pure comparison so it can be
 * tested without a network call or a database.
 *
 * Two checks, in the order section 3 names them: a truck-legal restriction
 * HERE could not route around, then a stop-window overrun. HOS is
 * deliberately absent — section 7 leaves "does Phase 3 pull HOS data" open,
 * and shipping this file as if that question were answered would be exactly
 * the silent assumption section 5's third reason warns against. Every
 * verdict this file returns carries `hoursChecked: false` so nothing
 * downstream can mistake an unchecked hour for a checked one.
 */

import type { Restriction, Route } from '../integrations/routing-provider.ts';

export interface FeasibilityStop {
  seq: number;
  windowEnd: Date | null;
}

export interface FeasibilityConstraint {
  code: string;
  message: string;
}

export interface FeasibilityVerdict {
  feasible: boolean;
  hoursChecked: false;
  decidingConstraint: FeasibilityConstraint | null;
  routeMiles: number;
  estimatedArrivalAt: Date;
}

/**
 * The delivery stop's window is the one that matters for "can this truck
 * make it" — a pickup window overrun means the truck missed the load
 * entirely, which is a dispatch problem this check does not model; it
 * assumes the truck is departing the first stop already loaded. `stops` is
 * expected in `seq` order, same as `load_stops` is read everywhere else.
 */
function decidingStopWindow(stops: FeasibilityStop[]): FeasibilityStop | undefined {
  return [...stops].reverse().find((s) => s.windowEnd !== null);
}

export function evaluateLoadFeasibility(
  route: Route,
  restrictions: Restriction[],
  stops: FeasibilityStop[],
): FeasibilityVerdict {
  const base = { hoursChecked: false as const, routeMiles: route.miles, estimatedArrivalAt: route.arrivalAt };

  // Truck-legal first — a route HERE could not run is infeasible regardless
  // of timing, and it is the more specific reason when both are true.
  const [restriction] = restrictions;
  if (restriction) {
    return {
      ...base,
      feasible: false,
      decidingConstraint: { code: restriction.code, message: restriction.description },
    };
  }

  const deciding = decidingStopWindow(stops);
  if (deciding?.windowEnd && route.arrivalAt > deciding.windowEnd) {
    return {
      ...base,
      feasible: false,
      decidingConstraint: {
        code: 'stop_window_overrun',
        message: `Estimated arrival misses stop ${deciding.seq}'s appointment window, which ends ${deciding.windowEnd.toISOString()}.`,
      },
    };
  }

  return { ...base, feasible: true, decidingConstraint: null };
}
