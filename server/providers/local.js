export { isOverpassBoundaryQuery } from './overpass/query.js';
export { simplifyOverpassPayloadBody } from './overpass/geometry.js';
export { readOverpassDisk } from './overpass/cache.js';
export { resolveOverpassPreflight } from './overpass/cache.js';
export { overpassPayloadIsData } from './overpass/transport.js';
export { fetchOverpassPayload } from './overpass/transport.js';
import { overpassProxy } from './overpass.js';
export { MILITARY_INSTALLATION_ELEMENT_CAP } from './military-installations/constants.js';
export { quantizeMilitaryInstallationBox } from './military-installations/query.js';
export { militaryInstallationCacheKey } from './military-installations/query.js';
export { resolveMilitaryInstallationTier } from './military-installations/cache.js';
export { migrateMilitaryInstallationEntry } from './military-installations/cache.js';
export { militaryInstallationDiskFresh } from './military-installations/cache.js';
export { militaryInstallationDiskPath } from './military-installations/cache.js';
export { readMilitaryInstallationDisk } from './military-installations/cache.js';
export { writeMilitaryInstallationDisk } from './military-installations/cache.js';
export { validMilitaryInstallationBox } from './military-installations/query.js';
export { militaryInstallationFailureReason } from './military-installations/query.js';
import { militaryInstallationsProxy } from './military-installations.js';
export { validRegionalPoint } from './regional/query.js';
export { regionalBriefHasAnySource } from './regional/briefing.js';
import { regionalBriefProxy } from './regional/briefing.js';
import { weatherEffectsProxy } from './regional/weather-effects.js';
import { openAiRealtimeProxy } from './openai.js';
export { openAiRealtimeProxy } from './openai.js';
import { cctvProxy } from './cctv.js';
import { radioBrowserProxy } from './radio.js';
export { CCTV_FRAME_FETCH_TIMEOUT_MS, fetchCctvImageFromUpstream } from './cctv.js';
export { createRadioProxyMiddleware, isPublicRadioAddress, normalizeRadioBrowserStation, publicRadioStation, publicRadioHttpsUrl } from './radio.js';
import { terrainHeightsProxy } from './terrain.js';
import { tomtomProxy } from './traffic.js';
import { firmsProxy } from './firms.js';
import { noaaHazardsProxy } from './noaa.js';
import { gbfsProxy } from './gbfs.js';
import { celestrakProxy, rocketLaunchesProxy } from './space.js';
export { LL2_CACHE_TTL_MS, launchLibraryRequestHeaders } from './space.js';
/**
 * Local Node provider middleware for God's Eye View.
 *
 * Registers the dev-server proxy middlewares that bypass CORS and add
 * caching/auth for upstream APIs:
 *   1. OpenSky  — aircraft state vectors (OAuth / Basic / anon)
 *   2. CelesTrak — satellite TLE orbital elements
 *   3. Overpass  — OpenStreetMap road geometry queries
 *   4. GBFS     — bike-share station feeds
 *   5. CCTV     — traffic-camera frames, media streams, and fallback SVG
 *   6. adsb.lol — military aircraft tracking
 *   7. AIS live — AISStream websocket-backed live vessel positions
 *   8. Terrain heights — Re:Earth keyless point-height lookups (ellipsoidal ground)
 *   9. TomTom   — live traffic-flow vector tiles (budget-governed, keyless-degradable)
 *  10. NASA FIRMS — live active-fire detections (VIIRS ×3, trailing 24 h)
 *  11. Military-installation context — bounded, cached OpenStreetMap features
 *  12. Regional briefing — cached place, weather, and recent location-matched news
 *  13. Weather effects — camera-local Open-Meteo observations without news/geocoding overhead
 *  14. Rocket launches — recent Launch Library 2 mission metadata
 *  15. Radio Browser — public-domain station directory and click counting
 *
 * Standalone configuration owns environment loading and browser key selection.
 *
 * @module server/providers/local
 */

import { googlePlacesContextProxy, googleServerApiKey, keylessGooglePlacesResponse, installRouteMiddleware, makeRateLimiter, makeOptInRateLimiter, clientKey, haversineKm } from './places.js';
export { googlePlacesContextProxy, googleServerApiKey, keylessGooglePlacesResponse };

import { openSkyProxy, adsbLolFallbackAnchor } from './aircraft/opensky.js';
import { adsbLolProxy } from './aircraft/adsb-lol.js';
import { adsbdbProxy } from './aircraft/enrichment.js';
import { trackBackfillProxies } from './aircraft/tracks.js';
import { aisLiveProxy } from './vessels/ais-live.js';
import { readResponseTextCapped, readResponseJsonCapped, coalesceProxyRequest, readCappedResponseText } from './common/http.js';
import { requiredFiniteQueryNumber, clampInt } from './common/query.js';
export { adsbLolFallbackAnchor, readResponseTextCapped, readResponseJsonCapped, coalesceProxyRequest, requiredFiniteQueryNumber };

import fs from 'node:fs';
import os from 'node:os';
import { promises as fsp } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';


import { fileURLToPath } from 'node:url';
import {
  normalizeRegionalArticles,
  normalizeRegionalPlace,
  normalizeRegionalWeather,
} from '../../src/data/regionalBrief.js';
import { keylessHudSummaryResponse } from '../../src/hudSummaryResponse.js';
import { parseEnv as parseDotenvText } from 'node:util';
import { readEnvironmentSource as readPinokioEnvironmentSource } from '../../scripts/pinokio-environment.mjs';
import {
  admitKeySetupRequest,
  isKeySetupExternallyManaged,
  keySetupStatus,
  knownKeySetupEnvVars,
  upsertDotenvValues,
  validateKeySetupUpdates,
} from '../../src/keySetupCore.mjs';
import { hardenCredentialFile } from '../../src/keySetupHardening.mjs';

import { VOICE_MODELS, isKnownVoiceTier, resolveVoiceModel } from '../../src/voice/voiceCost.js';

/** Resolve __dirname for ESM context. */
const __dirname = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * Which launcher started this process, captured at MODULE LOAD — before the
 * config factory's loadEnv() copies dotenv files into process.env. Provider
 * Settings uses this to decide which credential store it owns, so it must
 * reflect the real launcher (scripts/pinokio-start.mjs sets it) and never a
 * value a project `.env` could inject.
 */
const LAUNCHER_AT_BOOT = process.env.GEV_LAUNCHER;

/**
 * Provider values present before Vite loads the checkout's dotenv files.
 * Memoized on globalThis: a panel save sets its values live on process.env and
 * then calls server.restart(), which re-evaluates this config IN-PROCESS.
 * Recomputing the snapshot there would classify the panel's own keys as
 * external (read-only) until the whole process is relaunched.
 */
const PROVIDER_ENV_AT_BOOT = globalThis.__GEV_PROVIDER_ENV_AT_BOOT ??= Object.freeze(Object.fromEntries(
  [...knownKeySetupEnvVars()].map((name) => [name, String(process.env[name] ?? '').trim()]),
));

/**
 * `dev-fresh.sh` resolves dotenv and Keychain values before it starts Vite, so
 * it supplies an explicit names-only provenance marker for values inherited
 * from its parent shell. Plain Vite launches use the raw boot snapshot above;
 * Pinokio deliberately treats its app-scoped ENVIRONMENT as authoritative.
 */
const DEV_FRESH_EXTERNAL_KEYS_AT_BOOT = new Set(
  String(process.env.GEV_KEY_SETUP_EXTERNAL_KEYS ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter((name) => knownKeySetupEnvVars().has(name)),
);
// ---------------------------------------------------------------------------
// Overpass API proxy constants and cache state
// ---------------------------------------------------------------------------
/** Ordered list of Overpass API mirrors; tried sequentially on failure/rate-limit. */

/**
 * TTL for FRESH cached Overpass responses (ms). Road geometry is static for
 * months — the original 45 s TTL forced a public-mirror round-trip on nearly
 * every viewport revisit and left nothing to serve when the mirrors 502
 * (field-test 2026-07-17: all three mirrors down during US morning peak =
 * "traffic takes forever to load"). 24 h in memory; the disk layer below
 * keeps 7 days and also survives dev-server restarts.
 */

/** Disk-cache TTL for Overpass responses (ms) — 7 days. */

/**
 * Disk-cache TTL for BOUNDARY-class queries (is_in / admin-relation pivots) — 30
 * days. Admin boundaries change ≈never, and their pivots are the most expensive
 * queries the app issues (multi-MB coastline geometry, 10–25 s on public mirrors —
 * field test 2026-07-23: outline latency + the Sicily miss). Keeping them a month
 * means each boundary is fetched roughly once per machine, ever.
 */

/** Disk-cache directory for Overpass responses. */

/** Per-upstream fetch timeout (ms). */

/** Max entries in the Overpass response cache (LRU-like, oldest evicted first). */

/** @type {Map<string,{status:number,body:string,contentType:string,endpoint:string,cachedAt:number}>} */

/** @type {Map<string,Promise>} In-flight Overpass requests keyed by normalized query body. */


/**
 * Whether a normalized Overpass query is BOUNDARY-class (admin `is_in` lookups
 * and area→relation pivots) — the static, expensive geometry that earns the
 * 30-day disk TTL. The enclosing-compound sweep and road fetches keep the
 * default TTL. Exported for tests.
 */


/** Disk TTL for a query: boundary geometry keeps for a month, the rest 7 days. */


/** Iterative Douglas-Peucker on [{lat,lon},...] (planar-degree approx — fine at
 *  the ~44 m tolerance used here). Endpoints always kept. */


/** Simplify one element's geometry array in place if it is big enough. */


/**
 * Server-side geometry simplification for large Overpass `out geom` payloads.
 * Region/state boundary pivots return multi-MB coastline rings whose fidelity
 * nothing downstream needs (the client re-simplifies for draw); decimating them
 * HERE shrinks the disk cache, the wire, and client parse time — and is what
 * makes the raised read cap safe. Anything unparseable or below the thresholds
 * passes through byte-identical. Exported for tests (opts override thresholds).
 *
 * @param {string} bodyText - Raw upstream JSON body.
 * @returns {string} Possibly-simplified JSON body.
 */


/** Normalized Overpass query -> stable disk-cache file path. */


/**
 * Read a disk-cached Overpass payload. maxAgeMs Infinity = any age (the
 * serve-stale path when every mirror is down).
 * @returns {Promise<?Object>} Payload with cachedAt, or null.
 */


/** Fire-and-forget disk write for a successful Overpass payload. */


/**
 * Resolve every cache/coalescing layer before admitting a request to the local
 * upstream rate limiter. The injected limiter callback is invoked exactly once
 * for a complete cache miss and never for memory, in-flight, or disk hits.
 * Exported so the admission ordering can be tested without a Vite server.
 *
 * @param {object} options
 * @param {string} options.cacheKey
 * @param {Map<string, object>} options.memoryCache
 * @param {Map<string, Promise<object>>} options.inFlight
 * @param {()=>Promise<object|null>} options.readDisk
 * @param {()=>boolean} options.allowUpstream
 * @param {number} [options.now]
 * @param {number} [options.cacheMs]
 * @returns {Promise<{source:'HIT'|'INFLIGHT'|'DISK'|'UPSTREAM'|'RATE_LIMITED', payload:object|null}>}
 */


/** Return only last-good Overpass data, regardless of its age. */


// --- Abuse guards shared by the Overpass + route proxies --------------------
/** Max accepted POST body for the Overpass proxy (Overpass QL queries are tiny). */
 // 24 KB
/**
 * Hard cap on a single Overpass upstream response we will buffer into memory.
 * 32 MB (was 12 MB): a dense island/state admin boundary at full `out geom`
 * fidelity — Sicilia's Mediterranean coastline — can exceed 12 MB, and clipping
 * it read as a permanent "transient" failure (field test 2026-07-23, Sicily
 * never traced). The buffered payload is SIMPLIFIED server-side before it is
 * cached or sent (simplifyOverpassPayloadBody), so the raised cap does not
 * raise what clients receive or what the disk stores.
 */
 // 32 MB
/** Only payloads at least this large go through geometry simplification. */

/** Only per-element geometry arrays with at least this many points are simplified. */

/**
 * Douglas-Peucker tolerance (degrees, ≈44 m of latitude). Region/state boundary
 * rings are drawn at regional camera scale and the client simplifies again for
 * draw, so ~44 m fidelity is invisible; building footprints never reach the
 * point threshold above and pass through untouched.
 */

/** Max concurrent in-flight upstream Overpass fetches across all distinct queries. */




// Built LAZILY on first request, NOT at module load: `.env` values are applied to process.env later
// (the plugin config hook calls loadEnv → process.env, AFTER this module is imported), so reading
// process.env here at import time would always see them unset and silently stay unlimited even when
// configured via .env. Building on first request (like the OPENAI_API_KEY reads) sees the loaded env;
// the result is cached so the limiter's per-IP window state persists. `null` = unlimited (default).

/** OpenAI cost endpoints (realtime/token + hud-summary). Null = unlimited (default). */


/**
 * Apply an opt-in limiter to a request, writing a 429 when over the cap.
 * When `limiter` is null (unlimited, the default) this is a no-op returning
 * `true`, so the handler proceeds exactly as before.
 *
 * @param {((key:string)=>boolean)|null} limiter
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @returns {boolean} True if the request may proceed; false if a 429 was sent.
 */


/** Server-side timeout ceiling (seconds) we allow inside an Overpass QL query. */

/** Max `around:` radius (m) — every app caller uses <= 1800 m. */

/** Max bbox span (degrees) — app bboxes are small viewport tiles. */

/**
 * Every Overpass element-type specifier, including the combined shortcuts
 * (nwr/nw/nr/wr) and `rel`. Shared by the selector + area-element-deny regexes so
 * they can't drift (a missing shortcut like `wr` was an area-scan bypass).
 */

/** Element-selector (incl. `area`) whose statements must be individually bounded. */

/** An element selector bounded BY an area — the country-scan abuse shape. */

/** A single bbox 4-tuple `(s,w,n,e)` (non-global so it does not advance lastIndex). */


/**
 * Validate + clamp an Overpass form body. Defends the generic proxy against
 * planet-scale abuse: requires exactly one `data` query in which EVERY element
 * selector is individually spatially bounded (around / bbox / is_in / poly /
 * area-set / pivot), rejects oversized radii and world-sized bboxes, and clamps
 * every `[timeout:]` directive. Comments + quoted literals are stripped first so
 * a fake bound inside a tag value can't satisfy the check.
 *
 * Every real app caller passes (annotations/locations/cctv use `around:`/`is_in`/
 * `area.`/`pivot`; traffic uses a small `(s,w,n,e)` bbox); a mixed query that
 * pairs one bounded selector with a global one is rejected.
 *
 * @returns {{ok:true, body:string} | {ok:false, error:string}}
 */
/**
 * Single-pass lexer: blank out quoted literals (→ empty quotes) and strip line
 * and block comments — recognizing each in one walk so a comment marker INSIDE a
 * quoted string is treated as string content, not a comment (and vice versa).
 * Chained regex replaces get the ordering wrong (a quoted slash-slash would hide
 * the rest of the line), which is exactly the bypass this avoids.
 */




/** Read a request body with a hard byte cap; throws { code:'BODY_TOO_LARGE' } past the cap. */


// Sourced from the shared voice-model registry so the client's cost estimate
// can never be computed against a different model than the session runs on.











/**
 * Detect whether an Overpass API response body indicates rate-limiting.
 *
 * Checks for known rate-limit phrases in the body text regardless of
 * HTTP status code, since some mirrors return 200 with an error payload.
 *
 * @param {string} bodyText - Upstream response body.
 * @returns {boolean} True if the body looks rate-limited.
 */


/**
 * Detect an Overpass HTTP-200 body that is actually a runtime FAILURE (server-side
 * timeout / out-of-memory) via its `remark`. These are transient upstream failures,
 * not authoritative empty results, so they must not be returned or cached.
 */


/** Evict oldest Overpass cache entries until size is within the cap. */


/**
 * Write a completed Overpass payload to the HTTP response.
 *
 * @param {import('http').ServerResponse} res - Node HTTP response.
 * @param {{status:number,body:string,contentType:string,endpoint:string}} payload
 * @param {string} [cacheStatus='MISS'] - 'HIT', 'MISS', or 'INFLIGHT'.
 */


/**
 * True only for an upstream response that is actually Overpass data.
 *
 * The proxy caches on this and serves stale on its negation, so the two
 * decisions cannot drift apart: a payload that is not data must never be
 * written to the cache and must always be eligible for a stale replacement.
 * @param {{status: number, rateLimited?: boolean, runtimeError?: boolean}} payload
 * @returns {boolean}
 */


/**
 * Try each mirror once, retaining response-size and per-mirror timeout caps.
 * Refusals and body-level failures rotate; total failure returns the last
 * rate-limit payload, otherwise the first refusal, or throws a network error.
 * @param {string} body URL-encoded Overpass QL query body.
 * @param {number} [maxResponseBytes] Endpoint-specific response cap.
 * @param {object} [options] Server-only endpoint and I/O overrides for tests.
 * @returns {Promise<{status:number,body:string,contentType:string,endpoint:string,rateLimited:boolean}>}
 */


/**
 * Vite plugin: Overpass API proxy with response caching and request coalescing.
 *
 * Accepts POST requests at /api/overpass, normalizes the query body for
 * cache keying, and fans out to multiple Overpass mirrors with per-upstream
 * timeout and rate-limit detection. Successful responses are cached for
 * OVERPASS_CACHE_MS. Concurrent identical queries share a single upstream
 * request via the in-flight map.
 *
 * @returns {import('vite').Plugin}
 */



/**
 * Vite plugin: OpenAI Realtime ephemeral client secret.
 *
 * Keeps OPENAI_API_KEY server-side while the browser connects to the
 * Realtime API over WebRTC with a short-lived secret.
 */










// ---------------------------------------------------------------------------
// Military-installation context proxy
// ---------------------------------------------------------------------------
// This narrow endpoint deliberately does not expose arbitrary Overpass QL to
// the browser. It returns only allow-listed mapped context and rejects global,
// cross-dateline, or oversized requests before touching public OSM mirrors.




/**
 * Upstream element cap. A response that hits it exactly is SATURATED — Overpass
 * truncated, so off-viewport features from the snapped bbox may have crowded out
 * in-viewport ones. Callers re-ask for the exact viewport in that case.
 */

/**
 * Disk-cache TTL for mapped installations (ms) — 30 days.
 *
 * Owner playtest 2026-08-18: "search nearby sites" was slow because every look
 * around paid a live Overpass round trip, and the 5-minute in-memory tier died
 * with the dev server. Mapped military features change on a survey timescale,
 * not a session one, so a month-old answer is still the right answer — the same
 * reasoning the Overpass proxy already applies to admin boundaries.
 */

/** Disk-cache directory for mapped installation payloads. */

/**
 * Cache-key grid step in degrees (~5.5 km).
 *
 * The browser sends the raw view rectangle, so every pixel of pan minted a new
 * key and a new upstream query. Snapping the bbox OUTWARD onto a coarse grid
 * makes neighbouring viewports share one entry, and because the snap only ever
 * grows the box, the cached answer is always a superset of what was asked for.
 */




/**
 * Snap a request bbox outward onto the shared installation cache grid.
 * @param {{south:number, west:number, north:number, east:number}} box
 * @param {number} [stepDeg]
 * @returns {{south:number, west:number, north:number, east:number}}
 */


/**
 * Stable disk/memory cache key for an installation bbox.
 *
 * The key's precision must match the precision of the bounds the QUERY uses, or
 * two different queries collide on one entry. Snapped boxes live on a 0.05 deg
 * grid, so 3 decimals is exact for them; an `exact=1` request carries the raw
 * viewport at 5 decimals and must be keyed at 5, otherwise two nearby exact
 * viewports would share an answer and the second would be missing the edge
 * strip it just exposed.
 * @param {{south:number, west:number, north:number, east:number}} box
 * @param {number} [decimals]
 */


/**
 * Resolve the READ tiers for one installation request, in order: fresh memory,
 * then disk. Returns UPSTREAM when neither can answer.
 *
 * Disk is skipped while a request for this key is already in flight — the
 * caller joins that instead of paying a read. Exported so the tier ORDER is
 * testable against a real temp directory without a Vite server, mirroring
 * resolveOverpassPreflight.
 *
 * @param {object} options
 * @param {string} options.cacheKey
 * @param {Map<string, {payload: object, cachedAt: number}>} options.memoryCache
 * @param {Map<string, Promise>} options.inFlight
 * @param {() => Promise<?{payload: object, cachedAt: number}>} options.readDisk
 * @param {number} [options.now]
 * @param {number} [options.cacheMs]
 * @returns {Promise<{source: 'HIT'|'DISK'|'UPSTREAM', entry: ?object}>}
 */


/**
 * Bring a stored installation entry up to the current payload shape.
 *
 * Entries written before the saturation guard shipped carry no `saturated`
 * field, and the disk TTL is 30 DAYS — so without this a cached, truncated
 * 700-element snapped response would keep skipping the exact-viewport retry for
 * a month, quietly starving in-view sites. Saturation is DERIVED from the
 * element count rather than invalidating those entries, so warm caches survive
 * the upgrade.
 * @param {?{payload: object, cachedAt: number}} entry
 * @returns {?{payload: object, cachedAt: number}}
 */


/** Whether a stored installation entry is still inside its TTL. */


/** Cache key -> stable disk-cache file path. */


/**
 * Read a disk-cached installation entry. maxAgeMs Infinity = any age (the
 * serve-stale path when Overpass is down).
 * @returns {Promise<?{payload: object, cachedAt: number}>}
 */


/**
 * Persist one installation payload ATOMICALLY: serialize to a temp sibling,
 * then rename over the target. A crash or a full disk mid-write leaves the
 * PREVIOUS entry intact — an in-place overwrite would shred the last-good copy
 * and take serve-stale down with it, exactly when it is needed most.
 * @returns {Promise<boolean>} Whether the entry landed.
 */






/** Safe, evidence-based reason for an installation upstream failure. */




// ---------------------------------------------------------------------------
// Regional cockpit briefing proxy
// ---------------------------------------------------------------------------







































/** True when at least one regional source produced usable data. */






/**
 * In-app key setup ("POWER UP" panel) — dev-server only.
 *
 * GET  /api/setup/status → which keys are configured, as presence plus a
 *   source classification. Never a value or suffix. The panel renders itself entirely from
 *   this payload, so the key registry stays in one place (src/keySetupCore.mjs).
 * POST /api/setup/keys → validate {ENV_VAR: value} pairs and upsert them into
 *   the repo-root .env (created if absent), set process.env live, then restart
 *   the dev server so the client-exposed defines re-inject and the page
 *   reloads itself. Pasting a key in the app IS the whole setup — no
 *   hand-edited env files.
 *
 * Loopback-only on purpose: with HOST=0.0.0.0 the app can be shared on a LAN,
 * and a guest must be able to neither write the host's .env nor probe which
 * keys exist. Prod builds never register this middleware (apply: 'serve'), so
 * the panel's status fetch fails and the client removes the whole surface.
 */
function keySetupEndpoint() {
  const respond = (res, statusCode, payload) => {
    res.statusCode = statusCode;
    res.setHeader('Content-Type', 'application/json');
    // A credential-status response must never be cached by a proxy or the disk
    // cache, and the surface must never be framed (clickjacking a same-origin
    // REMOVE/replace past the Origin check).
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
    res.end(JSON.stringify(payload));
  };
  // Which store this launch owns. A Pinokio-managed launch (marker set by
  // scripts/pinokio-start.mjs) writes the app-scoped pinokio/ENVIRONMENT that
  // applyPinokioEnvironment() treats as authoritative; every other launch
  // writes the repo-root .env that Vite's loadEnv reads. The panel never
  // touches a store some other workflow owns.
  // The launcher marker is read from the BOOT environment captured before
  // Vite's loadEnv merges dotenv files into process.env — otherwise a stray
  // `GEV_LAUNCHER=pinokio` line in someone's .env would silently redirect a
  // plain `npm run dev` to write the Pinokio store it never loaded.
  const pinokioManaged = () => LAUNCHER_AT_BOOT === 'pinokio';
  const storeName = () => (pinokioManaged() ? 'pinokio-environment' : 'env-file');
  const storePath = () => path.join(__dirname, ...(pinokioManaged() ? ['pinokio', 'ENVIRONMENT'] : ['.env']));
  // Read the store, distinguishing "no store yet" from "cannot read this
  // store". Only ENOENT means empty. Every other failure — a permission error,
  // an I/O fault, an undecodable file — must ABORT the save: upserting into a
  // wrongly-empty string and atomically replacing the file would destroy every
  // other provider key the user had configured.
  const readStore = () => {
    try {
      // The Pinokio launcher deliberately supports a UTF-16 ENVIRONMENT (a
      // Windows editor or the native Configure panel can write one). Reuse its
      // own encoding-aware decoder so a panel write can never mistake UTF-16
      // bytes for UTF-8, corrupt the file, and wedge the next launch. We always
      // write back UTF-8, which is exactly what the launcher normalizes to.
      if (pinokioManaged()) return readPinokioEnvironmentSource(storePath());
      return fs.readFileSync(storePath(), 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return ''; // The first saved key births the file.
      const unreadable = new Error('the existing configuration could not be read, so nothing was changed');
      unreadable.code = 'GEV_STORE_UNREADABLE';
      throw unreadable;
    }
  };
  // Status must never fail because the store is unreadable — it reports the
  // LIVE environment, and an unreadable store only costs file/external
  // attribution. Persistence uses readStore() directly and refuses instead.
  const storeValues = () => {
    try {
      return parseDotenvText(readStore());
    } catch {
      return {};
    }
  };
  // The gate itself is pure and unit-tested (admitKeySetupRequest in
  // src/keySetupCore.mjs) — this just feeds it the request.
  const admit = (req) => admitKeySetupRequest({
    method: req.method,
    remoteAddress: req.socket?.remoteAddress,
    hostHeader: req.headers?.host,
    protocol: req.socket?.encrypted ? 'https:' : 'http:',
    origin: req.headers?.origin,
    contentType: req.headers?.['content-type'],
    proxyHeaders: req.headers || {},
    env: process.env,
  });
  // Is this env var supplied by a workflow OTHER than this panel's store? Boot
  // provenance closes the equal-value ambiguity: an exported X remains
  // external even when the editable store independently contains X.
  const isExternallyManaged = (name, inStore) => {
    const wasExternalAtBoot = pinokioManaged()
      ? false
      : LAUNCHER_AT_BOOT === 'dev-fresh'
        ? DEV_FRESH_EXTERNAL_KEYS_AT_BOOT.has(name)
        : PROVIDER_ENV_AT_BOOT[name] !== '';
    return isKeySetupExternallyManaged({
      effectiveValue: process.env[name],
      storedValue: inStore[name],
      wasExternalAtBoot,
    });
  };
  const providerStatus = () => {
    const inStore = storeValues();
    const status = keySetupStatus(process.env);
    for (const key of status.keys) {
      // 'file' = this panel's own store holds exactly this value (replace/remove
      // offered); 'external' = supplied by env/Keychain/another workflow
      // (read-only — the panel must never rewrite or delete it).
      key.managed = key.set
        ? (key.envVars.some((name) => isExternallyManaged(name, inStore)) ? 'external' : 'file')
        : null;
    }
    return { ...status, store: storeName() };
  };
  // Atomically replace the store's content: fresh same-dir temp created 0600
  // with the exclusive flag, fsync, rename over the target. Closes the window
  // where writeFileSync leaves a 0644 file holding a real key before any later
  // chmod, and the truncate-in-place data-loss path.
  const persistStore = (text) => {
    const filepath = storePath();
    // Never write THROUGH a symlink into a credential path.
    try {
      if (fs.lstatSync(filepath).isSymbolicLink()) {
        throw new Error('refusing to write a credential store that is a symlink');
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error; // absent is fine — first save.
    }
    // Random suffix, not the pid: a stale temp from a failed rename would
    // otherwise make every later save in this process fail EEXIST forever.
    const tmp = path.join(
      path.dirname(filepath),
      `.${path.basename(filepath)}.${randomUUID().slice(0, 8)}.tmp`,
    );
    const fd = fs.openSync(tmp, 'wx', 0o600);
    let staged = false;
    try {
      // Restrict the EMPTY temp file BEFORE the secret touches it. On Windows
      // a fresh file inherits the directory's ACL (world-readable under a
      // C:-rooted Pinokio home) and the 0600 open mode is a no-op — and NTFS
      // renames carry the file object's ACL with it, so hardening the temp IS
      // hardening the final file. Ordering this before the write means a
      // hardening failure aborts with the previous store fully intact and the
      // secret never on disk unprotected — no rollback path to get wrong.
      if (!hardenCredentialFile(tmp)) {
        const error = new Error('could not restrict the credential file to your account; nothing was saved');
        error.code = 'GEV_HARDEN_FAILED';
        throw error;
      }
      // writeSync may write fewer bytes than asked; loop until the whole
      // buffer lands or a truncated store gets fsynced and renamed into place.
      const buffer = Buffer.from(text, 'utf8');
      let written = 0;
      while (written < buffer.length) {
        written += fs.writeSync(fd, buffer, written, buffer.length - written);
      }
      fs.fsyncSync(fd);
      staged = true;
    } finally {
      fs.closeSync(fd);
      if (!staged) fs.rmSync(tmp, { force: true });
    }
    try {
      fs.renameSync(tmp, filepath);
    } catch (error) {
      // Never strand a staged secret on disk when the swap itself fails.
      fs.rmSync(tmp, { force: true });
      throw error;
    }
  };
  return {
    name: 'gev-key-setup',
    // serve AND not preview: `vite preview` resolves with command 'serve' too,
    // so a bare apply:'serve' would still configure under preview. The endpoints
    // only install via configureServer (never configurePreviewServer), so they
    // are absent from preview today — but pinning apply here makes that a
    // guarantee rather than an accident of which hook a future edit uses.
    apply: (_config, { command, isPreview }) => command === 'serve' && !isPreview,
    configureServer(server) {
      server.middlewares.use('/api/setup/status', (req, res) => {
        if (req.method !== 'GET') return respond(res, 405, { error: 'Method not allowed' });
        const admission = admit(req);
        if (!admission.ok) return respond(res, admission.status, { error: admission.error });
        respond(res, 200, providerStatus());
      });
      server.middlewares.use('/api/setup/keys', (req, res) => {
        if (req.method !== 'POST') return respond(res, 405, { error: 'Method not allowed' });
        const admission = admit(req);
        if (!admission.ok) return respond(res, admission.status, { error: admission.error });
        let body = '';
        let overflowed = false;
        req.on('data', (chunk) => {
          body += chunk;
          if (body.length > 8192) {
            overflowed = true;
            req.destroy();
          }
        });
        req.on('end', () => {
          if (overflowed) return respond(res, 413, { error: 'Request too large' });
          let parsed;
          try {
            parsed = JSON.parse(body || '{}');
          } catch {
            return respond(res, 400, { error: 'Invalid JSON' });
          }
          const verdict = validateKeySetupUpdates(parsed);
          if (!verdict.ok) return respond(res, 400, { error: verdict.error });
          // Neither a replace NOR a removal may touch an externally-supplied
          // credential (shell env, Keychain, another workflow). This backs the
          // UI's read-only "configured externally" state with a real contract —
          // and it must guard replace too, not just remove: a clickjacked or
          // scripted same-origin POST could otherwise overwrite the live value.
          const inStore = storeValues();
          for (const name of Object.keys(verdict.updates)) {
            if (isExternallyManaged(name, inStore)) {
              return respond(res, 409, {
                error: `${name} is configured outside Provider Settings and can only be changed where it was set`,
              });
            }
          }
          try {
            persistStore(upsertDotenvValues(readStore(), verdict.updates));
          } catch (error) {
            // The hardening failure carries its own honest, path-free message —
            // "saved world-readable" must never be reported as a generic write
            // error. Everything else returns a fixed message (a raw filesystem
            // error can carry an absolute path; that stays in the server log).
            if (error?.code === 'GEV_HARDEN_FAILED' || error?.code === 'GEV_STORE_UNREADABLE') {
              return respond(res, 500, { error: `The key was not saved: ${error.message}` });
            }
            return respond(res, 500, { error: `Could not write the ${storeName()} store` });
          }
          // Live for the server-side proxies immediately; the restart below is
          // what re-injects the client-exposed defines (Google, Cesium ion).
          // Removal sets '' rather than deleting: an empty value stays falsy
          // through loadEnv after restart, matching the Pinokio launcher's own
          // blank-field semantics.
          for (const [name, value] of Object.entries(verdict.updates)) {
            process.env[name] = value === null ? '' : value;
          }
          respond(res, 200, {
            ok: true,
            saved: Object.keys(verdict.updates),
            status: providerStatus(),
            restarting: true,
          });
          // One deliberate restart, after the response has flushed. Vite's own
          // .env watcher may fire too; a second queued restart is harmless.
          setTimeout(() => {
            server.restart().catch((error) => {
              console.warn('[KeySetup] Dev-server restart failed:', error?.message || error);
            });
          }, 250);
        });
      });
    },
  };
}

/** Construct the local provider plugins in their established order. */
export function localProviderPlugins() {
  return [
      openSkyProxy(),
      celestrakProxy(),
      tomtomProxy(),
      firmsProxy(),
      noaaHazardsProxy(),
      rocketLaunchesProxy(),
      terrainHeightsProxy(),
      adsbdbProxy(),
      overpassProxy(),
      militaryInstallationsProxy(),
      regionalBriefProxy(),
      weatherEffectsProxy(),
      cctvProxy({ sourceRoot: __dirname }),
      radioBrowserProxy(),
      gbfsProxy(),
      adsbLolProxy(),
      aisLiveProxy(),
      trackBackfillProxies(),
      openAiRealtimeProxy(),
      googlePlacesContextProxy(),
      keySetupEndpoint(),
  ];
}
