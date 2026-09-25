import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  formatMiles,
  formatRating,
  groupPlaces,
  mapsUrl,
  MECHANIC_RADIUS_OPTIONS,
  MECHANIC_SEARCHES,
  searchOrigins,
  STOP_RADIUS_OPTIONS,
  telHref,
  tidyAddress,
  yelpStarKey,
  type NearbyPlace,
} from './places.ts';

const place = (over: Partial<NearbyPlace> = {}): NearbyPlace => ({
  name: 'Pilot',
  category: 'truckStop',
  categoryLabel: 'Truck stop',
  lat: 37.5,
  lng: -97.3,
  distanceMiles: 2.4,
  address: null,
  ...over,
});

describe('nearby stops', () => {
  it('groups places by kind in the order a driver looks for them, nearest first, leaving out empty kinds', () => {
    const groups = groupPlaces([
      place({ name: 'Far scale', category: 'weighStation', distanceMiles: 9 }),
      place({ name: 'Second stop', distanceMiles: 6 }),
      place({ name: 'Fuel', category: 'fuelStation', distanceMiles: 1 }),
      place({ name: 'First stop', distanceMiles: 2 }),
    ]);

    assert.deepEqual(groups.map((g) => g.label), ['Truck stops', 'Fuel', 'Weigh stations']);
    assert.deepEqual(groups[0]!.places.map((p) => p.name), ['First stop', 'Second stop']);
  });

  it('has nothing to say for a stop with no places', () => {
    assert.deepEqual(groupPlaces([]), []);
  });

  it('offers radii within what the API allows', () => {
    assert.ok(Math.max(...STOP_RADIUS_OPTIONS) <= 50);
    assert.ok(Math.max(...MECHANIC_RADIUS_OPTIONS) <= 24);
  });

  it('drops the name and the country from an address that repeats them', () => {
    assert.equal(tidyAddress('QuikTrip', 'QuikTrip, 1010 E Douglas Ave, Wichita, KS 67214, United States'), '1010 E Douglas Ave, Wichita, KS 67214');
    assert.equal(tidyAddress('Pilot', '123 Highway Dr, Topeka, KS'), '123 Highway Dr, Topeka, KS');
    assert.equal(tidyAddress('Pilot', null), null);
    assert.equal(tidyAddress('Pilot', 'Pilot, United States'), null);
  });

  it('formats distances and builds a map link', () => {
    assert.equal(formatMiles(2.44), '2.4 mi');
    assert.equal(formatMiles(12.6), '13 mi');
    const url = mapsUrl(place({ name: 'Love’s #4', lat: 37.5, lng: -97.3 }));
    assert.ok(url.startsWith('https://www.google.com/maps/search/?api=1&query='));
    assert.ok(url.includes('37.5'));
    assert.ok(!url.includes(' '), 'encoded');
  });
});

describe('repair shops', () => {
  it('says how a shop is rated, or that it is not', () => {
    assert.equal(formatRating({ rating: 4.5, reviewCount: 123 }), '4.5 (123 reviews)');
    assert.equal(formatRating({ rating: 5, reviewCount: 1 }), '5.0 (1 review)');
    assert.equal(formatRating({ rating: null, reviewCount: 0 }), 'Not rated');
  });

  it('gives every shortcut the Yelp categories that mean the right kind of business', () => {
    for (const s of MECHANIC_SEARCHES) {
      assert.match(s.categories, /^[a-z0-9_]+(,[a-z0-9_]+)*$/, s.label + ' has Yelp-shaped categories');
      assert.ok(s.query.length > 0 && s.query.length <= 100);
    }
    // A towing search must not be limited to garages, which is what a fixed autorepair category did.
    assert.equal(MECHANIC_SEARCHES.find((s) => s.label === 'Towing')!.categories, 'towing');
  });

  it('picks the Yelp star image by rounding to the nearest half star, with its irregular half-star names', () => {
    assert.equal(yelpStarKey(5), '5');
    assert.equal(yelpStarKey(4.8), '5', 'Yelp ratings arrive as decimals');
    assert.equal(yelpStarKey(4.5), '4_half');
    assert.equal(yelpStarKey(4.2), '4');
    assert.equal(yelpStarKey(2.5), '2_half');
    assert.equal(yelpStarKey(1.5), '2_1_half');
    assert.equal(yelpStarKey(0.5), 'half');
    assert.equal(yelpStarKey(0), '0');
    assert.equal(yelpStarKey(7), '5', 'out of range is held to the scale');
  });

  it('shows no stars for a business Yelp has not rated', () => {
    assert.equal(yelpStarKey(null), null);
    assert.equal(yelpStarKey(Number.NaN), null);
  });

  it('makes a number a phone can dial, or nothing', () => {
    assert.equal(telHref('(316) 555-0142'), 'tel:3165550142');
    assert.equal(telHref('+1 316 555 0142'), 'tel:+13165550142');
    assert.equal(telHref(null), null);
    assert.equal(telHref('n/a'), null);
  });

  it('starts from where the truck is, then each stop with coordinates, and skips one without', () => {
    const origins = searchOrigins({
      truck: { label: 'Truck 4', currentCity: 'Salina', currentState: 'KS', currentLat: 38.8, currentLng: -97.6 },
      stops: [
        { seq: 2, type: 'delivery', city: 'Denver', state: 'CO', lat: 39.7, lng: -105 },
        { seq: 1, type: 'pickup', city: 'Wichita', state: 'KS', lat: 37.7, lng: -97.3 },
        { seq: 3, type: 'delivery', city: 'Boulder', state: 'CO', lat: null, lng: null },
      ],
    });

    assert.deepEqual(origins.map((o) => o.key), ['truck', 'stop-1', 'stop-2']);
    assert.match(origins[0]!.label, /Truck 4.*Salina, KS/);
    assert.equal(origins[1]!.label, 'Pickup: Wichita, KS');
  });

  it('has no truck origin without a reported position', () => {
    assert.deepEqual(searchOrigins({ truck: null, stops: [] }), []);
    assert.deepEqual(
      searchOrigins({ truck: { label: 'T', currentCity: null, currentState: null, currentLat: null, currentLng: null }, stops: [] }),
      [],
    );
  });
});
