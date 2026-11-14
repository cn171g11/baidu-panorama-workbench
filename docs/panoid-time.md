# 百度 panoid 时间补全与低内存处理

## 参考与验证

参考仓库 [BaiduMapToy](https://github.com/chaofunchengfeng/BaiduMapToy)，本次固定阅读版本为 [`72a98033f63792a334ef05f1787327e914d3dcc6`](https://github.com/chaofunchengfeng/BaiduMapToy/commit/72a98033f63792a334ef05f1787327e914d3dcc6)。该扩展在 [service_worker.js:365–383](https://github.com/chaofunchengfeng/BaiduMapToy/blob/72a98033f63792a334ef05f1787327e914d3dcc6/js/service_worker.js#L365-L383) 中读取百度官网 `panorama.panoData.date`，而不是自行截取 panoid。

本项目独立实现有格式检查的 panoid 编码解析，并对三个公开元数据样本的官方 `Date` 做了低频交叉核对：

| panoid | 编码解析日期 | 百度元数据 Date |
|---|---|---|
| `01005700001311161210364505G` | 2013-11-16 | `20131116` |
| `09017800001408011004002175F` | 2014-08-01 | `20140801` |
| `09023800011608211620007397M` | 2016-08-21 | `20160821` |

未对全国每个 panoid 联网验证，不抓取影像，不提供高频后台接口扫描。

## 适用格式与可信边界

- 支持本数据中的 **27 位 ASCII panoid**：前 25 位为数字、末两位为字母或数字。
- 第 **11–25 位（从 1 开始）**作为 `YYMMDDhhmmssSSS` 解释，年份采用 `2000 + YY`。
- 校验真实年月日、闰年、小时 0–23、分秒 0–59；格式不符或无效日期保持未知。
- 示例 `09017800001408011004002175F` → `2014-08-01T10:04:00.217`。
- 官方样本只证明日期部分吻合；时分秒、毫秒是 **ID 编码字段**，不是逐条官网认证，也不保证采集设备真实时钟精度。
- panoid **不包含时区**。派生值不加 `Z`、不自动转北京时间；原有明确时区或明确日期保持原样。

## 优先级与数据保留

1. 优先保留第 5 字段 `captured` 的明确来源日期；
2. 其次使用原扩展 `imageDate` 或 `extra.imageDate`；
3. 缺失时才尝试 panoid 编码解析。

派生发布/导出记录在第 10 字段中注明：

```json
{
  "captureTime": {
    "source": "panoid",
    "encoding": "baidu-27-yymmdd-hhmmss-ms-v1",
    "precision": "encoded-millisecond",
    "timeZone": null
  }
}
```

详情和列表明确显示“编码解析”；日期筛选、文本搜索和导出使用相同规则。错误导入标记不能把一个不同的明确日期偷偷改称 panoid 派生。

根 `data/` 与原始用户文件不重写。只在 Pages 发布产物和用户选择导出时补全：因此链接、邻接、姿态、隐藏标签、历史观察版本及来源日期均保留。发布清单中的 `sourceSha256/sourceBytes` 对应原归档；`sha256/bytes` 对应补全后的发布 JSON，不能混用这两种 SHA。

## 低内存策略

- 测试、验证和构建默认 `--max-old-space-size=128`；测试 `--test-concurrency=1`，不并发启动全国审计与构建。
- 源分片以 **64 KiB** 块读取，每次只解析一条记录；默认单记录上限 **1 MiB**、最大 JSON 嵌套 64 层。
- gzip 以 **64 KiB** 批次背压写入，逐片串行；写后流式解压并校验 SHA，不生成整城 JSON 数组副本。
- 全库唯一性仍由磁盘 SQLite 验证；其页缓存收紧为 **16 MiB**、关闭 mmap。
- 内容缓存仍核对全部源分片 SHA，不改为只信任文件时间。
- 网页仅缓存一个已加载城市，列表仍为每页 50 条；搜索无条件时不为整城分配搜索文本或日期缓存。
- 128 MiB 是 **JS 堆上限**，不是整个进程 RSS 上限；原生缓冲、SQLite、V8 和操作系统开销另计。以实测 RSS 报告为准。

当前 31 城、1,084,663 条最终发布构建实测约 **65 秒**，峰值 RSS **182,935,552 字节（约 174.5 MiB）**。这只指单个构建进程，不是浏览器或整机内存；前一轮测量为约194 MiB，进程RSS会随环境略有变化。

全国只读扫描实测 **149 秒**，峰值 RSS **170,835,968 字节（约 163 MiB）**：280 城共 **18,998,732** 条，其中明确源日期 **20,000**，编码解析 **18,978,732**，未知 **0**。该结果只是本数据集合的格式/覆盖审计，不是对全部时间的官网认证，也不代表全国已部署。当前31城发布摘要为源日期20,000、编码解析1,064,663、未知0。

## 命令

```powershell
npm test
npm run validate
$env:GITHUB_SHA = git rev-parse HEAD
npm run build:pages

# 一次一个，只读扫描；不生成全国派生正文
node --max-old-space-size=128 tools/audit_panoid_time.mjs --output dist/panoid-time-audit.json

# 可只审计指定城市
node --max-old-space-size=128 tools/audit_panoid_time.mjs --cities 371600,542500 --output dist/panoid-time-small.json
```

报告页面仅读取每城 `captureSummary`，分别展示明确源日期、panoid 编码解析和未知计数，以及日期范围。

## 后续县级分片

时间补全阶段未下载县界；用户后续要求继续后，已实现 OSM 行政边界经代理获取、WGS84 精确匹配、父市围栏与未匹配保留的县级派生分片。时间来源规则继续保持，源归档不重写。当前县级规则、低内存加载与许可见 [县级分片说明](<county-shards.md>)。
