# 百度街景工作台 · baidu-panorama-workbench

**只收录百度街景元数据的独立工作台与存放站。** 参考腾讯街景工作台的网页交互、按城市分片和压缩发布思路重新实现，不读取腾讯站点、腾讯街景接口或其浏览器缓存，也不复制参考仓库的点位数据。

- **网站：** <https://cn171g11.github.io/baidu-panorama-workbench/city-viewer/>
- **数据报告：** <https://cn171g11.github.io/baidu-panorama-workbench/city-viewer/report.html>
- **源码参考：** <https://github.com/cn171g11/tencent-panorama-workbench>（只参考网页逻辑与组织方式）

> 首次发布的真实街景点数为 **0**。等待用户提供百度元数据后再校验导入，不用示例数据或腾讯点位填充。仓库只保存 JSON 元数据，不下载或保存百度街景影像；查看影像时打开百度地图官方街景入口。

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

需要 **Node.js 22+**（CI 使用 24）。核心工具无 npm 依赖，无需 `npm install`。

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

## 发布与测试

[Pages 工作流](.github/workflows/pages.yml) 在推送 `main` 后自动：

1. 运行全部 Node 单元测试和完整数据校验。
2. 构建**白名单**公开站点；数据分片仅以 gzip 发布，解压逐字节校验，并记录压缩前后的大小和 SHA-256。
3. 使用真实 Chromium 检查网页导入、腾讯混入拒绝、搜索/百度链接、本地缓存隔离、导出和手机布局。UI 回归使用临时空目录副本和合成数据，**不修改真实数据且不进入发布产物**。
4. 仅上传 `dist/pages/`，由 GitHub Pages 部署。公开 `build.json` 标明版本、Git 提交与点数，便于核验线上是否已更新。

```powershell
# 首次空数据发布可直接验证实际构建；需要本机 Edge / Chrome
npm run test:browser
# 之后有真实数据时，UI 回归用不发布的临时空目录副本
node tools/browser_smoke.mjs --site-root dist/pages --ui-fixture
```

浏览器只按需加载本站 gzip 元数据，经大小 / SHA-256 校验后解析 JSON，不执行导入文件中的 JavaScript。发布目录限制在 GitHub Pages 的 1 GB 内；以后超出时保留原数据，再调整托管方案，不丢弃点位来迁就容量。

`agent.md`、`history.md` 是用户指定的**本地 AI 交接文件**，被 Git 忽略；构建白名单也不包含它们、凭据、测试数据或浏览器测试目录。不要使用 `git add -f` 将其强行提交。PAT 不放进远程 URL、网页或仓库。

## 权属

街景影像及服务属于百度，本项目仅整理用户提供的元数据并链接至官方服务，不承诺第三方接口永久可用。请遵守数据来源的授权、百度服务条款及底图提供商的使用条款。Leaflet 原许可证保存在 [vendor 目录](city-viewer/vendor/leaflet/LICENSE)。
