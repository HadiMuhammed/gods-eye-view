/**
 * Keyless place search — Photon (komoot), an OpenStreetMap geocoder.
 *
 * The app's place search is Google Geocoding, which needs a billing-enabled
 * key. This module is the fallback for the two cases where that key produces
 * nothing: no key configured at all, and a key whose Geocoding API is not
 * enabled (Google answers HTTP 200 with `REQUEST_DENIED`, so the status — not
 * the response code — is what decides).
 *
 * It is an ADAPTER, not a second search stack. Results are normalized into the
 * exact shape `searchAndFlyTo` already consumes from Google — `lat`/`lng`, a
 * label, Google-style `types`, and `{southwest,northeast}` bounds — so every
 * downstream framing decision (`geocodeNavigationMode`, `regionFramingPlan`,
 * the region-swath cap) keeps running unchanged on unchanged inputs. The
 * translation lives here, at the boundary, and nowhere else.
 *
 * Photon is free, keyless, and CORS-open, so this runs in the browser on the
 * same path Google does. It asks for one hit and caches by query+bias to stay
 * inside komoot's fair-use expectations.
 */

const PHOTON_ENDPOINT = 'https://photon.komoot.io/api/';

/** Photon is a courtesy service; fail fast rather than hold the search open. */
const PHOTON_TIMEOUT_MS = 6000;

/** Bounded memo — a search box re-issues the same query on every keystroke. */
const PHOTON_CACHE_MAX = 64;
const photonCache = new Map();

/**
 * Photon's own coarse class → the Google Place Type `geocodeNavigationMode`
 * reads. Only types that function consults are worth emitting; anything else
 * falls through to `precise-place`, which is the correct default for a house
 * or a POI.
 */
const PHOTON_TYPE_TO_GOOGLE = Object.freeze({
  country: 'country',
  state: 'administrative_area_level_1',
  county: 'administrative_area_level_2',
  city: 'locality',
  district: 'sublocality',
  locality: 'locality',
  street: 'route',
});

/**
 * OSM `key=value` → Google Place Type. `null` means "this tag is a precise
 * place" and, like any other entry, stops the coarse class from being consulted.
 *
 * Two failure directions matter, and both were found by querying the live
 * service rather than by reasoning about OSM tagging:
 *
 * - Too coarse: a park or lake that arrives without an area type frames at
 *   building range, which is the exact bug `geocodeNavigationMode`'s area types
 *   exist to prevent — searching "Ho Guom" put the camera 26 m over the water.
 * - Too broad: Photon classifies a town square as `type: 'locality'`, so
 *   deferring to the coarse class frames Times Square as if it were a city.
 *   The explicit `null` below is what stops that.
 */
const OSM_TAG_TO_GOOGLE = Object.freeze({
  'leisure=park': 'park',
  'leisure=nature_reserve': 'park',
  'leisure=garden': 'park',
  'leisure=stadium': 'stadium',
  'boundary=national_park': 'park',
  'boundary=protected_area': 'park',
  'tourism=zoo': 'zoo',
  'tourism=theme_park': 'amusement_park',
  'amenity=university': 'university',
  'amenity=college': 'university',
  'amenity=grave_yard': 'cemetery',
  'landuse=cemetery': 'cemetery',
  'landuse=forest': 'natural_feature',
  'aeroway=aerodrome': 'airport',
  'shop=mall': 'shopping_mall',
  'place=region': 'natural_feature',
  'place=suburb': 'sublocality',
  'place=neighbourhood': 'sublocality',
  'place=quarter': 'sublocality',
  'place=borough': 'sublocality',
  'place=square': null,
});

/**
 * OSM keys whose features are areas whatever their value — lakes, rivers,
 * peaks, woods, protected land. Photon reports every one of these with
 * `type: 'other'`, so the key is the only signal that they are not buildings.
 */
const AREA_OSM_KEYS = Object.freeze(new Set(['natural', 'water', 'waterway', 'landuse']));

/**
 * Google-style types for one Photon feature's properties.
 *
 * A specific `key=value` mapping is authoritative and ends the lookup; the
 * coarse `type` is consulted only when no tag rule matched. Deferring to the
 * coarse class after a tag rule is what mis-framed town squares as cities.
 * @param {object} properties - Photon feature `properties`.
 * @returns {string[]} Google Place Types, possibly empty (a precise place).
 */
export function photonResultTypes(properties) {
  const key = String(properties?.osm_key || '');
  const value = String(properties?.osm_value || '');
  const tag = `${key}=${value}`;

  if (Object.prototype.hasOwnProperty.call(OSM_TAG_TO_GOOGLE, tag)) {
    const mapped = OSM_TAG_TO_GOOGLE[tag];
    return mapped ? [mapped] : [];
  }
  if (AREA_OSM_KEYS.has(key)) return ['natural_feature'];
  if (key === 'highway') return ['route'];

  const coarse = PHOTON_TYPE_TO_GOOGLE[String(properties?.type || '')];
  return coarse ? [coarse] : [];
}

/**
 * Photon `extent` → the `{southwest,northeast}` bounds the flight code frames.
 * Photon orders it [west, north, east, south]; a naive [w,s,e,n] read produces
 * an inverted box that still looks like a valid viewport.
 * @param {number[]} extent - Photon `properties.extent`.
 * @returns {?{southwest:{lat:number,lng:number}, northeast:{lat:number,lng:number}}}
 */
export function photonExtentToBounds(extent) {
  if (!Array.isArray(extent) || extent.length !== 4) return null;
  const [west, north, east, south] = extent.map(Number);
  if (![west, north, east, south].every(Number.isFinite)) return null;
  if (Math.abs(north) > 90 || Math.abs(south) > 90) return null;
  if (Math.abs(west) > 180 || Math.abs(east) > 180) return null;
  return {
    southwest: { lat: Math.min(north, south), lng: Math.min(west, east) },
    northeast: { lat: Math.max(north, south), lng: Math.max(west, east) },
  };
}

/**
 * Human label for a Photon feature — its name plus the coarsest containing
 * places that are not already in the name, mirroring the single-line address
 * Google's `formatted_address` provides.
 * @param {object} properties - Photon feature `properties`.
 * @returns {string}
 */
export function photonResultLabel(properties) {
  const name = String(properties?.name || '').trim();
  const parts = [name];
  for (const field of ['district', 'city', 'state', 'country']) {
    const part = String(properties?.[field] || '').trim();
    if (part && !parts.includes(part)) parts.push(part);
  }
  return parts.filter(Boolean).join(', ');
}

/**
 * Photon GeoJSON feature → the normalized geocode result `searchAndFlyTo`
 * consumes. Returns null for a feature without usable coordinates.
 * @param {object} feature - One entry of Photon's `features` array.
 * @returns {?{lat:number, lng:number, label:string, types:string[], viewport:?object}}
 */
export function normalizePhotonFeature(feature) {
  const [lng, lat] = feature?.geometry?.coordinates || [];
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;

  const properties = feature.properties || {};
  return {
    lat,
    lng,
    label: photonResultLabel(properties) || String(properties.name || ''),
    types: photonResultTypes(properties),
    viewport: photonExtentToBounds(properties.extent),
  };
}

/**
 * Photon request URL for one query.
 *
 * `bias` is the SAME `"swLat,swLng|neLat,neLng"` string `viewportBias()` builds
 * for the Google call, so the two paths cannot drift apart — but it is sent as
 * Photon's `lat`/`lon` PROXIMITY bias, not as `bbox`.
 *
 * That distinction is the whole correctness of this function. Google's `bounds`
 * prefers results inside the box and still returns ones outside it; Photon's
 * `bbox` is a hard filter. Translating the rectangle literally makes every
 * search for somewhere off-screen return nothing — searching "Ho Guom, Ha Noi"
 * while looking at Austin answers `features: []`. Sent as `lat`/`lon` it finds
 * Hoan Kiem Lake, while "Sixth Street" still resolves to Austin's over Austin
 * and to England's over London. Soft bias is the semantics Google gives, so
 * soft bias is what the adapter must produce.
 * @param {string} query - Free-text place name.
 * @param {{bias?: ?string}} [options]
 * @returns {string}
 */
export function photonSearchUrl(query, { bias = null } = {}) {
  const url = new URL(PHOTON_ENDPOINT);
  url.searchParams.set('q', String(query ?? ''));
  url.searchParams.set('limit', '1');

  const corners = String(bias ?? '').split('|');
  if (corners.length === 2) {
    const [swLat, swLng] = corners[0].split(',').map(Number);
    const [neLat, neLng] = corners[1].split(',').map(Number);
    if ([swLat, swLng, neLat, neLng].every(Number.isFinite)) {
      url.searchParams.set('lat', String((swLat + neLat) / 2));
      url.searchParams.set('lon', String((swLng + neLng) / 2));
    }
  }
  return url.toString();
}

/** Evict the oldest memo entries until the cache is within its cap. */
function trimPhotonCache() {
  while (photonCache.size > PHOTON_CACHE_MAX) {
    const oldest = photonCache.keys().next().value;
    if (oldest === undefined) break;
    photonCache.delete(oldest);
  }
}

/**
 * Geocode a place name without any API key. Never throws: a network failure,
 * a timeout, or an empty result all resolve to null, which the caller reads as
 * "not found" exactly as it reads a Google miss.
 * @param {string} query - Free-text place name.
 * @param {{bias?: ?string, fetchImpl?: Function}} [options]
 * @returns {Promise<?{lat:number, lng:number, label:string, types:string[], viewport:?object}>}
 */
export async function geocodeKeyless(query, { bias = null, fetchImpl = fetch } = {}) {
  const trimmed = String(query ?? '').trim();
  if (!trimmed) return null;

  const url = photonSearchUrl(trimmed, { bias });
  if (photonCache.has(url)) return photonCache.get(url);

  let result = null;
  try {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(PHOTON_TIMEOUT_MS) });
    if (response.ok) {
      const body = await response.json();
      result = normalizePhotonFeature(body?.features?.[0]);
    }
  } catch {
    result = null;
  }

  // Misses are cached too: a typo re-issued on every keystroke should cost one
  // request, not one per stroke.
  photonCache.set(url, result);
  trimPhotonCache();
  return result;
}
