import { readResponseJsonCapped } from './common/http.js';

const GLOBALPING_API_URL = 'https://api.globalping.io/v1/measurements';
const MAX_RESPONSE_BYTES = 256 * 1024;
const DEFAULT_LIMIT = 20;
const DEFAULT_CONTINENT = 'EU';
const POLL_ATTEMPTS = 25;
const POLL_DELAY_MS = 3000;

function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function parseLimit(value) {
  if (value === null || value === '') return DEFAULT_LIMIT;
  const limit = Number.parseInt(value, 10);
  return Number.isInteger(limit) && limit > 0 && limit <= 100 ? limit : null;
}

function normalizeContinent(value) {
  const continent = String(value ?? DEFAULT_CONTINENT).trim();
  if (!continent) return '';
  return /^[A-Za-z]{2}$/.test(continent) ? continent.toUpperCase() : null;
}

function requestBearerToken(req, url) {
  const authorization = String(req.headers?.authorization || '');
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || url.searchParams.get('token')?.trim() || process.env.GLOBALPING_TOKEN || '';
}

/** Convert GlobalPing probe RTTs into a spherical weighted centroid. */
export function estimateCoordinatesSphericalWeighted(landmarks) {
  if (!landmarks.length) return { success: false, message: 'No valid landmark data received.' };

  let totalWeight = 0;
  let xSum = 0;
  let ySum = 0;
  let zSum = 0;
  let validProbes = 0;

  for (const landmark of landmarks) {
    const weight = Math.exp(-0.05 * landmark.min_rtt_ms);
    const lat = landmark.lat * Math.PI / 180;
    const lon = landmark.lon * Math.PI / 180;
    const x = Math.cos(lat) * Math.cos(lon);
    const y = Math.cos(lat) * Math.sin(lon);
    const z = Math.sin(lat);
    xSum += x * weight;
    ySum += y * weight;
    zSum += z * weight;
    totalWeight += weight;
    validProbes += 1;
  }

  if (totalWeight === 0 || validProbes === 0) {
    return { success: false, message: 'Calculation weight evaluated to zero.' };
  }

  const xAverage = xSum / totalWeight;
  const yAverage = ySum / totalWeight;
  const zAverage = zSum / totalWeight;
  const latitude = Math.atan2(zAverage, Math.sqrt(xAverage ** 2 + yAverage ** 2)) * 180 / Math.PI;
  const longitude = Math.atan2(yAverage, xAverage) * 180 / Math.PI;
  return { lat: latitude, lon: longitude, success: true, valid_probes: validProbes };
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function distanceKm(first, second) {
  const lat1 = first.lat * Math.PI / 180;
  const lat2 = second.lat * Math.PI / 180;
  const dLat = lat2 - lat1;
  const dLon = (second.lon - first.lon) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Refine the Python estimate without letting several probes in one city count
 * as several independent geographic locations. The original estimate remains
 * available for comparison and auditability.
 */
export function estimateCoordinatesRefined(landmarks) {
  const groups = new Map();
  for (const landmark of landmarks) {
    const key = `${Math.round(landmark.lat * 10)},${Math.round(landmark.lon * 10)}`;
    const group = groups.get(key) || { ...landmark, rtts: [] };
    group.rtts.push(landmark.min_rtt_ms);
    groups.set(key, group);
  }
  const representatives = [...groups.values()].map((group) => ({
    name: group.name,
    lat: group.lat,
    lon: group.lon,
    min_rtt_ms: median(group.rtts),
    probe_count: group.rtts.length,
  }));
  const estimate = estimateCoordinatesSphericalWeighted(representatives);
  if (!estimate.success) return estimate;

  const center = { lat: estimate.lat, lon: estimate.lon };
  const weightedDistances = representatives.map((landmark) => {
    const weight = Math.exp(-0.05 * landmark.min_rtt_ms);
    return { distance: distanceKm(center, landmark), weight };
  });
  const totalWeight = weightedDistances.reduce((sum, item) => sum + item.weight, 0);
  const spreadKm = Math.sqrt(weightedDistances.reduce((sum, item) => sum + item.weight * item.distance ** 2, 0) / totalWeight);
  return {
    ...estimate,
    valid_probes: landmarks.length,
    unique_locations: representatives.length,
    spread_km: spreadKm,
    method: 'spherical RTT centroid with co-located probes collapsed by median RTT',
  };
}

function extractLandmarks(results) {
  const landmarks = [];
  for (const item of results || []) {
    const probe = item?.probe || {};
    const result = item?.result || {};
    if (result.error || !probe.latitude || !probe.longitude) continue;
    const minRtt = result.stats?.min;
    if (minRtt === undefined || minRtt === null || minRtt <= 0) continue;
    landmarks.push({
      name: `${probe.city || 'Unknown'}, ${probe.country || 'Unknown'}`,
      lat: Number(probe.latitude),
      lon: Number(probe.longitude),
      min_rtt_ms: Number(minRtt),
    });
  }
  return landmarks;
}

async function readJson(fetchImpl, url, options) {
  const response = await fetchImpl(url, options);
  const data = await readResponseJsonCapped(response, MAX_RESPONSE_BYTES);
  return { response, data };
}

/** Equivalent of Python's `fetch_live_landmarks`. */
export async function fetchLiveLandmarks(target, { limit = DEFAULT_LIMIT, continent = DEFAULT_CONTINENT, apiToken = '', fetchImpl = fetch, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  const payload = {
    type: 'ping',
    target,
    limit,
    measurementOptions: { packets: 3 },
  };
  if (continent) payload.locations = [{ continent }];

  const headers = { 'Content-Type': 'application/json' };
  if (apiToken) headers.Authorization = `Bearer ${apiToken}`;
  const create = await readJson(fetchImpl, GLOBALPING_API_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10_000),
  });
  if (create.response.status !== 202) {
    const error = new Error('Failed to create GlobalPing measurement');
    error.status = create.response.status;
    error.details = create.data;
    throw error;
  }

  const measurementId = create.data?.id;
  if (!measurementId) throw Object.assign(new Error('GlobalPing did not return a measurement ID'), { status: 502 });

  for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt += 1) {
    await sleep(POLL_DELAY_MS);
    try {
      const result = await readJson(fetchImpl, `${GLOBALPING_API_URL}/${encodeURIComponent(measurementId)}`, {
        headers,
        signal: AbortSignal.timeout(10_000),
      });
      if (result.data?.status === 'finished') {
        return extractLandmarks(result.data.results);
      }
    } catch {
      // The Python implementation ignores an individual failed poll.
    }
  }
  throw Object.assign(new Error('Timed out waiting for GlobalPing results'), { status: 504 });
}

/** Create the testable middleware backing `/server/ip-tracker`. */
export function createIpTrackerMiddleware({ fetchImpl = fetch, sleep } = {}) {
  return async function ipTrackerMiddleware(req, res, next) {
    if (req.method !== 'GET') return next?.();

    const url = new URL(req.url || '/', 'http://localhost');
    const target = String(url.searchParams.get('q') || '').trim();
    const limit = parseLimit(url.searchParams.get('limit'));
    const continent = normalizeContinent(url.searchParams.get('continent'));
    if (!target) return sendJson(res, 400, { error: 'q is required' });
    if (target.length > 253) return sendJson(res, 400, { error: 'q is too long' });
    if (limit === null) return sendJson(res, 400, { error: 'limit must be an integer from 1 to 100' });
    if (continent === null) return sendJson(res, 400, { error: 'continent must be a two-letter code' });

    try {
      const landmarks = await fetchLiveLandmarks(target, {
        limit,
        continent,
        apiToken: requestBearerToken(req, url),
        fetchImpl,
        sleep,
      });
      const estimation = estimateCoordinatesSphericalWeighted(landmarks);
      const refinedEstimation = estimateCoordinatesRefined(landmarks);
      return sendJson(res, 200, {
        target,
        landmarks,
        estimation,
        refined_estimation: refinedEstimation,
        maps_url: refinedEstimation.success ? `https://www.google.com/maps/search/?api=1&query=${refinedEstimation.lat},${refinedEstimation.lon}` : null,
      });
    } catch (error) {
      if (error?.status === 429) return sendJson(res, 429, { error: 'GlobalPing rate limit exceeded' });
      if (error?.status === 504) return sendJson(res, 504, { error: error.message });
      console.error('[ip-tracker] measurement failed');
      return sendJson(res, error?.status >= 400 && error.status < 600 ? error.status : 502, { error: error.message || 'IP tracking failed', details: error.details });
    }
  };
}

/** Register the IP-tracking endpoint on the Vite dev server. */
export function ipTrackerProxy() {
  return {
    name: 'ip-tracker-proxy',
    configureServer(server) {
      server.middlewares.use('/server/ip-tracker', createIpTrackerMiddleware());
    },
  };
}
