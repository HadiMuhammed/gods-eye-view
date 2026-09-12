# IP Tracker Working Examples

These examples use GlobalPing's globally distributed probe network, including Europe. The method performs well for regional approximation in Europe because Europe has a high density of active community-hosted probes. For German infrastructure, the estimate can still drift toward central Germany when multi-vantage measurements span the continent.

These are network-estimation examples, not exact physical-address proofs.

## `213.133.98.98`

Request:

```text
/server/ip-tracker?q=213.133.98.98
```

Response:

```json
{
  "target": "213.133.98.98",
  "landmarks": [
    {"name":"Helsinki, FI","lat":60.17,"lon":24.94,"min_rtt_ms":0.361},
    {"name":"Falkenstein, DE","lat":50.48,"lon":12.37,"min_rtt_ms":0.375},
    {"name":"Nuremberg, DE","lat":49.45,"lon":11.08,"min_rtt_ms":0.36},
    {"name":"Nuremberg, DE","lat":49.45,"lon":11.08,"min_rtt_ms":0.402},
    {"name":"Frankfurt, DE","lat":50.1,"lon":8.63,"min_rtt_ms":3.92},
    {"name":"Roubaix, FR","lat":50.69,"lon":3.17,"min_rtt_ms":11.317},
    {"name":"Sandefjord, NO","lat":59.17,"lon":10.21,"min_rtt_ms":45.648},
    {"name":"Amsterdam, NL","lat":52.37,"lon":4.89,"min_rtt_ms":36.224},
    {"name":"Oradea, RO","lat":47.05,"lon":21.92,"min_rtt_ms":27.577},
    {"name":"Dunkirk, FR","lat":50.99,"lon":2.13,"min_rtt_ms":11.875},
    {"name":"Lauterbourg, FR","lat":48.98,"lon":8.18,"min_rtt_ms":7.078},
    {"name":"Siauliai, LT","lat":55.93,"lon":23.32,"min_rtt_ms":30.796},
    {"name":"Zurich, CH","lat":47.37,"lon":8.55,"min_rtt_ms":21.408},
    {"name":"London, GB","lat":51.51,"lon":-0.13,"min_rtt_ms":19.813},
    {"name":"Karlsruhe, DE","lat":49,"lon":8.39,"min_rtt_ms":41.778},
    {"name":"Bucharest, RO","lat":44.43,"lon":26.11,"min_rtt_ms":28.977},
    {"name":"Dublin, IE","lat":53.33,"lon":-6.25,"min_rtt_ms":21.073},
    {"name":"Amsterdam, NL","lat":52.37,"lon":4.89,"min_rtt_ms":27.307},
    {"name":"Frankfurt, DE","lat":50.12,"lon":8.68,"min_rtt_ms":4.306},
    {"name":"Amsterdam, NL","lat":52.37,"lon":4.89,"min_rtt_ms":9.832}
  ],
  "estimation":{"lat":51.47779860671668,"lon":9.937980184666946,"success":true,"valid_probes":20},
  "refined_estimation":{"lat":51.61819611792434,"lon":10.24871893544085,"success":true,"valid_probes":20,"unique_locations":17,"spread_km":682.3854264551212,"method":"spherical RTT centroid with co-located probes collapsed by median RTT"},
  "maps_url":"https://www.google.com/maps/search/?api=1&query=51.61819611792434,10.24871893544085"
}
```

## `speedtest.hetzner.de`

Request:

```text
/server/ip-tracker?q=speedtest.hetzner.de
```

Response:

```json
{
  "target":"speedtest.hetzner.de",
  "landmarks":[
    {"name":"Falkenstein, DE","lat":50.48,"lon":12.37,"min_rtt_ms":2.628},
    {"name":"Helsinki, FI","lat":60.17,"lon":24.94,"min_rtt_ms":24.629},
    {"name":"Nuremberg, DE","lat":49.45,"lon":11.08,"min_rtt_ms":0.456},
    {"name":"Nuremberg, DE","lat":49.45,"lon":11.08,"min_rtt_ms":0.917},
    {"name":"Roubaix, FR","lat":50.69,"lon":3.17,"min_rtt_ms":11.367},
    {"name":"Frankfurt, DE","lat":50.1,"lon":8.63,"min_rtt_ms":4.012},
    {"name":"Dublin, IE","lat":53.33,"lon":-6.25,"min_rtt_ms":21.274},
    {"name":"Oradea, RO","lat":47.05,"lon":21.92,"min_rtt_ms":18.778},
    {"name":"Lauterbourg, FR","lat":48.98,"lon":8.18,"min_rtt_ms":9.522},
    {"name":"Amsterdam, NL","lat":52.38,"lon":4.9,"min_rtt_ms":15.476},
    {"name":"Siauliai, LT","lat":55.93,"lon":23.32,"min_rtt_ms":30.554},
    {"name":"Dunkirk, FR","lat":51.03,"lon":2.38,"min_rtt_ms":11.827},
    {"name":"Bucharest, RO","lat":44.43,"lon":26.11,"min_rtt_ms":32.027},
    {"name":"Karlsruhe, DE","lat":49.01,"lon":8.4,"min_rtt_ms":9.525},
    {"name":"Sandefjord, NO","lat":59.17,"lon":10.21,"min_rtt_ms":24.999},
    {"name":"London, GB","lat":51.51,"lon":-0.13,"min_rtt_ms":19.778},
    {"name":"Zurich, CH","lat":47.37,"lon":8.55,"min_rtt_ms":21.119},
    {"name":"Amsterdam, NL","lat":52.37,"lon":4.89,"min_rtt_ms":10.178},
    {"name":"Frankfurt, DE","lat":50.12,"lon":8.68,"min_rtt_ms":3.621},
    {"name":"Amsterdam, NL","lat":52.37,"lon":4.89,"min_rtt_ms":9.223}
  ],
  "estimation":{"lat":50.9570031246158,"lon":8.945739791636685,"success":true,"valid_probes":20},
  "maps_url":"https://www.google.com/maps/search/?api=1&query=50.9570031246158,8.945739791636685"
}
```

The first estimate is the exact Python-compatible spherical RTT centroid. The refined estimate groups co-located probes and uses median RTT values. A large `spread_km` means the result is regional rather than facility-level.
