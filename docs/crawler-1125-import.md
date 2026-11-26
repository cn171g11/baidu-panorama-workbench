# 11.25 街景元数据导入与归属

这次导入不包括小蓝点。原件按 71 个 JSON 文件处理：11.25 压缩包有 69 个成员（含两个空数组），共 249,457 条；020-6A 为 4,830 条，020-5C 为 1,135 条。三组 255,422 个 ID 均唯一，与旧归档相交 386 个；255,036 个新增为待确认。386 个已有 ID 不重复计点、不覆盖原类别与坐标，只追加本次完整来源观察。

## 行政归属

以 [DataV.GeoAtlas](https://geo.datav.aliyun.com/areas_v3/bound/100000_full.json) 快照的 370 个区域作为统一候选集，而非用文件名、车辆编号、panoid 前缀或城市中心定位。文件附带的百度墨卡托 x/y 逆算后与经纬度逐条一致（最大残差约 1.42 × 10⁻¹⁴ 度），原 BD-09 数值原样保留。边界对照采用 [DataV 的 GCJ-02 工作口径](https://help.aliyun.com/zh/datav/datav-6-0/user-guide/map-data-format)，不声称来源逐顶点认证了坐标系。

| 空间检验 | 输入记录 | 行上的证据 |
| --- | ---: | --- |
| 唯一市界面内 | 255,410 | `inside-polygon`，至区域距离 0 |
| 全部面外 | 6 | `nearest-boundary`，取全部候选市界线段中的最近处，2.14–203.48 米 |
| 多面重叠 | 6 | `overlap-nearest-boundary`，在覆盖该点的候选中按边界线段选取，12.27–142.70 米 |

共 157 个计算归属区域。行中保存市代码、方法、近似距离（米）、快照 URL，推定行另存候选和距离。市界快照并非当前法定区划；例如新疆快照无 `659011`、`659012` 独立面。61 个已有 ID 的计算归属与原归档 owner 不同，两份证据均保留。没有把未匹配的全国点分给新疆自定义集合。公开发布指纹和出处，不分发原始边界几何。

- ZIP SHA-256：`e3a92c991aece353e6a8863142eca0e7f7ec5edf2b87ddef7f71b9fbfaaf2be9`。
- 逐 ID 归属清单 SHA-256：`98d92dba146373004b51b5b629181a80910dd2aa3cc22e72afc21c13aa791ce0`。
- [市界来源和逐文件快照指纹](<crawler-1125-boundary-sources.json>)。71 份原始输入的 SHA 和归档去重账目见[来源清单](<../data/imports/source-summary.json>)，不含本机原件路径。

## 入口证据和内存

原始上传全部标为 `hidden` 且仅做过 `metadata-only` 采集。原始标签保留在 `extra.originalRecord`，与新增归档行的 `sourceType: unknown` 分开。`timeLine` 不复制到道路 `links`；正移动计数不推断道路方向。见[官网证据与审查方式](<panorama-access-audit.md>)。网页报告使用[公开审查汇总](<../config/streetview-audit.json>)，独立列出归档主记录和上传输入；两份分母不可相加。

[导入器](<../tools/import_crawler_1125.mjs>)逐条读取 JSON / JSONL，在私有 SQLite 内完成归属查找、去重和观察合并。整包、全库 IDs 和整市分片不进入内存，写出按 64 KiB 批次。未改分片按字节复制；对需要改写的分片先按实际生成的字节数检查上限，再顺序写出、重新验证。生产导入在 128 MiB JS 堆下完成，峰值进程 RSS 为 210 MiB。[独立逐行核验器](<../tools/check_crawler_stage.mjs>)在同样堆上限下将 255,422 个原件与暂存结果逐条比对，峰值 RSS 为 196 MiB；315 对旧分片经 SHA-256 确认为相同，只解析有变化的分片。二者串行，不将峰值相加。应用前另备份更改目标，蓝点与其他本地项目不在变更清单中。
