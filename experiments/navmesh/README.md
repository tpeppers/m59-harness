# Offline navigation mesh experiment

This isolated experiment compares genuine Recast/Detour, a sampled BSP portal graph, and the current fine/local planners on frozen Meridian geometry. It opens no game sockets and is not imported by production navigation.

Read [REPORT.md](REPORT.md) for the measured recommendation. [results.json](results.json) contains the full reproducible measurements, exact source/map hashes, scenario provenance and candidate paths.

From this directory:

```powershell
npm ci --ignore-scripts --no-audit --no-fund
npm test
npm run compare
npm run report
```

The committed run uses five warm native/BSP samples and 25 warm Recast queries per scenario, with 1/8, 1/16 and 1/32 square bakes plus a conventional-ceiling profile. Worker invocation times are recorded separately. Native route validation remains mandatory for every arm.

Optional diagnostics:

```powershell
node compare.mjs --case open-gate --rounds 1 --query-rounds 5 --fine-resolution --point-diagnostic --out konima-diagnostic.json
node drop-diagnostic.mjs
```

Dependencies are confined to this directory. Recast uses standard detail sampling at 6 because this WebAssembly build traps in buildPolyMeshDetail with detailSampleDist=0, even on a synthetic square.

Sources: [Recast Navigation](https://github.com/recastnavigation/recastnavigation), [Recast Navigation JS](https://github.com/isaac-mason/recast-navigation-js).
