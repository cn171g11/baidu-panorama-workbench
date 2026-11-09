# 百度街景工作台 · baidu-panorama-workbench

**只收录百度街景元数据的独立工作台与存放站。** 参考腾讯街景工作台的网页交互、按城市分片和压缩发布思路重新实现，不读取腾讯站点、腾讯街景接口或其浏览器缓存，也不复制参考仓库的点位数据。

- **网站：** <https://cn171g11.github.io/baidu-panorama-workbench/city-viewer/>
- **数据报告：** <https://cn171g11.github.io/baidu-panorama-workbench/city-viewer/report.html>
- **源码参考：** <https://github.com/cn171g11/tencent-panorama-workbench>（只参考网页逻辑与组织方式）

> **全国百度列表导入（v1.1.0）**：用户提供 281 份城市文件、19,012,500 条位置记录，按明确的 `baidu_pano` 来源归档。合并 21,276 条完全相同的重复记录并保留 1 条邻接版本差异后，对应 **18,991,223 个唯一百度街景 ID / 280 个城市**。源坐标系由用户确认为 **GCJ-02**，统一转换为 BD-09；原始输入文件保持不变。仓库只保存元数据，不下载街景影像，影像在百度官方街景查看。

输入中的 `links`、`heading`、`pitch`、`zoom`、`source`、`extra`、`country`、`imageDate` 均保留。黔南的 20,000 条记录带有明确拍摄日期；其他没有日期的记录显示未知，绝不从 ID 猜日期。城市名称/代码来自[独立公共行政区划数据](https://github.com/modood/Administrative-divisions-of-China/blob/master/dist/pca-code.json)，不是腾讯街景数据。

## 网页功能

- 省份 → 城市按需加载，地图密度 / 散点显示、道路 / 日期 / panoid 搜索。
- 点位列表与元数据详情、地图定位、复制 ID / 坐标 / 百度官方街景链接；有历史元数据时展示历史信息。
- JSON / JSONL / CSV 本地导入、导出、保存和清理，导入前明确确认百度来源及源坐标系。
- 独立的 `baidu-panorama-workbench:v1:` 浏览器存储，不读取或修改其他工作台缓存。
- 响应式桌面与手机界面。Leaflet 使用仓库内固定版本资源；底图服务不可用时，元数据列表和导入仍可使用。
- 数据报告只读取已发布目录，不把浏览器里的私人临时记录算作网站数据。

**在网页中导入/保存文件仅影响当前浏览器，不会自动上传 GitHub。** 要让所有访客看到新数据，需要通过下面的 CLI 归档、提交并推送，等待 Pages 自动部署。

## 数据存放与隔离

```text
data/
  catalog.json                 # 仅百度城市目录与计数（初始为空）
  baidu/<adcode>/points-001.json # 已验证百度元数据分片，最多 180000 条/片
city-viewer/
  index.html                   # 工作台
  report.html                  # 省市计数报告
  js/                          # 数据/地图/页面模块
  css/                         # 响应式样式
  vendor/leaflet/               # Leaflet 1.9.4，含原 BSD 许可证
  data/                        # 构建时生成，不存放腾讯数据

dist/pages/                    # 自动生成的公开站点，不提交 Git
```

核心格式兼顾参考查看器的九字段数组：

```text
[panoid, longitude, latitude, road, captured, heading, hasThumb, hasPano, "baidu"]
```

归档坐标统一为 **BD-09**；导入时必须声明实际源坐标系（BD-09 / GCJ-02 / WGS84），地图显示按底图转换。ID 永远是字符串，不从 ID 猜拍摄日期。显式腾讯/QQ/其他来源、腾讯专有字段或链接不会因“确认百度”选项而被改成百度。所有点位全库去重，非法坐标、混合来源、计数不符、未登记分片和不安全路径均须通过校验后才能发布。

- [数据格式与导入说明](docs/data-format.md)
- [架构、模块与发布安全约定](docs/architecture.md)

## 本地运行与导入

需要 **Node.js 24+**（使用内置 `node:sqlite`）。工具无 npm 依赖，无需 `npm install`。全国校验分文件进行，唯一性索引和按内容 SHA 的验证缓存只放在忽略的 `dist/`，不会加载全部点位到内存或发布 SQLite 数据库。

```powershell
npm test
npm run validate
npm run build
npm run dev
# 浏览器访问命令输出的 http://127.0.0.1:4173/
```

收到元数据后的导入命令示例（请把行政区与坐标系替换为实际值）：

```powershell
npm run import -- --input "D:\path\baidu-metadata.json" --format json --city 320100 --adcode 320100 --name "南京市" --province "江苏省" --coordinate-system WGS84 --confirm-baidu
npm test
npm run validate
npm run build
git add data
git commit -m "Import verified Baidu panorama metadata"
git push origin main
```

默认合并而不是清空既有数据；导入失败不能留下半批数据。JSON 可以使用百度来源对象数组或包含 `provider: "baidu"` 的 `panoramas` 包装；后续若原文件有不同结构，先做适配再导入，不猜测来源或坐标系。空导入模板（不含任何虚构点位）：

```json
{"provider":"baidu","coordinateSystem":"BD-09","panoramas":[]}
```

## 全国目录批量归档

Map-making 风格的文件使用 `customCoordinates`、`panoId`、`lat`、`lng`、`source: "baidu_pano"`。目录导入先写入**全新空暂存目录**，不会覆盖输入文件或正式 `data/`：

```powershell
npm run import:directory -- --source "D:\path\baidu-city-files" --output-root dist/import-stage/data --cities config/cities.json --coordinate-system GCJ-02 --index dist/import-stage/index.sqlite
node tools/validate_data.mjs dist/import-stage/data
```

核对计数、SHA、完全重复及差异版本后再将暂存数据切换到正式源目录；已有暂存目录/索引会被拒绝覆盖。源记录逐文件处理，SQLite 只保存临时索引与 payload；输出按城市/panoid 排序，避免全国 `Set/Map` 容量上限。`data/imports/source-summary.json` 保存来源文件名、字节数、SHA、原始与唯一计数；`source-memberships.json` 保留重复街景的来源关系，不公开原始机器路径。

## 发布与测试

[Pages 工作流](.github/workflows/pages.yml) 在推送 `main` 后自动：

1. 运行全部 Node 单元测试和完整数据校验。
2. 构建**白名单**公开站点；数据分片仅以 gzip 发布，解压逐字节校验，并记录压缩前后的大小和 SHA-256。
3. 使用真实 Chromium 检查网页导入、腾讯混入拒绝、搜索/百度链接、本地缓存隔离、导出和手机布局。UI 回归使用临时空目录副本和合成数据，**不修改真实数据且不进入发布产物**。
4. 仅上传 `dist/pages/`，由 GitHub Pages 部署。公开 `build.json` 标明版本、Git 提交与点数，便于核验线上是否已更新。

```powershell
# UI 回归只用不发布的临时空目录副本（需要 Edge / Chrome）
npm run test:browser
# 真实数据验收：按需载入真实城市、检查gzip与全部元数据字段
npm run test:data-browser
```

浏览器只按需加载本站 gzip 元数据，经大小 / SHA-256 校验后解析 JSON，不执行导入文件中的 JavaScript。发布目录限制在 GitHub Pages 的 1 GB 内；以后超出时保留原数据，再调整托管方案，不丢弃点位来迁就容量。

`agent.md`、`history.md` 是用户指定的**本地 AI 交接文件**，被 Git 忽略；构建白名单也不包含它们、凭据、测试数据或浏览器测试目录。不要使用 `git add -f` 将其强行提交。PAT 不放进远程 URL、网页或仓库。

## 权属

街景影像及服务属于百度，本项目仅整理用户提供的元数据并链接至官方服务，不承诺第三方接口永久可用。请遵守数据来源的授权、百度服务条款及底图提供商的使用条款。Leaflet 原许可证保存在 [vendor 目录](city-viewer/vendor/leaflet/LICENSE)。
