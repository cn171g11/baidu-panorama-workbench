# 县级行政区分片查看

## 查看方式

在查看器依次选择 **省份 → 城市 → 县／区**。选市只读取目录，不下载点位；选县后只下载默认的一个县级分片，每片最多 **25,000** 点。有多个分片时可选择第几片，也可明确选择“全部分片”或“全部县区”；较大的集合会先提示内存风险。

报告采用省 → 市 → 县可折叠目录，显示每县点数、源标注分类、日期来源和分片数。搜索县名会找到所属市，县链接可直接定位；只打开市链接仍需选择县，不隐式载入整市。报告仅读目录，不下载点位正文或边界几何。

## 空间归属及可信边界

- 行政边界来源是 **OpenStreetMap（OSM）**，不是官方行政区划认证。大陆县级通常使用 OSM `admin_level=6`；直管县级市／林区可使用该行政实体自身。
- 原归档仍为用户确认的 **BD-09**。构建将每个点转换为 **WGS84** 后，用原始 OSM Polygon / MultiPolygon 进行精确点在面内判断，支持洞、岛屿、多组件；不把包围盒当边界、不简化原始几何。
- 按 OSM 中文名／`name:zh` 与层级选定真实父市关系，并使用父市真实多边形围栏。OSM 区域查询可能返回邻市县；真实 OSM `admin_centre` 在父市之外的候选会排除，缺少行政中心的候选明确记录，点仍必须在父市围栏内。
- 县名、行政代码和 panoid 均不能代替几何匹配。OSM `division_code` 可能缺失、重复或过时：缺失／冲突时以 `osm-r<relation-id>` 作为独立分片键，保留原 OSM 代码及关系编号，不伪造现行县代码。
- 共享边界或多县重叠命中多个县时归为 **歧义**；无命中、坐标漂移、市界外、县界缺失或父市几何不可用均归为 **未匹配**。这些点完整保留在独立 `unmatched` 分片，没有被丢弃。
- 精确判断仅相对于本次 OSM 快照和坐标转换结果。源点位的真实采集位置、OSM 边界质量和现行行政归属不是本站逐条认证。

已发现上海宝山区 OSM 关系 `398374` 的外环存在分支歧义，本轮不猜测拼接；受影响点保留在未匹配分片。儋州市没有返回县级区划，点也完整保留在“县界未覆盖”分片。其他源边界问题、邻市候选排除和重复代码均写入每市边界元数据。

## 数据保留和发布契约

根 `data/` 和原始输入只读，不生成全国派生正文。Pages 仍仅托管所选 **31 城、1,084,663 条**；未选的 249 城继续完整保存在源仓库。

县级派生路径：

```text
baidu/<city-id>/counties/<county-id>/points-001.json.gz
```

派生行仍保留原九字段及全部额外元数据，继续补全带来源的 panoid 时间，并加入：

```json
{
  "administrativeArea": {
    "source": "OpenStreetMap",
    "level": "county",
    "cityId": "371600",
    "countyId": "371602",
    "countyName": "滨城区",
    "osmRelationId": "5678249",
    "match": "matched",
    "boundaryDate": "OSM快照时间"
  }
}
```

`unmatched` 分片中 `countyId/countyName/osmRelationId` 为 null，`match` 为 `unmatched` 或 `ambiguous`。

每市 `counties` 计数、分类和日期摘要合计须精确等于城市摘要；县不是新增点集，不能再累加到全国／省市总数。发布清单 `sources` 和城市 `sourceFiles` 保留原归档 SHA/字节数；县资产 `sha256/bytes` 对应派生 JSON，`compressedSha256/compressedBytes` 对应实际 gzip，并流式解压回验。

## 低内存策略

- 下载边界走已有系统代理，串行低频、缓存响应；无配置代理时停止，不静默直连。证书验证开启，不修改用户代理设置、不保存代理地址或凭据。
- 每次只加载一个城市的边界；源点逐条读取，64 KiB 读写缓冲，县级输出先暂存、逐片 gzip，不创建整市或全国点数组。
- 国家源唯一性校验继续使用 SQLite 磁盘索引，16 MiB 页缓存、关闭 mmap。
- 测试和构建使用 Node `--max-old-space-size=128`，测试并发 1；边界下载、全国验证、构建和浏览器重任务不并行运行。
- 浏览器只缓存一个当前集合；切换县／片会取消旧请求，已取消结果不能回填缓存。默认每片最多25k；“全部”选项不是内存无上限的保证。
- **128 MiB 只限制 JS 堆，不是进程 RSS 或整机内存上限**。以实际构建测量记录为准。

## 构建与覆盖实测

当前31城目录包含 **275 个OSM县／区边界**（30城有县级几何，儋州无县级几何；237个县区实际有点位）；共生成250个点位分片。总数 **1,084,663**：单一匹配 **1,056,333**、未匹配 **28,330**、歧义 **0**，合计不变。275包含源城下有界但零点位的县区，不等于275县均有百度点位。

2026-11-14本地最终安全修复版本串行构建 **93,016ms**，峰值 RSS **234,627,072字节（约223.8MiB）**，JS堆限制128MiB。此前首次测量93,670ms/约225.6MiB。这是单Node构建进程，不是浏览器或整机内存；实际值受环境和边界大小影响。不会将128MiB称为总内存上限。

## 更新与验证命令

```powershell
# Windows：通过现有系统代理取得公开OSM关系，顺序执行
python tools/fetch_osm_counties.py
python tools/fetch_osm_parents.py
node --max-old-space-size=128 tools/prepare_osm_counties.mjs

# CI构建只用已校验提交的边界快照，不依赖运行时Overpass可用性
npm test
$env:GITHUB_SHA = git rev-parse HEAD
node --max-old-space-size=128 tools/measure_county_build.mjs --output dist/pages-county-release
node --max-old-space-size=128 tools/browser_county_check.mjs --site-root dist/pages-county-release --city 371600 --result-dir dist/county-browser-check
```

真实浏览器检查记录：首页／选市无点位请求、单县单片同源 gzip、换片、换县、快速切换取消、日期筛选、详情与导出往返、县级报告和深链接，以及 390／1440 宽度布局。为减少网络和内存，县级功能验收屏蔽底图瓦片；地图底图可用性不是该项验证的结论。

## OSM 许可

边界数据：**© OpenStreetMap contributors**，采用 [Open Database License（ODbL 1.0）](<https://opendatacommons.org/licenses/odbl/1-0/>)；[版权及归属说明](<https://www.openstreetmap.org/copyright>)。本项目提交原精度 WGS84 边界快照和来源 SHA，报告提供 OSM 关系链接和许可归属。OSM 许可不改变用户提供百度点位元数据的原始来源，不意味着授权复制百度影像。
