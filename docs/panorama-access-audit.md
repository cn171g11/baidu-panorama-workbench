# 百度街景入口审查

街景类型取决于用户如何到达目标全景。道路移动性单独记录。每次审查以一个目标 `panoid` 为单位，记录客户端、时间和实际操作后显示的全景 ID。

| 判定 | 所需观察 |
| --- | --- |
| 常规 | 官网正常地图入口到目标，随即沿路面箭头到另一 ID；允许同一地图入口先用日期控件往返，再沿路面移动。能切日期、是别人的历史版本或目标自身能沿路动，均不抵消已证实的地图入口。状态 `regular-confirmed`，其余关系单列。 |
| 时光机 | 同一会话、可核实的常规地图起点，用同址日期控件切到目标并切回原 ID **和原日期**：`time-machine-roundtrip`。只切到目标属于日期方向候选；实际从其他点沿箭头进入目标且在目标明确尝试原路未回、无成功逆边，属于道路方向候选。两者均记 `time-machine-one-way`，分别看 `dateCandidates` 和 `oneWayArrows`，不当作往返。仅有明确来源父版本历史引用为 `time-machine-history-only`，不是官网入口证明。 |
| 隐藏候选 | 直接 URL 成功；针对该点的地图点击实际进入 A，在 A 检查日期仍未到达；从目标到 A 后尝试反向道路未回。已观察到成功进入目标、网络错误、验证码、超时、单次失败或缺项都不能据此证明隐藏。状态 `hidden-candidate`，类别仍 `unknown`，须人工复核。 |
| 待确认 | 证据矛盾、普通双向邻接、未检查反向的单条邻接、只有 URL 或接口字段时保持 `unknown`；相关操作出错且没有充分正证时记 `access-error`。 |

单向可达按方向记录。若从目标 A 点击箭头到 B，在 B 尝试反向箭头却未回到 A，本次只记录 A → B 成功和反向尝试结果。日期往返要分别操作两次，浏览器返回按钮不计入日期切换。

## 已有接口记录

`Links` 提供有方向的连接线索。`Roads[].Panos` 提供道路成员及排序线索。`TimeLine` 提供历史版本线索。已有记录表明 `IsCurrent` 会随请求的全景 ID 改变。深圳和图木舒克均出现 `Links=[]` 但道路上有其他全景成员的样本。`HasTopo`、`Obsolete`、道路名、坐标距离和这些数组可辅助选择核查入口。最终分类由入口行为决定。

## 官网桌面网页实测

以下是 **2026-11-25 已有的桌面官网操作记录**。11 月 26 日以新审查器重放滨州日期轨迹，仍得到 `time-machine-roundtrip`；没有把它外推到整批。另对三份新输入各取一个已知 ID，向官网公开 `sdata` 串行查询一次（未加载影像、未点击地图/日期/箭头）：

| 来源 | 请求及实际返回的 ID | HTTP / 业务码 | HasTopo / Links / Roads | TimeLine 项数 |
| --- | --- | --- | --- | ---: |
| 11.25 压缩包 | [`01000300001308121042401725U`](https://mapsv0.bdimg.com/?qt=sdata&sid=01000300001308121042401725U&pc=1) | 200 / 0 | 0 / 0 / 0 | 2 |
| 020-6A | [`02018500001405191119241306A`](https://mapsv0.bdimg.com/?qt=sdata&sid=02018500001405191119241306A&pc=1) | 200 / 0 | 0 / 0 / 0 | 1 |
| 020-5C | [`02012100001406301231404005C`](https://mapsv0.bdimg.com/?qt=sdata&sid=02012100001406301231404005C&pc=1) | 200 / 0 | 0 / 0 / 0 | 1 |

这些响应只证明按 ID 能取得元数据；三条均没有因此改判为隐藏或已确认时光机。

滨州黄河十路。开启地图「全景」模式后点击地图，首屏进入 `09017800011603201325323725N`（2016 年 3 月）。点击日期控件中的 2014 年 9 月选项进入 `09017800001409051038442536J`，再点击 2016 年 3 月回到原 ID。随后连续两次点击全景路面，依次进入 `09017800011603201325354615N` 和 `09017800011603201325385665N`。工具根据这份操作记录判定 2016 年入口为常规，2014 年版本为时光机。日期按钮的 `data-pid` 可用于识别目标，操作成功以切换后的地址栏 `panoid` 和选中日期为准。

另一个此前标为隐藏的样本 `09017800001408011004002175F` 可在网页日期控件中与 `09017800011603190834100056W` 相互切换。还需要实际确认该组能否从地图直接进入，以及从哪个版本进入。隐藏候选仍只有合成用例覆盖。

## 录入格式

顶层需要 `schemaVersion: 1`、目标 `panoid`、客户端描述 `client`、检查时间 `checkedAt` 和 `sessions`。每个会话包含唯一 `id` 和按发生顺序排列的 `steps`。每步填写 `route`、目标 `to`、`result` 和证据引用 `evidence`，例如截图编号或操作记录编号。

- `map-entry` 填 `location`，记录点击的位置。操作后核对地图首先显示的 ID。
- `date-switch` 和 `arrow` 填起点 `from`，必须与上一步实际 ID 一致。日期切换成功（或切到替代点）记录官网的两个不同月份 `dateBefore`、`dateAfter`（`YYYY-MM`）和 `sameLocation: true`；不从 panoid 推月。新地图点击、直接 URL、错误或换会话不能接到先前的日期返程。不能只因同一 ID 曾经从地图进入，就把后来的直接 URL 会话当地图入口。
- `panoid-url` 记录输入指定全景 ID 后的实际结果。仅在日期控件中核对到同址目标编号和另一月份时，用 `date-option`、`result: listed`、`from/to`、`dateBefore/dateAfter`、`sameLocation: true`；这只记历史关联，不记一次成功切换或移动。从目标日期控件成功切回已确认的常规点，但没有对应去程时，只记录单向日期证据。
- 隐藏候选的另一种录入方式是：地图入口针对目标明确未命中、在可核实的常规锚点分别检查日期和道路入口未到达目标、直接 URL 能到达目标。无须从目标找到一条出向道路，也不推论所有可能入口已查尽。
- `reached` 表示到达目标，`observed` 必须等于 `to`。`alternative` 表示进入其他全景，须填写实际 `observed`。`unavailable` 表示当前操作入口不可用。网络、验证码和操作状态不明记为 `error`。

工具读取 JSON 并输出判断及证据引用。`status` 明确区分 `regular-confirmed`、`time-machine-roundtrip`、`time-machine-one-way`、`time-machine-history-only`、`hidden-candidate`、`unknown` 和 `access-error`。隐藏候选仍输出 `category: unknown`，以便人工复核。每份结果仅适用于所记录的客户端和时间。

```powershell
node tools/audit_panorama_access.mjs observations.json
```

## 将来源证据与现行标签分开汇总

分类顺序：

1. 滨州固定原始清单（7,586 条；固定 SHA-256 为 `7dbfdcd80d11f22d2a446f4965e96d0531aba4fa23ae1148bdf3795cd15e79cc`）中的 **7,418 个指定 ID** 优先保留用户确认隐藏。后加的 21 条 `hidden` 标签不属于此人工确认。图木舒克 `659003` 的 **11,796 条**以 `extra.classificationBasis=user-confirmed-regular`、`extra.sourceBatch=baidu-supplement-20261123` 和该包指纹确认；该批在图木舒克的历史引用同样服从人工结论。两组人工结果按确切 ID 匹配，不按地名扩张。
2. 复用上文黄河十路已记录的两个精确 ID；即使某个 ID 是网页版的日期选项，也只有当它本身是输入行时才计数。不能为被引用 ID 增行，也不能把直接 URL 加载成功算作地图/日期/道路入口。
3. 补充包的历史原件样本写有 `kind=historical_reference`、`returnedBy`、`timelineLabel`、`coordinateSource=parent-reference-only` 和父坐标。归档样本的 `row[9].extra` 除来源月份 `timelineLabel=YYYYMM` 外，`returnedBy`、`parentPanoid`、`inheritedCoordinate.inheritedFrom` 指向同一个非自身父 ID；`coordinateSource` 与 `inheritedCoordinate.coordinateSource` 都是 `parent-reference-only`。这些字段应在**同一条记录**共同出现才记历史关系，不拿父坐标当独立影像位置。缺来源关系、只有时间线成员/标签/邻接/移动计数，均保留 `unknown`。轨迹输入如附 `history`，每项为 `{panoid, extra}`，采用同一核对方法。
4. 已抽看本次 ZIP 和两份独立爬虫 JSON 的原始记录：`id`、`sid`、`panoId` 一致，`source=baidu`，`verification.mode=metadata-only`，另有 `sourceType`、`isHidden`、`movementCount`、`timeLine`。这不是官网试验。滨州旧导入还曾把时间线复制到 `links`；不能据此认定道路方向或隐藏。

### 低内存 CLI（不联网、不改归档）

从仓库根目录运行。`$stage` 是**已完成完整性/唯一性校验**的暂存数据根（直接包含 `catalog.json`），`$inputs` 是原始输入所在的私有目录。输出目录必须已存在，摘要文件须为新路径，不可位于规范归档内。全国审查与构建/导入串行执行。

```powershell
node --max-old-space-size=128 tools/audit_uploaded_streetview.mjs --public `
  "--data-root=$stage" "--binzhou-source=$inputs/百度滨州.json" `
  "--zip=$inputs/11.25.zip" "$inputs/baidu-020-0000-6A-crawler-results.json" `
  "$inputs/baidu-020-0000-5C-crawler-results.json" "--output=$freshSummary"
```

`--public` 核对归档条数与两个人工基线，缺失/不符则失败。只逐行读取目录登记的百度街景分片，不遍历蓝点。原文件和 ZIP 成员流式计数，不保存全量 ID 或点位；只有两个有硬上限的人工名单用于交叉核验。ZIP 逐成员校验大小及 CRC。全局唯一性属于归档验证/导入器，审查器不宣称输入行全局唯一。

可公开的 v2 摘要不含路径、车档文件名、ID、逐条轨迹和原始记录。`catalog.rows` 是选定归档快照的主记录数；`uploads.rows` 是指定上传的原始行数，**两套不可相加**。各自的 `bySource` 只统计显式 `sourceType`（缺项记 `missing`，不暗算作常规）；`byCategory`、`byStatus`、`byBasis` 是独立的审查维度，`sourceByStatus[源标签][审查状态]` 给出交叉计数。只有非零类别才出现。`metadataOnly` 为上传中 `verification.mode=metadata-only` 的行数。时间线空、单项、多项、缺失分别记数；移动数负值或非整数字段不当作零。审查不更新 `sourceType`、不改发布筛选，网页显示类别可以与入口审查不同。不加 `--public` 的详细结果含私有路径，不能发布。
