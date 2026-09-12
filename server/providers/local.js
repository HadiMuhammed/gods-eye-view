/**
 * Local Node provider middleware for God's Eye View.
 *
 * Registers the dev-server proxy middlewares that bypass CORS and add
 * caching/auth for upstream APIs:
 *   1. OpenSky — aircraft state vectors (OAuth / Basic / anon)
 *   2. CelesTrak — satellite TLE orbital elements
 *   3. Overpass — OpenStreetMap road geometry queries
 *   4. GBFS — bike-share station feeds
 *   5. CCTV — traffic-camera frames, media streams, and fallback SVG
 *   6. adsb.lol — military aircraft tracking
 *   7. AIS live — AISStream websocket-backed live vessel positions
 *   8. Terrain heights — Re:Earth keyless point-height lookups (ellipsoidal ground)
 *   9. TomTom — live traffic-flow vector tiles (budget-governed, keyless-degradable)
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

// --- Imports (Deduplicated) ---
import { openSkyProxy, adsbLolFallbackAnchor } from './aircraft/opensky.js';
import { adsbLolProxy } from './aircraft/adsb-lol.js';
import { adsbdbProxy } from './aircraft/enrichment.js';
import { trackBackfillProxies } from './aircraft/tracks.js';
import { celestrakProxy, rocketLaunchesProxy } from './space.js';
import { tomtomProxy } from './traffic.js';
import { firmsProxy } from './firms.js';
import { noaaHazardsProxy } from './noaa.js';
import { terrainHeightsProxy } from './terrain.js';
import { overpassProxy } from './overpass.js';
import { militaryInstallationsProxy } from './military-installations.js';
import { regionalBriefProxy } from './regional/briefing.js';
import { weatherEffectsProxy } from './regional/weather-effects.js';
import { cctvProxy } from './cctv.js';
import { defaultSourceRoot } from './common/source-root.js';
import { radioBrowserProxy } from './radio.js';
import { gbfsProxy } from './gbfs.js';
import { aisLiveProxy } from './vessels/ais-live.js';
import { openAiRealtimeProxy } from './openai.js';
import { 
  googlePlacesContextProxy, 
  googleServerApiKey, 
  keylessGooglePlacesResponse, 
  installRouteMiddleware, 
  makeRateLimiter, 
  makeOptInRateLimiter, 
  clientKey, 
  haversineKm 
} from './places.js';
import { keySetupEndpoint } from '../standalone/key-setup.js';

/** Construct the local provider plugins in their established order. */
function localProviderPlugins() {
  return [
    openSkyProxy(),
    celestrakProxy(),
    tomtomProxy(),
    firmsProxy(),
    noaaHazardsProxy(), // Your NWS hazard alerts layer
    rocketLaunchesProxy(),
    terrainHeightsProxy(),
    adsbdbProxy(),
    overpassProxy(),
    militaryInstallationsProxy(),
    regionalBriefProxy(),
    weatherEffectsProxy(),
    cctvProxy({ sourceRoot: defaultSourceRoot }),
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

// --- Exports (Deduplicated & Fully Preserved) ---
export { localProviderPlugins };

export {
  CCTV_FRAME_FETCH_TIMEOUT_MS,
  fetchCctvImageFromUpstream,
} from './cctv.js';
export {
  createRadioProxyMiddleware,
  isPublicRadioAddress,
  normalizeRadioBrowserStation,
  publicRadioStation,
  publicRadioHttpsUrl,
} from './radio.js';
export { LL2_CACHE_TTL_MS, launchLibraryRequestHeaders } from './space.js';
export { googlePlacesContextProxy, googleServerApiKey, keylessGooglePlacesResponse } from './places.js';
export { adsbLolFallbackAnchor } from './aircraft/opensky.js';
export { readResponseTextCapped, readResponseJsonCapped, coalesceProxyRequest } from './common/http.js';
export { requiredFiniteQueryNumber } from './common/query.js';
export { isOverpassBoundaryQuery } from './overpass/query.js';
export { simplifyOverpassPayloadBody } from './overpass/geometry.js';
export { readOverpassDisk, resolveOverpassPreflight } from './overpass/cache.js';
export { overpassPayloadIsData, fetchOverpassPayload } from './overpass/transport.js';
export { openAiRealtimeProxy } from './openai.js';
export { MILITARY_INSTALLATION_ELEMENT_CAP } from './military-installations/constants.js';
export { 
  quantizeMilitaryInstallationBox, 
  militaryInstallationCacheKey, 
  validMilitaryInstallationBox, 
  militaryInstallationFailureReason 
} from './military-installations/query.js';
export { 
  resolveMilitaryInstallationTier, 
  migrateMilitaryInstallationEntry, 
  militaryInstallationDiskFresh, 
  militaryInstallationDiskPath, 
  readMilitaryInstallationDisk, 
  writeMilitaryInstallationDisk 
} from './military-installations/cache.js';
export { validRegionalPoint } from './regional/query.js';
export { regionalBriefHasAnySource } from './regional/briefing.js';