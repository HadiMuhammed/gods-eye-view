export { isOverpassBoundaryQuery } from './overpass/query.js';
export { simplifyOverpassPayloadBody } from './overpass/geometry.js';
export { readOverpassDisk } from './overpass/cache.js';
export { resolveOverpassPreflight } from './overpass/cache.js';
export { overpassPayloadIsData } from './overpass/transport.js';
export { fetchOverpassPayload } from './overpass/transport.js';
import { overpassProxy } from './overpass.js';
import { readRequestBody } from './common/request.js';
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
let _openAiRateLimiter;
/** OpenAI cost endpoints (realtime/token + hud-summary). Null = unlimited (default). */
function openAiRateLimiter() {
  if (_openAiRateLimiter === undefined) _openAiRateLimiter = makeOptInRateLimiter(process.env.GEV_RATELIMIT_OPENAI_PER_MIN);
  return _openAiRateLimiter;
}

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
function enforceOptInRateLimit(limiter, req, res) {
  if (!limiter) return true; // unlimited (default) — no behavior change
  if (limiter(clientKey(req))) return true;
  res.statusCode = 429;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Retry-After', '5');
  res.end(JSON.stringify({ error: 'Rate limit exceeded' }));
  return false;
}

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
const OPENAI_REALTIME_MODEL_DEFAULT = VOICE_MODELS.standard.id;
const OPENAI_REALTIME_MODEL_MINI_DEFAULT = VOICE_MODELS.mini.id;
const OPENAI_REALTIME_VOICE_DEFAULT = 'marin';
const OPENAI_REALTIME_REASONING_DEFAULT = 'low';
const OPENAI_REALTIME_CONTEXT_TOKENS_DEFAULT = 3000;
const OPENAI_REALTIME_CONTEXT_RETENTION_DEFAULT = 0.5;
const OPENAI_HUD_SUMMARY_MODEL_DEFAULT = 'gpt-5-nano';
const REALTIME_DEBUG_LOG_DIR = path.join(__dirname, '.gev-logs');
const REALTIME_DEBUG_LOG_FILE = path.join(REALTIME_DEBUG_LOG_DIR, 'realtime-conversations.jsonl');
const REALTIME_DEBUG_LOG_MAX_BYTES = 8 * 1024 * 1024;

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
export function openAiRealtimeProxy() {
  function install(middlewares) {
    middlewares.use('/api/openai/hud-summary', async (req, res) => {
      if (req.method !== 'POST') {
        res.statusCode = 405;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Method not allowed' }));
        return;
      }

      const apiKey = process.env.OPENAI_API_KEY;
      const keyless = keylessHudSummaryResponse(apiKey);
      if (keyless) {
        res.statusCode = keyless.statusCode;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        res.end(JSON.stringify(keyless.payload));
        return;
      }

      // Opt-in per-IP throttle (GEV_RATELIMIT_OPENAI_PER_MIN). Keyless HUD
      // fallback has no provider cost and resolves above without consuming a
      // paid-endpoint quota slot.
      if (!enforceOptInRateLimit(openAiRateLimiter(), req, res)) return;

      try {
        const body = await readRequestBody(req, 64 * 1024);
        const context = JSON.parse(body || '{}');
        const response = await fetch('https://api.openai.com/v1/responses', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: process.env.OPENAI_HUD_SUMMARY_MODEL || OPENAI_HUD_SUMMARY_MODEL_DEFAULT,
            instructions: [
              "Write one concise intelligence-HUD summary for God's Eye View.",
              'Use only the supplied place, street, nearby-place, and enabled-layer text labels.',
              'Prefer the clearest named place and include a relevant enabled layer only when useful.',
              'Do not infer from coordinates or invent a place.',
              'Output exactly five words with no title, punctuation, markdown, or introductory phrase.',
            ].join(' '),
            input: JSON.stringify(context),
            reasoning: { effort: 'minimal' },
            max_output_tokens: 100,
          }),
        });
        const data = await response.json().catch(() => ({}));
        const summary = toFiveWordHudSummary(extractOpenAiResponseText(data));
        res.statusCode = response.ok && summary ? 200 : response.status || 502;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        res.end(JSON.stringify({
          summary: summary || null,
          error: response.ok ? null : data.error?.message || 'OpenAI HUD summary request failed',
        }));
      } catch (error) {
        res.statusCode = 502;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: error?.message || 'OpenAI HUD summary request failed' }));
      }
    });

    middlewares.use('/api/realtime/debug-log', async (req, res) => {
      if (req.method !== 'POST') {
        res.statusCode = 405;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Method not allowed' }));
        return;
      }

      try {
        const body = await readRequestBody(req, REALTIME_DEBUG_LOG_MAX_BYTES);
        const record = JSON.parse(body || '{}');
        fs.mkdirSync(REALTIME_DEBUG_LOG_DIR, { recursive: true });
        fs.appendFileSync(REALTIME_DEBUG_LOG_FILE, `${JSON.stringify({
          loggedAt: new Date().toISOString(),
          ...record,
        })}\n`);
        res.statusCode = 204;
        res.end();
      } catch (error) {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: error?.message || 'Failed to write Realtime debug log' }));
      }
    });

    middlewares.use('/api/realtime/token', async (req, res) => {
      if (req.method !== 'GET' && req.method !== 'POST') {
        res.statusCode = 405;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Method not allowed' }));
        return;
      }

      // Opt-in per-IP throttle (GEV_RATELIMIT_OPENAI_PER_MIN). No-op when unset.
      if (!enforceOptInRateLimit(openAiRateLimiter(), req, res)) return;

      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) {
        res.statusCode = 503;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'OPENAI_API_KEY is not set' }));
        return;
      }

      // Voice model tier, requested by the client as ?tier=standard|mini.
      // resolveVoiceModel is total: an unknown, empty, or hostile value
      // resolves to `standard` instead of reaching OpenAI as a model id, so a
      // bad querystring degrades to a normal session rather than a dead mic.
      // The env overrides stay authoritative per tier (see .env.example) —
      // a wrong upstream model id is then a config fix, not a code change.
      const requestedTier = (() => {
        try {
          return new URL(req.url || '', 'http://localhost').searchParams.get('tier');
        } catch {
          return null;
        }
      })();
      const tier = resolveVoiceModel(requestedTier).tier;
      const model =
        tier === 'mini'
          ? process.env.OPENAI_REALTIME_MODEL_MINI || OPENAI_REALTIME_MODEL_MINI_DEFAULT
          : process.env.OPENAI_REALTIME_MODEL || OPENAI_REALTIME_MODEL_DEFAULT;
      const voice = process.env.OPENAI_REALTIME_VOICE || OPENAI_REALTIME_VOICE_DEFAULT;
      const effort = process.env.OPENAI_REALTIME_REASONING_EFFORT || OPENAI_REALTIME_REASONING_DEFAULT;
      const contextTokenLimit = Math.round(Math.max(
        1000,
        Math.min(12000, Number(process.env.OPENAI_REALTIME_CONTEXT_TOKENS) || OPENAI_REALTIME_CONTEXT_TOKENS_DEFAULT)
      ));
      const contextRetentionRatio = Math.max(
        0.1,
        Math.min(1, Number(process.env.OPENAI_REALTIME_CONTEXT_RETENTION) || OPENAI_REALTIME_CONTEXT_RETENTION_DEFAULT)
      );
      const sessionConfig = {
        session: {
          type: 'realtime',
          model,
          reasoning: { effort },
          truncation: {
            type: 'retention_ratio',
            retention_ratio: contextRetentionRatio,
            token_limits: {
              post_instructions: contextTokenLimit,
            },
          },
          audio: {
            input: {
              noise_reduction: { type: 'near_field' },
              turn_detection: {
                type: 'semantic_vad',
                eagerness: 'low',
                create_response: true,
                interrupt_response: false,
              },
            },
            output: { voice },
          },
          instructions: [
            "You are GEV Voice Control, a concise voice controller for a Cesium geospatial app called God's Eye View.",
            'Have a natural spoken conversation with the user while the mic session is active.',
            'Do not require a wake phrase. Treat direct commands like "zoom into London" or "open datacenters" as GEV control requests.',
            'Only control the app by calling the provided tools. Never invent tool names or arguments.',
            'Call tools only for clear GEV control, navigation, visual-style, layer, or app-state requests. For ordinary conversation, answer normally without tools.',
            'For requests to open, show, reveal, or focus a menu/panel, call set_panel_open or show_data_layers_menu. "Open Context" means only set_panel_open{panelId:"global-context-panel",open:true}; it does not activate a Context sub-mode. "Open Contacts" means set_context_mode{mode:"contacts"}; that action expands the parent Context panel before activating Contacts.',
            'For requests like "show me the datacenter layers", open the data layers menu and focus the matching layer row; do not enable the layer unless the user asks to turn it on.',
            'For questions like "what am I looking at?", "what is in view?", "what is this?", "that selected thing", nearby datacenter, dam, cable, ship, or current view contents, call get_entity_context first, then answer from the returned scene/entity context.',
            'For "what is this aircraft?" answers, read the callsign, operator, registration, type, and route only from get_entity_context selected.properties. Treat route, routeOrigin, and routeDestination as the only authoritative route fields. Every aircraft identity answer MUST explicitly cover operator, type, and route. When a route is present, repeat its endpoint codes exactly; do not expand airport codes into city names. For a missing field say exactly "Operator details are unavailable", "Aircraft type is unavailable", or "Route details are unavailable" as applicable. Never silently omit missing enrichment or infer it from the callsign.',
            'While a camera motion or route flight is active, a bare "stop" means move_camera{motion:stop} — NOT control_scene and NOT stop_tracking (those need explicit words like "stop the scene" / "stop tracking"). If move_camera stop returns stopped:false and an entity is being tracked, call stop_tracking next — the user means "stop whatever is moving". Flying somewhere while tracking automatically stops the tracking (the result says so): mention it briefly.',
            'For camera-motion requests — "orbit around this", "pan left", "tilt up", "stop moving" — call move_camera. For "fly the route" over a drawn route, call fly_route. Confirm with the RESULTING state ("Orbiting slowly", "Flying the route").',
            'analyst_query ANSWERS questions; it never moves the camera or starts tracking. For requests to FOLLOW or TRACK a specific aircraft/ship, call track_entity (get_entity_context first when the target is ambiguous), never analyst_query as the final or only action. For "follow/track the nearest aircraft", first call analyst_query with the aircraft layer(s), sortBy=distance, and limit=1, then call track_entity with the returned aircraft identity in the same turn. The lookup alone does not fulfill a follow/track command.',
            'For a request to enable an aircraft layer and SELECT or FIND the nearest/closest aircraft near a named place — for example, "Turn on flights and select the closest aircraft to Austin" — call select_nearest_aircraft once. It atomically turns on the requested aircraft layer first, waits for location arrival, refreshes that layer for the destination viewport, filters out landed/on-ground records, and selects the nearest airborne result. A healthy fallback feed is valid data: report the returned feed source briefly, never call it an enable failure. Do not also call fly_to_location, set_layer_visibility, analyst_query, track_entity, set_context_mode, or control_cockpit for the same request. SELECT/FIND never implies Contacts or Cockpit unless the user explicitly asks for either mode.',
            'For ANALYTICAL questions about layer data — how many / which / fastest / highest / biggest / nearest flights, ships, fires, or earthquakes ("how many flights over Texas", "biggest fire near LA", "which ships are headed to Oakland", "anything above 40,000 feet") — call analyst_query, not get_entity_context. Narrate the count plus two or three notable examples by name, and reflect the result\'s coverage note honestly: the answer covers data loaded by enabled layers, not the whole world. If the needed layer is disabled, say so and offer to enable it. For follow-ups about the same set ("which of THOSE is closest?"), call analyst_query with followUp=true and only the new filter/sort.',
            'COUNTING CONTRACT — what "near" means. (1) While Contacts is ACTIVE, "near / nearby / how many aircraft" means the Contacts window: answer from contactsWindow in the tool result — those are the exact numbers on the user\'s panel. set_context_mode, analyst_query, and get_current_view_state carry it after Contacts settles. For "Open Contacts and tell me how many aircraft are within 250 km", call set_context_mode{mode:"contacts"} first and answer from contactsWindow.aircraft; do not answer from a pre-Contacts analyst query. analyst_query\'s own count measures currently-loaded records and is usually lower; never give it as the window count. CENTER PRECEDENCE for a nearby/how-many ask, in order: an explicit place in the question ("over Texas", "near Austin") always wins and ignores Contacts state; else the CONTACTS SUBJECT when Contacts is active and has one — a selected datacenter, dam, fire, or cable does NOT silently become the center; else an entity the user explicitly names ("around this datacenter"); else the current view, said aloud ("nothing is selected, so this is the current view"). With Contacts active but NO subject yet, use the view and say so; never read an empty panel. (2) With Contacts OFF, "nearby" means in view; "near <place>" means a radius around that place. (3) EVERY count names its scope in words — "42 in your window", "8 in view", "about 30 within 250 km of Austin" — never a bare number; analyst_query returns scopeLabel for exactly this. Two different numbers with named scopes are not a contradiction; say both if asked. (4) State counts VERBATIM — never estimate, round, or hedge ("a few", "less than a dozen"): if a tool returns 46, say 46. (5) When it matters, add once: counts cover loaded data, and the flights layer loads where you look.',
            'While Cockpit is active, navigate with control_cockpit (next/previous, optionally targetLayer or aircraftClass). track_entity and fly_to_location are REFUSED by design while Cockpit owns the camera — that refusal is correct, not an error to retry. To go somewhere else, exit Cockpit first. control_cockpit enter establishes Contacts itself, so do not call set_context_mode before or after it.',
            'When the target layer is unknown, OMIT layerId in track_entity so it searches all enabled layers. Passing the wrong layerId ("flights" for a military contact) returns "Nothing matched" even though the contact is loaded.',
            'If get_entity_context has no selected object or overlay entities, use its basemap context: Google Photorealistic 3D Tiles/Cesium source, center target coordinates, reverse-geocoded place, camera altitude, active style, and enabled layers. Do not say there is nothing unless the basemap target is also unavailable.',
            'If basemap context includes knownLandmarks, prefer the nearest known landmark by name for "what am I looking at" answers. For example, if knownLandmarks includes Eiffel Tower, say Eiffel Tower.',
            'At local zoom, use basemap nearbyPlaces, place.labels, viewportPlaces.visibleLabels, and viewportPlaces.streetLabels to identify the building, premises, roads, and named places visible around the screen target.',
            'If basemap context includes viewportPlaces, prefer dominantCountry, dominantRegion, and dominantLocality over raw coordinates.',
            'When basemap context includes viewportSamples or an inferred country, trust that over a single reverse-geocoded address. If most samples indicate Iran, say Iran, not the United States.',
            'When a viewport screenshot is attached after get_entity_context, read clearly legible street, building, and place labels from it and combine them with structured label context. Respect scene viewScale: at global/continental/regional scale, avoid naming a precise street/city from one center pixel.',
            'Do not mention disabled layers or stale selections.',
            'When a request requires a tool call, do not speak in the same response as the tool call. Call the tool first.',
            'When a single user request contains MULTIPLE changes (e.g. "switch to operator layout, use balanced detection at density 50, and switch to Bing aerial"), call ALL the corresponding tools — multiple tool calls in sequence — before speaking. Never confirm a partial subset. If a later tool fails, say which parts succeeded and which failed.',
            'After receiving tool output, speak exactly one short confirmation. Do not repeat the confirmation.',
            'For "show/open/turn on" layer requests, enable the matching layer. For "hide/close/turn off", disable it.',
            // INSTRUCTION-ONLY mapping for the two globe-scale named views.
            //
            // Both are BROADER than the first-run tiles on purpose. A person
            // naming layers out loud has chosen them; a tile is a first
            // impression handed to a stranger. So voice keeps fires in the
            // environmental view and keeps infrastructure entirely, while the
            // launcher's ENVIRONMENTAL tile is quakes-only and has no
            // infrastructure tile at all. See src/firstRunExperience.js for why.
            //
            // Fully expressible with tools that already exist, so
            // GEV_REALTIME_TOOLS is deliberately untouched — deleting this one
            // string is the whole rollback.
            'NAMED VIEWS are shorthand for tool calls you already have — there is no "mode" tool for them. Treat ONLY these as the shorthand: "infrastructure mode" / "the infrastructure view" / "show me global infrastructure" means three set_layer_visibility calls (local-datacenters, local-dams, telegeography-submarine-cables) plus zoom_to_globe; "environmental mode" / "earth watch" / "active events", said as the name of a view, means set_layer_visibility for local-firms and earthquakes plus zoom_to_globe. Anything vaguer is NOT this shorthand — an open-ended question about the world or the news is an ordinary question: answer it, or use analyst_query over the layers already on. Never switch a whole view on to answer a question nobody asked to see. When you do run one, make every call before speaking, then give one confirmation naming the resulting state; if the fires layer comes back unavailable because no FIRMS key is configured, say so plainly — the earthquakes still loaded. "Live contacts" and "space missions" are NOT this pattern: they stay set_context_mode{mode:"contacts"} and set_context_mode{mode:"space-missions"}.',
            'For visual filter requests, call set_visual_style with one of the allowed style IDs.',
            'Disambiguation table — basemap vs layer vs style: basemap switching requires an explicit stack name — "Bing aerial" means set_map_stack bing-aerial, "aerial with labels" means bing-labels, "OSM"/"road map" means osm, "Esri"/"Esri imagery" means esri-imagery, "Google 3D"/"photorealistic" means photoreal. Any mention of "satellite" or "satellites" ALWAYS means the satellites DATA LAYER via set_layer_visibility, never a basemap. "surveillance"/"night vision"/"thermal" are visual STYLES via set_visual_style.',
            'HUD requests ("hud on/off", "switch to operator/minimal/tactical layout") use set_hud. Detection requests ("detection on", "dense mode", "balanced mode", "sparse mode", "set density to 25", "use weighted allocation") use set_detection. Density snaps to 0/25/50/75/100 and derives Sparse/Balanced/Dense; panoptic is a legacy alias for Dense.',
            'Bloom/sharpen requests use set_post_processing. Scene requests ("play orbital watch", "stop the scene", "what scenes are there") use control_scene. CCTV camera requests ("next camera", "nearest camera", "select the Congress camera", "show coverage") use control_cctv — the CCTV layer must be enabled first.',
            'Radio playback requests use control_radio. "Turn on/start the radio" means action=play; action=enable only reveals Radio markers and must be reserved for explicit "show/enable the Radio layer/markers" requests. After a prepared playback result, briefly confirm any other completed actions and say "Turning on the radio"—never claim it is already playing. The client keeps Radio muted until playback is verified, then closes voice before restoring Radio volume. Examples: "play news near Austin" → select category=news locationId=austin; "play US news" → select category=news country=US; "Radio volume 30" → volume; pause/resume/stop/next/previous use the matching action. Radio selection never moves the camera.',
            '"Track/follow <something specific>" (a callsign, ship name, satellite name) uses track_entity. "Take me to the biggest fire" uses track_entity with query "biggest fire" (the fires layer must be enabled). Bare "orbit" means camera orbit of the current landmark. "Stop following/tracking" uses stop_tracking.',
            '"Show me which planes are overhead"/"frame the ships"/"show me the satellites above" use frame_overhead with the matching target.',
            "After frame_overhead, speak ONLY from the tool result's count field — e.g. 'Framed fourteen aircraft, labels on'; never reassess or second-guess the count aloud.",
            'Confirmations echo the RESULTING state, never the request: "HUD operator layout", "Density twenty-five percent", "Bing aerial imagery", "Tracking UAL428", "Framed fourteen aircraft". On ok=false, state the failure plainly: "Nothing matched UAL999", "No ships within 120 kilometers". Never claim an action without ok=true in the tool result.',
            'For destination requests such as "take me to Italy", "go to NYC", or "show me the Eiffel Tower", call fly_to_location. Prefer known city IDs when available; otherwise pass the plain place query.',
            'Navigation-only requests ("take me to X", "go to X", "fly to X") are NOT descriptions: call fly_to_location alone and do NOT also call annotate_map, unless the user explicitly asks to mark the place or you go on to explain specific places there. Never drop a point pin on a region-scale natural feature (a mountain range, desert, sea, or forest) — a single point in the middle of the Rockies is meaningless. If the user explicitly asks to mark such a region, prefer type=area.',
            'For country and city destinations, omit rangeM so GEV frames the whole country or city in view. For landmarks and buildings, omit rangeM so GEV chooses a close landmark view.',
            'Only supply rangeM when the user asks for a particular numeric height, distance, closer view, or wider view.',
            'For relative requests such as "zoom out a little", "pull back", "zoom in more", or "get closer", always call adjust_camera_zoom. But "globe view", "whole earth", "the whole planet", or "zoom all the way out" is an ABSOLUTE framing: call zoom_to_globe once instead — repeated adjust_camera_zoom calls can never reach the globe. Never claim the camera moved without the tool returning ok=true.',
            'Keep spoken confirmations short, e.g. "Opening datacenters" or "Flying to London".',
            'WHITEBOARD THE WORLD: whenever you describe or explain a specific place, building, campus, district, boundary, or a spatial relationship between places, call annotate_map to mark it visually as you talk — like sketching on the map. To call out a specific building, campus, compound, park, or district, use type=area (it traces and encloses the real footprint — a building gets a glowing volume, a district gets a draped outline). Use type=highlight only for a transient pulse on a precise spot that has no meaningful footprint, and type=pin to drop a labeled marker. Examples: "what is the Palace of Fine Arts?" → an AREA on it; "the old military base next to it" → an AREA on the Presidio; "ILM is right here" → a pin; "it sits next to the Marina" → an arrow from one to the other. Prefer place NAMES so the app resolves real positions and outlines; never invent coordinates or pixel locations.',
            'On every annotation, also set entityKind to what the thing IS when you know it: building (one structure), compound (campus/grounds/mall/park), district (neighborhood/area of a city), street (a named road), or point_feature (a monument, statue, memorial, plaque, fountain, or other small point landmark). entityKind is a FACT about the target, independent of the mark type you chose — monuments and statues are point_feature even when you use type=area; the app then anchors them as precise points instead of guessing at a footprint.',
            'Use a single annotate_map call with several annotations when you are describing multiple related places at once. Set flyTo true only when the user is not already looking at the place; if every mark in a call lands off-screen the app auto-frames them, so when unsure leave flyTo false. Do NOT say out loud that you are drawing, highlighting, or annotating — just speak naturally about the places while the marks appear. ANNOTATIONS ACCUMULATE AND PERSIST — keep adding marks as you explore; you can fly around, change topic, and jump between far-apart places and the marks STAY, so the user can build up the map and show people things. Do NOT clear on your own initiative: never pass clearPrevious, and call clear_annotations ONLY when the user EXPLICITLY asks to clear or reset the map.',
            'If an annotate_map result has partial:true or any failedLabels, do not pretend those places appeared — briefly work into your narration that you could not pinpoint them (e.g. "I couldn\'t place X"). If a route comes back as a direct line (no street route was found), describe it as a straight-line distance, not a walking/driving time. If an annotate_map result has capped:true, the map is full — ASK the user whether to clear before drawing more; do not clear unprompted. outlinePending:true is NOT a failure, but it is also NOT an outline: the anchor mark is placed and the boundary is still being traced in the background. Narrate it in progress — e.g. "tracing the boundary now" — and NEVER state the outline is already drawn or visible; it may yet come back as just a point. A later system item of type map_annotation_outline reports the final outcome per mark (status resolved or failed, with its label): use it to quietly confirm, or to correct yourself if you implied a boundary that stayed a point — an honest miss beats a misleading guess.',
            'PREFER NAMES. Only when you cannot name or geocode a place but you can clearly SEE the exact spot in the most recent viewport screenshot, fall back to screenX/screenY (normalized 0..1 from that image) to point at it; the app converts the pixel to a real world point. Never use screenX/screenY for something you could name.',
            'PATHS vs DISTANCES: for "walking/driving route from A to B" (or through several stops), use type=route with the ordered points and the matching mode (walking/driving/cycling) — the app draws the real street-following path on the map and reports distance and travel time, which you can read aloud. For "how far is X from Y", "is it nearby", or "X is next to Y", use type=arrow between the two — it draws a floating connector and shows the straight-line distance. Do NOT use route for a simple distance/proximity question.',
          ].join('\n'),
          tools: GEV_REALTIME_TOOLS,
          tool_choice: 'auto',
        },
      };

      try {
        const response = await fetch('https://api.openai.com/v1/realtime/client_secrets', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            'OpenAI-Safety-Identifier': 'gev-local-dev',
          },
          body: JSON.stringify(sessionConfig),
        });
        const body = await response.text();
        res.statusCode = response.status;
        res.setHeader('Content-Type', response.headers.get('content-type') || 'application/json');
        // Which tier/model this secret was actually minted for. The upstream
        // body is passed through untouched (the client parses it verbatim), so
        // these headers are the authoritative echo — including the case where a
        // bogus ?tier= was silently downgraded to standard.
        res.setHeader('X-GEV-Voice-Tier', tier);
        res.setHeader('X-GEV-Voice-Model', model);
        if (requestedTier && !isKnownVoiceTier(requestedTier)) {
          res.setHeader('X-GEV-Voice-Tier-Fallback', '1');
        }
        res.end(body);
      } catch (error) {
        res.statusCode = 502;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: error?.message || 'Failed to create Realtime token' }));
      }
    });
  }

  return {
    name: 'openai-realtime-proxy',
    configureServer(server) {
      install(server.middlewares);
    },
    configurePreviewServer(server) {
      install(server.middlewares);
    },
  };
}

function extractOpenAiResponseText(data) {
  if (typeof data?.output_text === 'string' && data.output_text.trim()) {
    return data.output_text.trim();
  }
  if (!Array.isArray(data?.output)) return '';
  return data.output
    .flatMap((item) => Array.isArray(item?.content) ? item.content : [])
    .map((part) => part?.text || part?.output_text || '')
    .join(' ')
    .trim();
}

function toFiveWordHudSummary(value) {
  return String(value || '')
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 5)
    .join(' ');
}



const GEV_REALTIME_TOOLS = [
  {
    type: 'function',
    name: 'fly_to_location',
    description: "Fly the God's Eye View camera to a known city, geocoded country/region/city/landmark, or explicit WGS84 coordinate. Countries/cities frame the whole place; landmarks/buildings use close framing.",
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        locationId: {
          type: 'string',
          enum: ['austin', 'sf', 'nyc', 'tokyo', 'london', 'paris', 'dubai', 'dc'],
          description: 'Known city preset ID. Use when the requested place matches one of these cities.',
        },
        query: {
          type: 'string',
          description: 'Plain place search query, e.g. "London", "Eiffel Tower", or "Dubai Marina".',
        },
        latitude: { type: 'number', minimum: -90, maximum: 90 },
        longitude: { type: 'number', minimum: -180, maximum: 180 },
        viewMode: {
          type: 'string',
          enum: ['close', 'overview'],
          description: 'Optional framing intent. Usually omit this; GEV infers whole-place framing for countries/cities and close framing for landmarks.',
        },
        rangeM: {
          type: 'number',
          minimum: 100,
          maximum: 20000000,
          description: 'Optional camera range from the target in meters. Omit it for automatic whole-country/whole-city or close-landmark framing; provide it only when the user explicitly requests a numeric height or distance.',
        },
        waitForArrival: {
          type: 'boolean',
          description: 'Set true when a later tool depends on the destination viewport. The result then waits for the camera flight and returns arrived=true; cancellation returns ok=false.',
        },
      },
    },
  },
  {
    type: 'function',
    name: 'select_nearest_aircraft',
    description: 'Atomically fly to a place, wait for arrival, enable and load Flights or Military Flights in that viewport, exclude on-ground records, and select/follow the nearest airborne aircraft. Healthy fallback feeds remain usable and are reported in the result. This does not open Contacts or Cockpit.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        layerId: {
          type: 'string',
          enum: ['flights', 'military'],
          description: 'Aircraft layer to enable and search. Use flights unless the user explicitly asks for military aircraft.',
        },
        locationId: {
          type: 'string',
          enum: ['austin', 'sf', 'nyc', 'tokyo', 'london', 'paris', 'dubai', 'dc'],
          description: 'Known city preset ID when the place matches one of these cities.',
        },
        locationQuery: {
          type: 'string',
          maxLength: 160,
          description: 'Free-form destination when no locationId matches.',
        },
        latitude: { type: 'number', minimum: -90, maximum: 90 },
        longitude: { type: 'number', minimum: -180, maximum: 180 },
      },
      required: ['layerId'],
    },
  },
  {
    type: 'function',
    name: 'adjust_camera_zoom',
    description: 'Move the current Cesium camera closer to or farther from what it is presently looking at. Use for relative zoom requests without changing location.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        direction: {
          type: 'string',
          enum: ['in', 'out'],
        },
        amount: {
          type: 'string',
          enum: ['little', 'medium', 'lot'],
          description: 'Use little for phrases like "a bit" or "a little", medium for ordinary zoom requests, and lot for "way out/in".',
        },
      },
      required: ['direction', 'amount'],
    },
  },
  {
    type: 'function',
    name: 'zoom_to_globe',
    description: 'Pull the camera out to an ABSOLUTE full-Earth globe view (~18,000 km altitude, the whole planet in frame), keeping the current region centered. Use for "globe view", "whole earth", "see the planet", "zoom all the way out". Never use adjust_camera_zoom for these — its relative steps cannot reach the globe.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
  },
  {
    type: 'function',
    name: 'set_layer_visibility',
    description: "Enable or disable one registered God's Eye View data layer.",
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        layerId: {
          type: 'string',
          description:
            'Common-name mapping for the non-obvious ids: space mission(s) → rocket-launches; fires/wildfires/active fires → local-firms (NASA FIRMS); ships/vessels/boats → ais-live-vessels; undersea/submarine cables → telegeography-submarine-cables; datacenters → local-datacenters; dams → local-dams; bikes/bike share → bikeshare; street traffic/congestion → traffic; traffic cameras → cctv; internet radio/stations → radio.',
          enum: [
            'flights',
            'military',
            'earthquakes',
            'satellites',
            'rocket-launches',
            'traffic',
            'cctv',
            'radio',
            'bikeshare',
            'ais-live-vessels',
            'local-datacenters',
            'local-dams',
            'telegeography-submarine-cables',
            'local-firms',
          ],
        },
        enabled: { type: 'boolean' },
      },
      required: ['layerId', 'enabled'],
    },
  },
  {
    type: 'function',
    name: 'show_data_layers_menu',
    description: 'Open the data layers dropdown/menu and optionally scroll to a specific layer row without toggling it.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        layerId: {
          type: 'string',
          enum: [
            'flights',
            'military',
            'earthquakes',
            'satellites',
            'traffic',
            'cctv',
            'radio',
            'bikeshare',
            'ais-live-vessels',
            'local-datacenters',
            'local-dams',
            'telegeography-submarine-cables',
            'local-firms',
          ],
          description: 'Optional layer row to scroll into view and highlight.',
        },
      },
    },
  },
  {
    type: 'function',
    name: 'set_panel_open',
    description: 'Open or close a GEV UI panel/dropdown.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        panelId: {
          type: 'string',
          enum: ['data-panel', 'location-bar', 'control-panel', 'cctv-panel', 'radio-panel', 'scene-panel', 'pp-toggles', 'global-context-panel'],
        },
        open: { type: 'boolean' },
      },
      required: ['panelId', 'open'],
    },
  },
  {
    type: 'function',
    name: 'set_context_mode',
    description: 'Enter or exit the Global Context sub-mode used by Contacts and Space Missions. Use Contacts only when the user explicitly requests Contacts, and Space Missions only when explicitly requested. A request to open the parent Context panel alone uses set_panel_open and must not activate either sub-mode. Selecting an aircraft does not imply Context.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        mode: {
          type: 'string',
          enum: ['off', 'contacts', 'flights', 'space-missions', 'missions'],
          description: 'Use off to exit context mode.',
        },
      },
      required: ['mode'],
    },
  },
  {
    type: 'function',
    name: 'control_cockpit',
    description: 'Read or control Cockpit when the user explicitly requests Cockpit: establish Contacts and enter from a selected or tracked aircraft; exit; or navigate nearby Contacts with optional filters. Selecting or viewing an aircraft alone must not enter Cockpit.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: ['enter', 'exit', 'previous', 'next', 'prev', 'status'],
          description: 'previous/next (or prev) navigates through nearby contacts in Cockpit context.',
        },
        targetLayer: {
          type: 'string',
          enum: ['flights', 'military', 'ais-live-vessels', 'military-installations'],
          description: 'Optional contact layer filter for next/previous (for example military for a military-only cycle).',
        },
        aircraftClass: {
          type: 'string',
          description: 'Optional aircraft class filter (for example helicopter) when using next/previous navigation.',
        },
      },
      required: ['action'],
    },
  },
  {
    type: 'function',
    name: 'set_visual_style',
    description: "Set the active God's Eye View visual filter/style.",
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        style: {
          type: 'string',
          enum: ['normal', 'retro', 'surveillance', 'thermal', 'anime', 'noir', 'snow'],
        },
      },
      required: ['style'],
    },
  },
  {
    type: 'function',
    name: 'get_entity_context',
    description: 'Get current GEV scene context, including basemap/3D-tile target context, selected entity metadata if active, and entities currently visible in the camera view.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        scope: {
          type: 'string',
          enum: ['auto', 'selected', 'in_view'],
          description: 'Use auto by default. selected returns the clicked/selected entity; in_view returns visible entities near the screen center.',
        },
        layerId: {
          type: 'string',
          enum: [
            'local-datacenters',
            'local-dams',
            'telegeography-submarine-cables',
            'local-firms',
          ],
          description: 'Optional layer filter for visible entity context.',
        },
        limit: {
          type: 'number',
          minimum: 1,
          maximum: 12,
        },
      },
    },
  },
  {
    type: 'function',
    name: 'get_current_view_state',
    description: 'Read the current camera, style, Context, Cockpit, HUD, detection, map stack, post-processing, scene-playback, tracked-entity, and layer state before choosing another action.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
  },
  {
    type: 'function',
    name: 'set_hud',
    description: 'Control the intelligence HUD overlay: visibility and/or layout variant.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        visible: { type: 'string', enum: ['on', 'off', 'auto'], description: 'auto restores style-driven show/hide.' },
        layout: { type: 'string', enum: ['tactical', 'operator', 'minimal'] },
      },
    },
  },
  {
    type: 'function',
    name: 'set_detection',
    description: 'Control the detection overlay: on/off, density-derived Sparse/Balanced/Dense profile, and Elastic/Weighted layer allocation.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        enabled: { type: 'boolean', description: 'false turns detection OFF; true restores the current density-derived profile.' },
        mode: { type: 'string', enum: ['sparse', 'balanced', 'dense'] },
        densityPct: { type: 'number', description: 'Density snaps to 0, 25, 50, 75, or 100 and derives the active profile.' },
        allocationStrategy: { type: 'string', enum: ['elastic', 'weighted'], description: 'Elastic splits evenly then lends unused slots; Weighted follows demand and semantic weight.' },
      },
    },
  },
  {
    type: 'function',
    name: 'set_map_stack',
    description: 'Switch the basemap/imagery stack (NOT the satellites data layer and NOT a visual style filter).',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        stack: {
          type: 'string',
          enum: ['photoreal', 'bing-aerial', 'bing-labels', 'esri-imagery', 'osm'],
          description: 'photoreal = Google 3D. Use bing-aerial only when the user explicitly says "Bing aerial" — "satellite(s)" never means a basemap; only the explicit phrase "Esri" / "Esri imagery" means esri-imagery.',
        },
      },
      required: ['stack'],
    },
  },
  {
    type: 'function',
    name: 'set_post_processing',
    description: 'Control bloom and sharpen post-processing toggles and intensities.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        bloom: {
          type: 'object',
          additionalProperties: false,
          properties: {
            enabled: { type: 'boolean' },
            intensityPct: { type: 'number', description: '0-200 (UI percent).' },
          },
        },
        sharpen: {
          type: 'object',
          additionalProperties: false,
          properties: {
            enabled: { type: 'boolean' },
            intensityPct: { type: 'number', description: '0-100 (UI percent).' },
          },
        },
      },
    },
  },
  {
    type: 'function',
    name: 'control_scene',
    description: 'Cinematic scene playback: list scenes, play one scene by name, stop, advance, or read status. Play starts a single named scene and returns immediately.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['list', 'play', 'stop', 'next', 'status'] },
        sceneId: { type: 'string', description: 'Scene id or (partial) title for play.' },
      },
      required: ['action'],
    },
  },
  {
    type: 'function',
    name: 'control_cctv',
    description: 'CCTV camera operations: enable/disable the layer, select a camera by name, next/prev/nearest/focus, toggle coverage wedges / projection overlay / auto-hop, "viewshed" for color-coded per-camera coverage volumes, and "adjust" for the on-camera calibration gizmo.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['enable', 'disable', 'select', 'next', 'prev', 'nearest', 'focus', 'coverage', 'viewshed', 'adjust', 'projection', 'autohop'] },
        cameraQuery: { type: 'string', description: 'Camera name or id for select.' },
        enabled: { type: 'boolean', description: 'Explicit on/off for coverage/viewshed/adjust/projection/autohop; omit to toggle.' },
      },
      required: ['action'],
    },
  },
  {
    type: 'function',
    name: 'control_radio',
    description: 'Control Internet Radio playback without moving the map. Use select whenever the request includes a station category, name, country, coordinates, or nearby place—even when the user says play. Use play only for an unqualified "turn on/start the radio" request so the current or nearest station begins. Enable only reveals the Radio layer/markers without audio. Also supports disable, resume, pause, stop, next/previous, volume, and status.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: ['enable', 'disable', 'play', 'resume', 'pause', 'stop', 'next', 'previous', 'volume', 'select', 'status'],
          description: 'Use select for any request qualified by category, station, country, coordinates, or place. Use play only for an unqualified turn on/start/listen request. Use enable only when the user explicitly asks to show or enable the Radio layer or its markers without requesting audio.',
        },
        volumePct: { type: 'number', minimum: 0, maximum: 100, description: 'Required for volume; sets the persistent Radio playback volume.' },
        category: {
          type: 'string',
          enum: ['all', 'news', 'talk', 'weather', 'public-safety', 'aviation-marine', 'traffic-transit', 'music'],
          description: 'Station category for select/next/previous. When the user requests playback with a category, action must be select, not play.',
        },
        locationId: {
          type: 'string',
          enum: ['austin', 'sf', 'nyc', 'tokyo', 'london', 'paris', 'dubai', 'dc'],
          description: 'Known nearby-city anchor for select.',
        },
        locationQuery: { type: 'string', maxLength: 120, description: 'Place to search near, such as "Austin, Texas" or "Seattle". Selection does not fly the camera.' },
        latitude: { type: 'number', minimum: -90, maximum: 90 },
        longitude: { type: 'number', minimum: -180, maximum: 180 },
        country: { type: 'string', maxLength: 80, description: 'Country code or name filter, for example US or United States.' },
        stationQuery: { type: 'string', maxLength: 120, description: 'Optional station name/tag substring.' },
      },
      required: ['action'],
    },
  },
  {
    type: 'function',
    name: 'track_entity',
    description: 'Find and follow a specific aircraft (callsign/ICAO hex), ship (name/MMSI), or satellite (name/NORAD id) on enabled layers. Camera follows the entity.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: 'Callsign, ship name, satellite name, ICAO hex, MMSI, or NORAD id.' },
        layerId: { type: 'string', description: 'Optional layer hint: flights | military | ais-live-vessels | satellites.' },
      },
      required: ['query'],
    },
  },
  {
    type: 'function',
    name: 'stop_tracking',
    description: 'Stop following the tracked aircraft/satellite and clear any selected vessel.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
  },
  {
    type: 'function',
    name: 'frame_overhead',
    description: 'Cinematically frame entities near the current view: pulls the camera back and angles it so nearby aircraft, ships, or satellites are visible together.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        target: { type: 'string', enum: ['flights', 'military', 'satellites', 'vessels'] },
        radiusKm: { type: 'number', description: 'Search radius around the view target. Defaults: 150 aircraft, 120 ships, 3000 satellites.' },
      },
      required: ['target'],
    },
  },
  {
    type: 'function',
    name: 'annotate_map',
    description: "Draw annotations on the 3D map to visually point out what you are talking about — like sketching on a whiteboard over the world. Use this whenever you mention a specific place, building, campus, boundary, district, or a relationship between two places, so the user can SEE what you mean. Give place NAMES (preferred) or explicit lat/lng; the app resolves them to real-world positions and real building/area outlines — never guess pixel positions. Call this as you begin describing something, and you may mark several places in one call.",
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        annotations: {
          type: 'array',
          description: 'One or more things to mark. Mark multiple related places together when describing them as a group.',
          minItems: 1,
          maxItems: 24,
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              type: {
                type: 'string',
                enum: ['pin', 'highlight', 'area', 'arrow', 'route', 'label'],
                description: 'pin = planted marker at a spot; highlight = pulsing ring drawing the eye to a point; area = trace the outline of a building/campus/compound/district; arrow = a connector from one place to another (use target as the origin and toTarget as the destination); route = a path through several waypoints (use the points array); label = a floating text callout.',
              },
              target: { type: 'string', maxLength: 200, description: 'Place name to resolve, e.g. "Palace of Fine Arts, San Francisco", "the Pentagon", "Presidio of San Francisco". Preferred over coordinates. For a specific monument/statue/feature that sits within a larger landmark, use its OWN name + city ("Tejano Monument, Austin", "Texas African American History Memorial, Austin") — do NOT phrase it as "X at the Texas State Capitol", which makes the geocoder collapse several of them onto the same centroid so they stack on one spot.' },
              points: {
                type: 'array',
                description: 'For type=route: 2+ ordered waypoints the path passes through, each a place name (or coordinates / screen point).',
                minItems: 2,
                maxItems: 12,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    target: { type: 'string', maxLength: 200, description: 'Waypoint place name.' },
                    latitude: { type: 'number', minimum: -90, maximum: 90 },
                    longitude: { type: 'number', minimum: -180, maximum: 180 },
                    screenX: { type: 'number', minimum: 0, maximum: 1 },
                    screenY: { type: 'number', minimum: 0, maximum: 1 },
                  },
                },
              },
              mode: {
                type: 'string',
                enum: ['walking', 'driving', 'cycling'],
                description: 'For type=route: travel mode for a real street-following route (the app returns distance + time). Pick from the verb the user used ("walk" → walking, "drive" → driving). Defaults to walking.',
              },
              latitude: { type: 'number', minimum: -90, maximum: 90, description: 'Explicit latitude (use only if no good place name exists).' },
              longitude: { type: 'number', minimum: -180, maximum: 180 },
              toTarget: { type: 'string', maxLength: 200, description: 'For type=arrow: the destination place name.' },
              toLatitude: { type: 'number', minimum: -90, maximum: 90 },
              toLongitude: { type: 'number', minimum: -180, maximum: 180 },
              label: { type: 'string', maxLength: 120, description: 'Short caption shown on the map (a few words). Optional.' },
              color: {
                type: 'string',
                enum: ['primary', 'amber', 'cyan', 'green', 'red'],
                description: 'Accent color. primary = neutral, amber = point of interest, cyan = infrastructure, green = confirmed/safe, red = alert.',
              },
              footprint: { type: 'boolean', description: 'For type=area/highlight: trace the real building or campus outline from map data. Defaults true for area.' },
              intent: { type: 'string', enum: ['the_thing', 'around_the_thing'], description: 'For type=area: "the_thing" (default) outlines the place itself (its footprint/boundary); "around_the_thing" highlights a surrounding zone (a buffered radius around it). Infer from phrasing: "the Capitol"/"show me X" → the_thing; "around/near/by X" or "the area around X" → around_the_thing.' },
              entityKind: { type: 'string', enum: ['building', 'compound', 'district', 'street', 'point_feature'], description: 'What KIND of thing the target IS — a fact, not a style choice: building = one structure; compound = campus/grounds/mall/park; district = neighborhood or area of a city; street = a named road/corridor; point_feature = monument/statue/memorial/plaque/fountain or other small point landmark. Set it whenever you know it — it routes the resolver to the right footprint source (point_feature anchors monuments as precise points instead of adopting a nearby building outline).' },
              screenX: { type: 'number', minimum: 0, maximum: 1, description: 'Fallback only: when you cannot name/geocode the place but can SEE it in the latest viewport screenshot, the normalized horizontal position (0=left, 1=right) of the spot. The app converts it back to a real world point under that pixel.' },
              screenY: { type: 'number', minimum: 0, maximum: 1, description: 'Fallback only: normalized vertical position (0=top, 1=bottom) of the spot in the latest viewport screenshot.' },
              toScreenX: { type: 'number', minimum: 0, maximum: 1, description: 'For type=arrow: normalized x of the arrow destination from the screenshot (pixel fallback).' },
              toScreenY: { type: 'number', minimum: 0, maximum: 1, description: 'For type=arrow: normalized y of the arrow destination from the screenshot (pixel fallback).' },
            },
            required: ['type'],
          },
        },
        flyTo: { type: 'boolean', description: 'Also move the camera to frame the first annotation. Default false — leave false if the user is already looking at the spot.' },
        persist: { type: 'boolean', description: 'Keep annotations until cleared (true, default) or let them auto-fade after ~20s (false).' },
      },
      required: ['annotations'],
    },
  },
  {
    type: 'function',
    name: 'clear_annotations',
    description: 'Erase ALL map annotations previously drawn with annotate_map. Call this ONLY when the user EXPLICITLY asks to clear or reset the map. Annotations accumulate and persist across navigation and topic changes by design — never clear on your own initiative.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
  },
  {
    type: 'function',
    name: 'move_camera',
    description: 'Direct the camera like a drone operator: orbit the current view target, pan, tilt, or rotate — one bounded nudge (mode=once) or continuous motion until stopped (mode=continuous). Continuous motion also stops on any manual camera input or when a navigation tool runs. Say the RESULTING state when confirming ("Orbiting slowly").',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        motion: { type: 'string', enum: ['orbit', 'pan', 'tilt', 'rotate', 'stop'] },
        direction: { type: 'string', enum: ['left', 'right', 'up', 'down'], description: 'Required except for orbit (defaults right/clockwise) and stop.' },
        speed: { type: 'string', enum: ['slow', 'normal', 'fast'] },
        mode: { type: 'string', enum: ['once', 'continuous'], description: 'once = bounded eased nudge (default); continuous = until stop/manual input.' },
      },
      required: ['motion'],
    },
  },
  {
    type: 'function',
    name: 'fly_route',
    description: 'Cinematic dolly along an EXISTING route annotation (drawn earlier with annotate_map type=route) — flies the street-following path from start to end. Omit label for the newest route. If no route is drawn, this fails with guidance: draw the route first.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        label: { type: 'string', description: 'Match an existing route mark by (partial) label.' },
        speed: { type: 'string', enum: ['slow', 'normal', 'fast'] },
      },
    },
  },
  {
    type: 'function',
    name: 'analyst_query',
    description: 'Answer questions ABOUT the data currently loaded on the map — counts, lists, superlatives, and attribute filters over live layers (flights, military, ships, fires, earthquakes). Examples: "how many flights over Texas", "biggest fire near LA", "which ships are headed to Oakland", "anything above 40,000 feet", "fastest thing in view". Queries ONLY client-side data from ENABLED layers — if the needed layer is off, say so and offer to enable it. For a follow-up about the previous answer\'s set ("which of those is closest?"), set followUp=true and send only the new filters/sort.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        layers: {
          type: 'array',
          items: { type: 'string', enum: ['flights', 'military', 'ais-live-vessels', 'local-firms', 'earthquakes'] },
          description: 'Layers to query. fires/wildfires → local-firms; ships/vessels → ais-live-vessels.',
        },
        scope: {
          type: 'object',
          additionalProperties: false,
          description: 'Spatial scope. Default: view (near the camera). Use kind=region for "over Texas"-style asks; kind=anywhere for global questions.',
          properties: {
            kind: { type: 'string', enum: ['view', 'region', 'radius', 'anywhere'] },
            name: { type: 'string', description: 'For kind=region: a state/country ("Texas", "France") or a named natural region ("the Alps", "Gulf of Mexico").' },
            km: { type: 'number', description: 'For kind=radius.' },
            center: { type: 'object', additionalProperties: false, properties: { lat: { type: 'number' }, lon: { type: 'number' } } },
          },
        },
        filters: {
          type: 'array',
          description: 'Attribute predicates, ANDed. ALTITUDE IS METERS (40,000 ft = 12192). Fields: altitudeM, speedMps, military, onGround, aircraftClass, callsign, operator, routeOrigin, routeDestination, originCountry (flights); speedKts, shipType, destination (ships); frp, confidence (fires); magnitude, depthKm, place (earthquakes).',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              field: { type: 'string' },
              op: { type: 'string', enum: ['gt', 'gte', 'lt', 'lte', 'eq', 'neq', 'contains'] },
              value: {},
            },
            required: ['field', 'op', 'value'],
          },
        },
        sortBy: { type: 'string', description: 'Field to rank by, or "distance" for nearest-first.' },
        sortDir: { type: 'string', enum: ['asc', 'desc'] },
        limit: { type: 'number' },
        followUp: { type: 'boolean', description: 'true = re-query the PREVIOUS result set instead of fresh data.' },
      },
    },
  },
  {
    type: 'function',
    name: 'next_iss_pass',
    description: "When the user asks when the ISS / the space station will next fly over: returns the next visible ISS pass for the current camera location (or an explicit lat/lon) — rise time (ISO + minutes from now), rise compass direction, peak elevation, and duration. Requires the satellites layer to have loaded its catalog at least once this session; if it hasn't, tell the user to enable the satellites layer and try again.",
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        latitude: { type: 'number', minimum: -90, maximum: 90, description: 'Optional observer latitude. Omit to use the current camera position.' },
        longitude: { type: 'number', minimum: -180, maximum: 180, description: 'Optional observer longitude. Omit to use the current camera position.' },
        minElevationDeg: { type: 'number', minimum: 5, maximum: 60, description: 'Minimum peak elevation (deg) to count as a pass. Default 10.' },
      },
    },
  },
];

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
