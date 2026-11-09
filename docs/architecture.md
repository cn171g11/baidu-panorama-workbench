# 百度工作台架构与隔离约定

## 范围

本项目参照 `cn171g11/tencent-panorama-workbench` 的城市分片、地图查看和元数据发布思路实现，但不复制其任何街景数据、浏览器缓存、部署域名或凭据。仅收录百度街景元数据，不下载或保存街景影像；查看影像时打开百度地图官方链接。首次发布没有真实点位，等待用户提供元数据。

## 数据契约（schemaVersion 1）

- 原始元数据仅放在 `data/baidu/`，目录索引为 `data/catalog.json`。
- catalog: `{schemaVersion:1, provider:"baidu", coordinateSystem:"BD-09", updatedAt:null|ISO8601, total:0, collections:[]}`。
- collection: `{id, adcode, name, province, coordinateSystem:"BD-09", count, bounds:[minLng,minLat,maxLng,maxLat]|null, files:["baidu/<id>/points-001.json", ...]}`。`id` 和 `adcode` 为六位行政区代码；未知行政区用独立六位自定义码并在文档标明，禁止挪用腾讯集合键。
- 分片为 JSON 行数组，不执行数据中的 JavaScript。每条为 `[panoid, longitude, latitude, road, captured, heading, hasThumb, hasPano, "baidu"]`，可在第十位放入经过校验的 `{district, links, history}` 补充信息，禁止改变前九位含义。
- 所有归档坐标均为 BD-09；导入时明确声明源坐标系 BD-09 / GCJ-02 / WGS84，统一转换。原始百度 ID 保持字符串，不做数值转换、不猜测采集日期。
- 唯一性按百度 panoid 全库校验。显式腾讯/QQ/其他 provider、腾讯街景跳转 URL 或专有字段不得通过校验，不能用来源确认选项覆盖显式非百度标记。
- 原始文件、计数、边界、重复 ID 必须通过构建前校验。默认每片最多 180000 条。

## 发布契约

`tools/build_site.mjs` 只复制白名单网页静态资源到 `dist/pages/`。将通过验证的 catalog 发布到 `city-viewer/data/catalog.json`；原始分片仅以 `.json.gz` 发布。`city-viewer/data/asset-manifest.json` 结构：

```json
{"schemaVersion":1,"provider":"baidu","codec":"gzip","assets":{"baidu/320100/points-001.json":{"url":"baidu/320100/points-001.json.gz","bytes":123,"sha256":"<原始 SHA256>","compressedBytes":100,"compressedSha256":"<gzip SHA256>"}}}
```

每个 gzip 发布前解压并逐字节验证。浏览器检查大小和 SHA-256 后解析 JSON，再校验百度行；失败须报错，不静默丢失数据。浏览器只从本站按需加载选定城市的数据。首页与报告只先读小型目录。所有网址和资源相对路径兼容 GitHub Pages 仓库子路径。

## 模块接口

- `city-viewer/js/coordinates.js`: `convertCoordinate(lng, lat, from, to) -> [lng,lat]`、`toWgs84(lng,lat,from="BD-09")`；严格验证有限值与已知坐标系。
- `city-viewer/js/metadata.js`: `parseImport(text, {format, confirmedBaidu, coordinateSystem}) -> rows`（支持 JSON / JSONL / CSV /参考九字段行，完整批次验证后才返回）；`validateRows(rows) -> rows`；`filterRows(rows, {query, road, date}) -> rows`；`baiduPanoramaUrl(panoid) -> official URL`；`mergeRows(existing,incoming) -> 去重后的 rows`。
- `city-viewer/js/data-store.js`: `loadCatalog() -> catalog`、`loadCollection(collection) -> rows`；`LOCAL_STORAGE_PREFIX="baidu-panorama-workbench:v1:"`、`saveLocalRows(collectionId,rows)`、`loadLocalRows(collectionId) -> rows|null`、`clearLocalRows(collectionId)`。catalog、asset manifest、rows 均须验证；没有 manifest 不能执行远端脚本或改读腾讯路径。
- `tools/import_baidu.mjs`: CLI 显式指定行政区/城市/省份、源坐标系与（缺来源时）百度确认。默认合并现有数据并在全库去重，成功后原子更新百度分片与目录。任何失败不得留下半批数据；禁止把用户输入当 JS 执行。
- `tools/validate_data.mjs`: 导出 `validateCatalog(root)`（root 为 `data/` 的绝对路径），返回 `{catalog, files:[{path, rows}]}` 或抛错，CLI 可直接运行。

## 文件与协作

- 元数据/导入任务写：coordinates.js、metadata.js、data-store.js、data/**、import_baidu.mjs、validate_data.mjs、tests/data-*.test.mjs、docs/data-format.md。
- 网页任务写：city-viewer/index.html、city-viewer/report.html、city-viewer/css/**、city-viewer/js/app.js、map.js、report.js、根 index.html、favicon.svg、tests/ui-*.test.mjs。
- 主任务写：package.json、tools/build_site.mjs、tools/serve.mjs、tools/browser_smoke.mjs、tests/build-*.test.mjs、.github/workflows/pages.yml、第三方 vendor、README.md、.gitignore、.gitattributes、.nojekyll、本地 agent.md/history.md。
- agent.md/history.md 仅为本地 AI 交接记录；Git 忽略且发布白名单绝不包含。测试用合成数据只在 tests 或临时目录中，绝不发布到网站。
