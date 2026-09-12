# IP and Server Tracking API

God's Eye View includes a server-side endpoint that estimates the network location of an IP address, hostname, or reachable test server using [GlobalPing](https://globalping.io/).

This feature estimates where the target is likely located from measurements made by distributed probes. It does not reveal an exact street address and should not be described as exact physical geolocation.

## Endpoint

```text
GET /server/ip-tracker?q=<target>
```

Example:

```text
http://localhost:4173/server/ip-tracker?q=speedtest.hetzner.de
```

The endpoint accepts:

| Parameter | Required | Default | Description |
| --- | --- | --- | --- |
| `q` | Yes | None | IP address, hostname, or reachable test server |
| `limit` | No | `20` | Number of GlobalPing probes, from `1` to `100` |
| `continent` | No | `EU` | Two-letter continent code, such as `EU` or `NA`; use an empty value for global selection |
| `token` | No | None | GlobalPing API token; header authentication is preferred |

## Authentication

The server can read a token from `GLOBALPING_TOKEN`:

```env
GLOBALPING_TOKEN=your_globalping_token
```

A caller can also provide a token in the request header:

```http
Authorization: Bearer your_globalping_token
```

For temporary testing, the endpoint also accepts a query token:

```text
/server/ip-tracker?q=example.com&token=your_globalping_token
```

Token precedence is:

1. `Authorization: Bearer ...`
2. `?token=...`
3. `GLOBALPING_TOKEN`

Query tokens can be recorded in browser history, proxy logs, and access logs. Use the `Authorization` header or server environment variable for real deployments.

## PowerShell Example

```powershell
$headers = @{ Authorization = "Bearer $env:GLOBALPING_TOKEN" }
Invoke-RestMethod `
  -Uri "http://localhost:4173/server/ip-tracker?q=speedtest.hetzner.de&limit=20&continent=EU" `
  -Headers $headers
```

Without a token, omit the header if GlobalPing allows the request under its current anonymous limits.

## Response

A successful response contains the raw valid probe landmarks, the estimate that exactly matches the original Python algorithm, and a refined estimate:

```json
{
  "target": "speedtest.hetzner.de",
  "landmarks": [
    {
      "name": "Nuremberg, DE",
      "lat": 49.45,
      "lon": 11.08,
      "min_rtt_ms": 0.813
    }
  ],
  "estimation": {
    "lat": 50.87386944873374,
    "lon": 9.070087028546551,
    "success": true,
    "valid_probes": 20
  },
  "refined_estimation": {
    "lat": 51.00558702175812,
    "lon": 9.118214506902032,
    "success": true,
    "valid_probes": 20,
    "unique_locations": 17,
    "spread_km": 586.1224802734654,
    "method": "spherical RTT centroid with co-located probes collapsed by median RTT"
  },
  "maps_url": "https://www.google.com/maps/search/?api=1&query=51.00558702175812,9.118214506902032"
}
```

### Result fields

- `landmarks`: Probe city, coordinates, and minimum observed round-trip time.
- `estimation`: Exact Python-compatible spherical weighted centroid using every valid probe.
- `refined_estimation`: Co-located probes are grouped and represented by their median RTT before applying the same centroid method.
- `unique_locations`: Number of geographic groups used by the refined estimate.
- `spread_km`: Weighted root-mean-square distance from the refined estimate to the representative probe locations. Larger values mean lower geographic confidence.
- `maps_url`: Google Maps link for the refined estimate.

The API may return `400` for invalid parameters, `429` when GlobalPing rate limits the request, `502` for an upstream failure, and `504` when polling times out.

Working Germany-focused responses for `213.133.98.98` and `speedtest.hetzner.de` are documented in [IP-TRACKER-EXAMPLES.md](IP-TRACKER-EXAMPLES.md). GlobalPing probes are distributed across North America, Europe, Asia, and other regions. The method performs well for regional approximation in Europe because Europe has a high density of active community-hosted probes, although estimates for German infrastructure can drift toward central Germany when measurements span the continent.

## How It Works

The implementation follows the original Python program in four stages.

### 1. Create a GlobalPing measurement

The server sends:

```json
{
  "type": "ping",
  "target": "speedtest.hetzner.de",
  "limit": 20,
  "measurementOptions": {
    "packets": 3
  },
  "locations": [
    {
      "continent": "EU"
    }
  ]
}
```

It sends a `POST` request to:

```text
https://api.globalping.io/v1/measurements
```

GlobalPing schedules ping probes from its distributed measurement network. The server then polls:

```text
https://api.globalping.io/v1/measurements/<measurement-id>
```

Polling follows the Python behavior: up to 25 attempts, waiting 3 seconds between attempts. A temporary poll failure is ignored and the next poll continues.

## How This Differs from Normal IP Tracking

Traditional IP tracking usually means looking up an IP address in a registration or geolocation database. That process fetches records such as an ISP, country, region, city, ASN, or address range associated with the IP. It is a database lookup and does not measure the current network path.

This API performs active multi-vantage measurement instead. GlobalPing probes send packets toward the target and report their observed round-trip times. The API uses the probe coordinates and RTT values to calculate a network-latency estimate. It does not fetch a claimed street address for the target.

### Tracking a Moving Target

The endpoint can be called repeatedly to observe changes in a target's estimated network location. For example:

1. Measure the target while it is served from one city.
2. The target moves, is reassigned, or its routing changes.
3. Run another measurement using a new GlobalPing probe set.
4. Compare the two estimates, their landmarks, and `spread_km`.

A meaningful shift across repeated measurements may indicate that the target is now reachable through a different city, provider, data center, or routing path. This is not continuous live tracking, and it cannot prove that a person or physical device moved. DNS changes, load balancing, VPNs, mobile networks, anycast, and route changes can produce the same signal. Use repeated measurements with timestamps and consistent probe-selection settings when comparing results.

### 2. Extract valid landmarks

A result is included only when:

- The result does not contain an error.
- The probe has latitude and longitude.
- `stats.min` exists and is greater than zero.

Each retained result becomes:

```text
(name, latitude, longitude, minimum RTT in milliseconds)
```

The minimum RTT is used because it is generally less affected by transient queueing delay than the average RTT. It still includes routing and measurement uncertainty.

## Mathematical Model

The original Python calculation uses an exponential RTT weight:

$$
w_i = e^{-0.05 r_i}
$$

where $r_i$ is the probe's minimum RTT in milliseconds. Lower RTT gives a larger weight, while higher RTT gives a smaller weight. The coefficient `0.05` is a heuristic decay constant inherited from the Python implementation; it is not a physical law.

Latitude and longitude are converted from degrees to radians:

$$
\phi_i = \operatorname{ radians}(\text{latitude}_i), \qquad
\lambda_i = \operatorname{ radians}(\text{longitude}_i)
$$

Each geographic point is mapped from the surface of the Earth to a unit sphere in three-dimensional Cartesian coordinates:

$$
\begin{aligned}
x_i &= \cos(\phi_i)\cos(\lambda_i) \\
y_i &= \cos(\phi_i)\sin(\lambda_i) \\
z_i &= \sin(\phi_i)
\end{aligned}
$$

The weighted Cartesian sums are calculated:

$$
X = \sum_i w_i x_i, \qquad
Y = \sum_i w_i y_i, \qquad
Z = \sum_i w_i z_i, \qquad
W = \sum_i w_i
$$

The weighted average vector is:

$$
\bar{x} = \frac{X}{W}, \qquad
\bar{y} = \frac{Y}{W}, \qquad
\bar{z} = \frac{Z}{W}
$$

Finally, the vector is converted back to latitude and longitude:

$$
\text{latitude} = \operatorname{ degrees}\left(\operatorname{atan2}\left(\bar{z}, \sqrt{\bar{x}^2 + \bar{y}^2}\right)\right)
$$

$$
\text{longitude} = \operatorname{ degrees}\left(\operatorname{atan2}(\bar{y}, \bar{x})\right)
$$

Using a sphere avoids treating longitude as a flat x-coordinate. This matters near the International Date Line and near the poles.

## Refined Estimate

The refined result addresses one source of bias: multiple probes may come from the same city or nearby facility. Those probes are grouped using rounded coordinates. Each group is represented by the median of its minimum RTT values, then the same spherical weighted calculation is applied.

The original `estimation` is preserved so results can be compared directly with the Python program. The refined result is used for `maps_url` because it avoids counting several co-located probes as independent geographic evidence.

## Limitations: Network Latency, Noise, and Coverage

This method is a latency-based network-location estimate, not GPS and not a physical-address lookup.

- **Network latency:** Internet paths are not straight lines. Traffic may travel through exchanges, transit providers, or detours, so geographic distance is not the same as network distance.
- **Measurement noise:** RTT includes propagation, router processing, queueing, congestion, packet scheduling, probe load, and transient failures. A single measurement can therefore move the estimate.
- **RTT is not proof:** A low RTT does not prove that a probe is geographically close to the target, and a high RTT does not prove that it is geographically distant.
- DNS, load balancers, anycast, CDN routing, and virtual hosting can send different probes to different facilities.
- A hostname may resolve or route to more than one data center.
- GlobalPing probe coordinates describe the probe locations, not the target location.
- The centroid can fall in a place where the target has no infrastructure.
- `spread_km` is a confidence signal, not a formal statistical confidence interval.
- **Intercontinental limitation:** The result is strongly dependent on the selected GlobalPing vantage points and their regional density. GlobalPing has probes across North America, Europe, Asia, and other regions, but Europe has a particularly dense set of active community-hosted probes. The method therefore performs best for regional approximation where probe coverage is dense; it can experience centroid drift toward central Europe when measuring German infrastructure from across the continent. For targets in India, Pakistan, China, or another distant region, check the actual probe distribution before interpreting the result. Long intercontinental paths add transit and peering latency that can pull the centroid toward dense probe regions rather than the target country.
- **Probe-pool changes:** GlobalPing availability, probe selection, rate limits, and probe health can change between measurements. Results from different runs are not automatically comparable unless the target, continent filter, limit, and general probe distribution are similar.

For example, an estimate near central Germany for a Hetzner hostname can be regionally plausible while still failing to distinguish Nuremberg from Falkenstein. A spread of several hundred kilometers should be reported as low facility-level confidence. For an Asian target measured mostly from German probes, the result may primarily describe the path from Germany to the target rather than the target's actual city or country.

Use the result for exploratory visualization, regional comparison, and network research. Do not use it as proof of ownership, an exact server address, or a basis for targeting infrastructure. Only measure systems you are authorized to test and follow GlobalPing's terms and rate limits.

## Implementation

The endpoint is implemented in [`server/providers/ip-tracker.js`](../server/providers/ip-tracker.js) and registered by the local Vite provider stack in [`server/providers/local.js`](../server/providers/local.js).
