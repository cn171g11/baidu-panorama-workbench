# Baidu Street View Workbench

**Independent metadata store and viewer for Baidu Street View only.** The viewer is available at <https://cn171g11.github.io/baidu-panorama-workbench/city-viewer/> and the published-corpus report at <https://cn171g11.github.io/baidu-panorama-workbench/city-viewer/report.html>.

## National corpus (v1.2)

- 280 city collections and **18,991,223 unique Baidu panoids**, imported from 281 user-supplied JSON files containing 19,012,500 records.
- The source coordinate system was confirmed by the user as **GCJ-02**. Stored coordinates are converted to BD-09. The original files are not modified.
- 21,276 exact duplicate records are counted and deduplicated. One panoid has differing neighbor-link metadata; both source variants and their memberships are preserved.
- Explicit `imageDate`, `country`, links, heading, pitch, zoom, source and source extras are preserved. Dates are never inferred from a panoid.
- No images are downloaded or stored. Panorama links open Baidu's official map viewer.

The national point files stay in this repository at `data/baidu/<adcode>/points-001.json`; no Tencent point data is included. GitHub Pages deploys only a **small site and catalog**. When a viewer selects a city, its data is fetched from `raw.githubusercontent.com` at the exact Git commit pinned in the site manifest, then verified using byte length and SHA-256. The production Pages artifact is under 1 MB instead of copying the ~792 MB point corpus to Pages. The source files remain available in the public repository.

## Local verification

Use Node.js 24+ (the CLI and validation index use built-in `node:sqlite`; no npm packages are needed):

```powershell
npm test
npm run validate
npm run build
npm run test:browser
npm run test:data-browser
```

`npm run test:browser` uses an unpublished temporary empty-data fixture for import isolation, local storage, layout and Tencent-rejection checks. `npm run test:data-browser` verifies real raw-source city loading, SHA-256, source fields, navigation and that the homepage does not download city shards.

## Importing more Baidu metadata

The browser's import/export is local to that browser and never uploads. Use the SQLite-backed directory importer for the national customCoordinates format. Do not run the importer against the tracked `data/` directory: stage into a new directory first, validate, then deliberately activate the result.

```powershell
npm run import:directory -- --source "D:\path\baidu-city-files" --output-root dist\import-stage\data --cities config\cities.json --coordinate-system GCJ-02 --index dist\import-stage\index.sqlite
node tools/validate_data.mjs "D:\full\path\to\dist\import-stage\data"
```

The importer is bounded-memory and uses SQLite for global duplicate detection. Use a new empty output directory and an explicit source coordinate system. The source manifest records input basenames, bytes, SHA-256 and record counts; it contains no machine-specific paths. A temporary point-index database remains under ignored `dist/` and is never published.

## Layout and privacy

```text
data/catalog.json
 data/baidu/<adcode>/points-001.json
 data/imports/source-summary.json
 data/imports/source-memberships.json
city-viewer/                 # app, report, Leaflet and styles
config/cities.json           # independent public administrative mapping
.github/workflows/pages.yml  # tests, compact Pages deployment and real-data smoke
```

`agent.md` and `history.md` are local-only AI handoff files and remain Git-ignored. Build artifacts and SQLite indexes are also ignored and excluded from Pages. Never use `git add -f` for those files. See [data format](docs/data-format.md) and [architecture](docs/architecture.md) for the schema and validation contract.
