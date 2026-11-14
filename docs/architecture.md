# 百度工作台架构与隔离约定

## 范围

本项目参照 `cn171g11/tencent-panorama-workbench` 的城市分片、地图查看和元数据发布思路实现，但不复制其任何街景数据、浏览器缓存、部署域名或凭据。仅收录百度街景元数据，不下载或保存街景影像；查看影像时打开百度地图官方链接。全国目录由用户提供，原始 19012500 条记录、18991223 唯一 ID、280 个城市，源 GCJ-02 已由用户确认，统一归档 BD-09。

## 数据契约（schemaVersion 1）

- 原始元数据仅放在 `data/baidu/`，目录索引为 `data/catalog.json`。
- catalog: `{schemaVersion:1, provider:"baidu", coordinateSystem:"BD-09", updatedAt:null|ISO8601, total:0, collections:[]}`。
- collection: `{id, adcode, name, province, coordinateSystem:"BD-09", count, bounds:[minLng,minLat,maxLng,maxLat]|null, files:["baidu/<id>/points-001.json", ...]}`。`id` 和 `adcode` 为六位行政区代码；未知行政区用独立六位自定义码并在文档标明，禁止挪用腾讯集合键。
- 分片为 JSON 行数组，不执行数据中的 JavaScript。每条为 `[panoid, longitude, latitude, road, captured, heading, hasThumb, hasPano, "baidu"]`，可在第十位放入经过校验的 `{district, links, history, source, pitch, zoom, extra, tags, observations}` 补充信息，未知合法字段保留在 extra；禁止改变前九位含义。
- 所有归档坐标均为 BD-09；导入时明确声明源坐标系 BD-09 / GCJ-02 / WGS84，统一转换。原始百度 ID 保持字符串。源文件明确日期优先；用户确认支持从panoid提取时间后，仅对适用27位格式生成带来源标记的派生时间，不覆盖归档原值、不虚构时区（见 `docs/panoid-time.md`）。
- 唯一性按百度 panoid 全库校验。显式腾讯/QQ/其他 provider、腾讯街景跳转 URL 或专有字段不得通过校验，不能用来源确认选项覆盖显式非百度标记。
- 原始文件、计数、边界、重复 ID 必须通过构建前校验。默认每片最多 180000 条。

## 发布契约

Pages现在按 `config/pages-publication.json` 选择实际托管的城市，由 `tools/publish_pages.mjs` 生成本站 `.json.gz` 分片与 `source:github-pages` 清单。每次构建都是完整发布快照，因此追加批次时必须保留前面已成功的城市；不能省略旧城来假装增量累积。全量数据约792MB曾两次同步超时，故先5个城市，再验证后扩大。gzip压缩前后的SHA、字节数和回读解压均严格核对。线上catalog只计当前发布城市，`publication.sourceCities/sourcePanoids`保留完整全国规模，根 `data/` 不删除不修改。详细操作见 `docs/pages-batches.md`。`tools/build_site.mjs`仍保留轻量GitHub Raw固定SHA备用方案，但正式Pages workflow不依赖该外部数据源。

县级查看已接入：正式Pages可启用 `countyShards:true`，按已提交的OSM县界与父市界WGS84空间归属生成最多25,000点的县级gzip，所有未匹配/歧义点独立保留。原城市归档不变；发布城市 `files` 为县片扁平目录，`sourceFiles`/manifest `sources`保留原归档SHA。报告只读县级摘要，选市不下载点位，选县默认单片，快速切换取消旧请求。规则与许可见 `docs/county-shards.md`。

## 地图、报告与官网入口

默认高德暗色，地图为单Canvas散点/密度显示。高德瓦片使用GCJ-02投影，OSM使用WGS84；切换底图同步转换中心与弹窗，不改变归档BD-09。密度显示真实视野方格，Z15起绘制每个真实点。`classification.js`在构建/地图/报告共享源标注分类；构建生成已发布城市 `displayCounts`，省市折叠报告仅载入小目录，不读取街景正文。报告筛选后的省级合计重新计算，链接可直达城市及隐藏类型。

所有官网跳转统一用百度全景hash分享入口（`panoid`/`pid`/`shareurl=1`），不再用被官网忽略的`?qt=pano&panoId=`。有BD09MC x/y时可给地图中心；邻接ID不借用主点坐标。桌面Edge已真实验证普通、隐藏与时间线panoid的全景容器、Canvas和指定ID影像HTTP200；不意味着所有记录或所有手机可用。更多说明见 `docs/map-and-links.md`。

## 模块接口

- `city-viewer/js/coordinates.js`: `convertCoordinate(lng, lat, from, to) -> [lng,lat]`、`toWgs84(lng,lat,from="BD-09")`；严格验证有限值与已知坐标系。
- `city-viewer/js/metadata.js`: `parseImport(text, {format, confirmedBaidu, coordinateSystem}) -> rows`（支持 JSON / JSONL / CSV /参考九字段行，完整批次验证后才返回）；`validateRows(rows) -> rows`；`filterRows(rows, {query, road, date}) -> rows`；`baiduPanoramaUrl(panoid) -> official URL`；`mergeRows(existing,incoming) -> 去重后的 rows`。
- `city-viewer/js/data-store.js`: `loadCatalog() -> catalog`、`loadCollection(collection,{county:"all",part:"all",signal}) -> rows`；`LOCAL_STORAGE_PREFIX="baidu-panorama-workbench:v1:"`、`saveLocalRows(collectionId,rows)`、`loadLocalRows(collectionId) -> rows|null`、`clearLocalRows(collectionId)`。catalog、asset manifest、rows 均须验证；没有 manifest 不能执行远端脚本或改读腾讯路径。
- `tools/import_baidu.mjs`: CLI 显式指定行政区/城市/省份、源坐标系与（缺来源时）百度确认。默认合并现有数据并在全库去重，成功后原子更新百度分片与目录。任何失败不得留下半批数据；禁止把用户输入当 JS 执行。
- `tools/validate_data.mjs`: `validateCatalog(root,{includeRows:false})` 返回 `{catalog,files:[{path,count,bounds,bytes,sha256}],indexPath,cacheHit}`。按文件读取，使用私有 SQLite owner index 避免全国 Set/Map 限制；缓存键含 catalog SHA 和所有 file SHA，绝不只用 mtime。小 fixture 显式 includeRows；索引、缓存与 payload 绝不发布。
- `tools/import_directory.mjs`: 读取 customCoordinates，显式源坐标，文件 SHA 与审计清单核对，按源文件 SQLite transaction、按城市排序输出；只允许全新暂存目录，验证通过后再切换正式源。完全相同重复计数并保留来源成员；同 ID 差异保留旧/新 observations、合并 links，不丢有效信息。
- `catalog.importSummary` 与每个 `collection.summary` 记录原始/唯一/重复计数；`data/imports/source-summary.json`、`source-memberships.json` 只含公开文件名、SHA、来源关系，不含机器绝对路径或缓存路径。

## 文件与协作

- 元数据/导入任务写：coordinates.js、metadata.js、data-store.js、data/**、import_baidu.mjs、validate_data.mjs、tests/data-*.test.mjs、docs/data-format.md。
- 网页任务写：city-viewer/index.html、city-viewer/report.html、city-viewer/css/**、city-viewer/js/app.js、map.js、report.js、根 index.html、favicon.svg、tests/ui-*.test.mjs。
- 主任务写：package.json、tools/build_site.mjs、tools/serve.mjs、tools/browser_smoke.mjs、tests/build-*.test.mjs、.github/workflows/pages.yml、第三方 vendor、README.md、.gitignore、.gitattributes、.nojekyll、本地 agent.md/history.md。
- agent.md/history.md 仅为本地 AI 交接记录；Git 忽略且发布白名单绝不包含。测试用合成数据只在 tests 或临时目录中，绝不发布到网站。
