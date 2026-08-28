// KEYLESS GEOCODER — the Photon adapter that keeps place search working
// without a Google key.
//
// The whole value of this module is that its output is INDISTINGUISHABLE to
// everything downstream: `geocodeNavigationMode` and the framing code must keep
// making the same decisions they make on a Google result. So these tests check
// the translation, not the network — three things that go wrong silently:
//
//   1. Photon's `extent` is [west, north, east, south]. Read as [w,s,e,n] it
//      yields an inverted-but-plausible box, and the camera frames nonsense.
//   2. Photon calls a national park `type: 'other'`. Dropped, a park geocodes
//      as a precise place and the camera lands on a random patch of grass —
//      the exact bug geocodeNavigationMode's area types exist to prevent.
//   3. A miss must be `null`, never a throw: both callers read null as
//      "not found" and a throw would surface as a broken search box.
//
// Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  geocodeKeyless,
  normalizePhotonFeature,
  photonExtentToBounds,
  photonResultLabel,
  photonResultTypes,
  photonSearchUrl,
} from './keylessGeocoder.js';
import { geocodeNavigationMode } from './locations.js';

/** Photon's real answer for "Hanoi", trimmed to the fields we consume. */
const HANOI = {
  geometry: { type: 'Point', coordinates: [105.854041, 21.0283334] },
  properties: {
    osm_key: 'place',
    osm_value: 'city',
    type: 'city',
    name: 'Hà Nội',
    country: 'Việt Nam',
    countrycode: 'VN',
    extent: [105.2889615, 21.3854176, 106.0200407, 20.5645154],
  },
};

test('a city normalizes into the shape the Google path produces', () => {
  const result = normalizePhotonFeature(HANOI);

  assert.equal(result.lat, 21.0283334);
  assert.equal(result.lng, 105.854041);
  assert.equal(result.label, 'Hà Nội, Việt Nam');
  assert.deepEqual(result.types, ['locality']);
  assert.equal(geocodeNavigationMode(result.types), 'city-overview');
});

test('the extent is read as [west, north, east, south], not as [w,s,e,n]', () => {
  const bounds = photonExtentToBounds(HANOI.properties.extent);

  // Hanoi spans roughly 20.56..21.39 N and 105.29..106.02 E. A [w,s,e,n] read
  // would put north at 21.385 and south at 106.02 — a box that still has four
  // finite numbers and would frame the camera at nothing.
  assert.equal(bounds.southwest.lat, 20.5645154);
  assert.equal(bounds.northeast.lat, 21.3854176);
  assert.equal(bounds.southwest.lng, 105.2889615);
  assert.equal(bounds.northeast.lng, 106.0200407);
  assert.ok(bounds.northeast.lat > bounds.southwest.lat, 'north must exceed south');
  assert.ok(bounds.northeast.lng > bounds.southwest.lng, 'east must exceed west');
});

test('a malformed or out-of-range extent yields no bounds rather than a bad box', () => {
  assert.equal(photonExtentToBounds(undefined), null);
  assert.equal(photonExtentToBounds([1, 2, 3]), null);
  assert.equal(photonExtentToBounds([0, 95, 10, -95]), null, 'latitude past the pole');
  assert.equal(photonExtentToBounds([-200, 10, 10, 0]), null, 'longitude past the antimeridian');
});

test('area features keep an area type so the camera frames them, not a rooftop', () => {
  // Every row is a real Photon answer, captured from the live service. The
  // lake rows are why: Photon tags water as `water=lake`, not `natural=water`,
  // and the guess cost a camera 26 m over Hoan Kiem Lake.
  const cases = [
    [{ type: 'other', osm_key: 'water', osm_value: 'lake' }, 'natural_feature', 'area-overview'],
    [{ type: 'other', osm_key: 'leisure', osm_value: 'park' }, 'park', 'area-overview'],
    [{ type: 'other', osm_key: 'place', osm_value: 'region' }, 'natural_feature', 'area-overview'],
    [{ type: 'other', osm_key: 'natural', osm_value: 'peak' }, 'natural_feature', 'area-overview'],
    [{ type: 'other', osm_key: 'waterway', osm_value: 'river' }, 'natural_feature', 'area-overview'],
    [{ type: 'house', osm_key: 'aeroway', osm_value: 'aerodrome' }, 'airport', 'area-overview'],
    [{ type: 'house', osm_key: 'amenity', osm_value: 'university' }, 'university', 'area-overview'],
    [{ type: 'street', osm_key: 'highway', osm_value: 'motorway' }, 'route', 'street-corridor'],
    [{ type: 'country', osm_key: 'place', osm_value: 'country' }, 'country', 'region-overview'],
    [{ type: 'state', osm_key: 'place', osm_value: 'state' }, 'administrative_area_level_1', 'region-overview'],
    [{ type: 'district', osm_key: 'place', osm_value: 'suburb' }, 'sublocality', 'neighborhood-close'],
  ];

  for (const [properties, expectedType, expectedMode] of cases) {
    const types = photonResultTypes(properties);
    assert.ok(
      types.includes(expectedType),
      `${properties.osm_key}=${properties.osm_value} must carry ${expectedType}, got ${JSON.stringify(types)}`,
    );
    assert.equal(geocodeNavigationMode(types), expectedMode);
  }
});

test('a tag rule wins over the coarse class — a town square is not a city', () => {
  // Photon reports Times Square and Quang truong Ba Dinh as place=square with
  // type: 'locality'. Falling through to the coarse class framed a plaza as if
  // it were a whole city.
  const square = { type: 'locality', osm_key: 'place', osm_value: 'square' };
  assert.deepEqual(photonResultTypes(square), []);
  assert.equal(geocodeNavigationMode(photonResultTypes(square)), 'precise-place');
});

test('an ordinary building stays a precise place', () => {
  const types = photonResultTypes({ type: 'house', osm_key: 'building', osm_value: 'yes' });
  assert.equal(geocodeNavigationMode(types), 'precise-place');
});

test('the label names the place, then only containers it does not already name', () => {
  assert.equal(
    photonResultLabel({ name: 'Hoàn Kiếm Lake', district: 'Hoàn Kiếm', city: 'Hà Nội', country: 'Việt Nam' }),
    'Hoàn Kiếm Lake, Hoàn Kiếm, Hà Nội, Việt Nam',
  );
  assert.equal(
    photonResultLabel({ name: 'Hà Nội', city: 'Hà Nội', country: 'Việt Nam' }),
    'Hà Nội, Việt Nam',
    'a city must not repeat its own name',
  );
});

test('the Google bias becomes a SOFT proximity bias, never a hard bbox', () => {
  const url = new URL(photonSearchUrl('Sixth Street', { bias: '30.2000,-97.8000|30.3000,-97.7000' }));

  assert.equal(url.searchParams.get('q'), 'Sixth Street');
  assert.equal(url.searchParams.get('limit'), '1');
  assert.equal(url.searchParams.get('lat'), '30.25', 'centre of the biased rectangle');
  assert.equal(url.searchParams.get('lon'), '-97.75');

  // Measured against the live service: Photon's bbox FILTERS, Google's bounds
  // PREFERS. Sending the rectangle as a bbox makes every off-screen search
  // return features: [] — "Ho Guom, Ha Noi" while looking at Austin finds
  // nothing at all. This assertion is the guard against that regression.
  assert.equal(url.searchParams.get('bbox'), null, 'a bbox would filter out every off-screen place');
});

test('an absent or unparsable bias drops the bias instead of sending a broken one', () => {
  for (const bias of [undefined, 'nonsense', 'a,b|c,d']) {
    const url = new URL(photonSearchUrl('Hanoi', bias === undefined ? {} : { bias }));
    assert.equal(url.searchParams.get('lat'), null);
    assert.equal(url.searchParams.get('lon'), null);
    assert.equal(url.searchParams.get('bbox'), null);
  }
});

test('a network failure resolves to null — callers read null as not-found', async () => {
  const rejecting = () => Promise.reject(new Error('offline'));
  assert.equal(await geocodeKeyless('Hanoi', { fetchImpl: rejecting }), null);

  const notOk = () => Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
  assert.equal(await geocodeKeyless('somewhere else', { fetchImpl: notOk }), null);

  const empty = () => Promise.resolve({ ok: true, json: () => Promise.resolve({ features: [] }) });
  assert.equal(await geocodeKeyless('third distinct query', { fetchImpl: empty }), null);
});

test('an empty query never reaches the network', async () => {
  let calls = 0;
  const counting = () => { calls += 1; return Promise.reject(new Error('should not run')); };

  assert.equal(await geocodeKeyless('   ', { fetchImpl: counting }), null);
  assert.equal(await geocodeKeyless(null, { fetchImpl: counting }), null);
  assert.equal(calls, 0);
});

test('repeat queries are served from the memo, misses included', async () => {
  let calls = 0;
  const counting = () => {
    calls += 1;
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ features: [HANOI] }) });
  };

  const first = await geocodeKeyless('Ha Noi memo probe', { fetchImpl: counting });
  const second = await geocodeKeyless('Ha Noi memo probe', { fetchImpl: counting });
  assert.equal(calls, 1, 'the second lookup must not hit the network');
  assert.deepEqual(second, first);

  const missing = () => {
    calls += 1;
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ features: [] }) });
  };
  await geocodeKeyless('typo memo probe', { fetchImpl: missing });
  await geocodeKeyless('typo memo probe', { fetchImpl: missing });
  assert.equal(calls, 2, 'a miss must be memoized too, or a typo costs one request per keystroke');
});

test('a feature without usable coordinates is rejected', () => {
  assert.equal(normalizePhotonFeature(undefined), null);
  assert.equal(normalizePhotonFeature({ properties: { name: 'Nowhere' } }), null);
  assert.equal(normalizePhotonFeature({ geometry: { coordinates: [200, 10] } }), null);
  assert.equal(normalizePhotonFeature({ geometry: { coordinates: [10, 91] } }), null);
});
