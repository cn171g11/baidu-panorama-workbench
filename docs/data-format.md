# Local Baidu metadata format

The repository starts with an empty catalog. Do not add demonstration or fabricated panorama rows to `data/`; synthetic examples belong only in tests or temporary directories. Source metadata is Baidu-only. Tencent/QQ identifiers, provider markers, fields, and panorama URLs are rejected even when the user confirms a source.

## Catalog and shards

`data/catalog.json` uses schema version 1, provider `baidu`, and coordinate system `BD-09`. A collection has a six-digit `id` and `adcode`, human-readable `name` and `province`, count, bounds in `[minLng,minLat,maxLng,maxLat]` order, and ordered paths such as `baidu/320100/points-001.json`. Unknown administrative areas must use a separately assigned six-digit custom code described in project documentation; never reuse another provider's collection identifiers.

A shard is a JSON array of rows:

```json
["panoid-as-string", 116.4, 39.9, "Road", "2025-01-02", 90, false, true, "baidu"]
```

The optional tenth field is an object limited to `district`, `links`, and `history`. panoid is always a string, including long numeric-looking IDs. Capture dates are only imported from explicit source date/time fields; no date is inferred from panoid. All archived coordinates are BD-09.

## Import

The CLI requires an input format, collection ID/adcode/name/province, a declared source coordinate system (`BD-09`, `GCJ-02`, or `WGS84`), and explicit `--confirm-baidu` for every import. Confirmation may fill a missing Baidu marker but never override an explicit non-Baidu marker. A missing heading is stored as `null`, not an invented direction. Supported formats are JSON arrays or `{ "provider":"baidu", "rows": [...] }` (also `points`/`panoramas` envelopes), JSON Lines, CSV with a header or nine-field row layout, and quoted nine-field reference CSV. JSON object aliases include `streetViewId` for panoid, `streetName` for road, `captureDateTime`/`captureDate` for captured, plus `links` and `historical` stored as validated extras. Unknown coordinate systems are errors; never guess.

Example:

```powershell
node tools/import_baidu.mjs --input .\incoming.json --format json --id 320100 --adcode 320100 --name Nanjing --province Jiangsu --coordinates BD-09 --confirm-baidu
```

Imports are fully parsed, converted, and validated before writes. Existing collection identity cannot be replaced by a conflicting provider/name/adcode. panoid duplicates are rejected across the whole catalog. The importer writes through temporary files, validates the completed catalog, and rolls back on failure. Keep the source file outside `data/`.

## Validation and publishing

`validateCatalog(absoluteDataRoot)` verifies the catalog, every referenced shard, row types, provider, coordinate bounds, global panoid uniqueness, counts, bounds, shard ordering/limits, and absence of unreferenced JSON files. It returns `{ catalog, files: [{ path, rows, bytes, sha256 }] }`; paths are relative to the supplied data root. The build can gzip each raw JSON shard unchanged and publish both compressed/uncompressed sizes and SHA-256 digests. Browser loading must verify both compressed and decompressed integrity before parsing, and must only fetch a selected Baidu shard.

Browser-local work is separate from published source data. Local storage keys begin with `baidu-panorama-workbench:v1:`; saving local rows never uploads them.
