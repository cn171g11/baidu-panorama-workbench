# 百度街景分类依据与官网入口记录

**“隐藏”指不能从官网蓝线入口点入，不表示不能沿路移动。** 未经人工改判的点按该 ID 的原件 `isHidden === true` 确认隐藏。这不是本站逐点点击官网所得的结论。不采信字符串 `"true"`、数字 `1`、旧推导的 `sourceType: hidden`、道路或日期线索。一次或多次蓝线点击失败也不是隐藏依据。

| 优先级 | 使用的证据 | 结果与边界 |
| --- | --- | --- |
| 1 | 已签认的精确 ID、城市及历史改判回执 | 保留人工常规、隐藏、时光机；不按地名、车辆、批次或标签扩展。南京 192、拉萨城关 41 记 `time-machine-manual-confirmed`，并非 233 份官网往返录像。 |
| 2 | 已保存的官网同址日期操作 | `time-machine-roundtrip` 要求同一会话由有道路移动实证的常规蓝线锚点切入目标并切回原 ID **和原月份**。另保留已有精确常规官网基线。 |
| 3 | 该 ID 的原始记录自身有 `isHidden` 且值为布尔 `true` | 类别 `hidden`；依据和状态均为 `source-isHidden-true`。移动、箭头、`Links`、`TimeLine`、`hasPano`、直接 URL 不推断也不否决此标记。 |
| 4 | 没有以上证据 | 不确认隐藏。仍可分别记录实际常规入口、同址单向日期操作及明确父版本历史引用；不能据此声称日期往返。否则为 `unknown`，相关官网操作出错且无充分正证为 `access-error`。 |

固定人工范围见[保护回执](../config/reviews/hidden-policy-protected.json)：图木舒克 11,796 和 11.23 补充包交集 150,762 保留常规。滨州首份原件 7,418 条、新乡指名 1 条、阿拉善 6Z 整批 216 条各按原人工依据保留隐藏。6Z 没有原件布尔标记，**不计入** `source-isHidden-true`。滨州同份原件另有 168 条为 `isHidden: false` 且类别 `time-machine`，仅用于原件核数，不当作隐藏，也不把归档主记录或入口审查结果改判为时光机。原有主分类不因此改变。

## 官网桌面网页实测

以下是 **2026-11-25 已有的桌面官网操作记录**。11 月 26 日以新审查器重放滨州日期轨迹，仍得到 `time-machine-roundtrip`；没有把它外推到整批。另对三份新输入各取一个已知 ID，向官网公开 `sdata` 串行查询一次（未加载影像、未点击地图/日期/箭头）：

| 来源 | 请求及实际返回的 ID | HTTP / 业务码 | HasTopo / Links / Roads | TimeLine 项数 |
| --- | --- | --- | --- | ---: |
| 11.25 压缩包 | [`01000300001308121042401725U`](https://mapsv0.bdimg.com/?qt=sdata&sid=01000300001308121042401725U&pc=1) | 200 / 0 | 0 / 0 / 0 | 2 |
| 020-6A | [`02018500001405191119241306A`](https://mapsv0.bdimg.com/?qt=sdata&sid=02018500001405191119241306A&pc=1) | 200 / 0 | 0 / 0 / 0 | 1 |
| 020-5C | [`02012100001406301231404005C`](https://mapsv0.bdimg.com/?qt=sdata&sid=02012100001406301231404005C&pc=1) | 200 / 0 | 0 / 0 / 0 | 1 |

这些响应只证明按 ID 能取得元数据；三条均没有因此改判为隐藏或已确认时光机。

滨州黄河十路。开启地图「全景」模式后点击地图，首屏进入 `09017800011603201325323725N`（2016 年 3 月）。点击日期控件中的 2014 年 9 月选项进入 `09017800001409051038442536J`，再点击 2016 年 3 月回到原 ID。随后连续两次点击全景路面，依次进入 `09017800011603201325354615N` 和 `09017800011603201325385665N`。工具根据这份操作记录判定 2016 年入口为常规，2014 年版本为时光机。日期按钮的 `data-pid` 可用于识别目标，操作成功以切换后的地址栏 `panoid` 和选中日期为准。

另一个此前标为隐藏的样本 `09017800001408011004002175F` 可在网页日期控件中与 `09017800011603190834100056W` 相互切换。还需要实际确认该组能否从地图直接进入，以及从哪个版本进入。这不等于从已验证的蓝线常规点经日期控件往返，不能据此撤销既有人工决定。

## 网页操作录入

输入 `schemaVersion: 1`、`panoid`、`client`、`checkedAt`、`sessions`。每个会话含唯一 `id` 及顺序 `steps`，每步含 `route`、`to`、`result`、证据引用 `evidence`。

- `map-entry` 需要点击位置 `location`；成功时核对实际 `observed`。从地图点到目标且沿路面实际移动，记 `regular-confirmed`。独立 URL 或孤立箭头不能证明蓝线入口。
- `date-switch` 和 `arrow` 要求 `from` 与上一步实际 ID 一致。日期成功或切到替代点填写两个不同有效月份 `dateBefore`、`dateAfter` 与 `sameLocation: true`。日期切入/切回是两次操作，浏览器返回键不计。新入口、URL、换会话不能拼成一次往返。只有单向日期证据的记 `time-machine-one-way`。
- `date-option` 要求常规锚点及同址目标编号与月份，`result: listed` 只记录关联。道路单向及反向未回保存在 `oneWayArrows`，不能当作日期关系。`panoid-url` 只记录直接访问。
- `reached` 的 `observed` 等于 `to`；`alternative` 填实际到达的不同 ID。`unavailable` 表示本次入口不可用；网络、验证码和操作状态不明记 `error`。
- 如重放时附 `originalRecord`，必须与目标 ID 一致，只有原件自己的 `isHidden: true` 才有效。选填 `history` 中的 `{panoid, extra}` 用以记录同一目标的明确父版本来源。不会从操作输入的 `manualReview` 生成新的人工决定。

```powershell
node tools/audit_panorama_access.mjs observations.json
```

## 离线归档与原件审查

`--public` 在校正后的归档上运行。每个城市中，当前主记录的 `row[9].sourceType === 'hidden'` 和 `row[9].isHidden === true` 必须一致。对所有这样的 ID 排序，以 ASCII `ID + LF` 逐个计算 SHA-256，与[原件复核后的精确城市收据](../config/reviews/source-hidden-flags.json)核对数量和指纹；还要闭合全国城市名册、总量以及逐城人工回执。人工例外在证据类别中优先，不将其重复计为原件布尔真。只有核对通过才产生公开结果；双字段自身不证明旧归档的原件曾为 true。

非公开审查不把未迁移主记录上的旧双字段当原件。可读取 `extra.originalRecord`、`originalRecord` 或同 ID 观察版本中的上述原件槽位；不能把版本归一化时填入的标签、另一个 panoid、时间线成员或邻点的标记归给目标。同 ID 主原件明确的布尔值优先（包括 `false`）；主件未标时才看版本原件，出现相反观察而无法确定主来源则不判隐藏。上传文件按实际读取的原件自身计；同一 ID 可以复用已核实的人工决定，上传自报的 `city`、标签和 `manualReview` 不可信。若旧来源未保留原件证据，不确认隐藏。`returnedBy`、`parentPanoid` 和 `inheritedCoordinate.inheritedFrom` 等一致、同一非自身父 ID 加 `timelineLabel=YYYYMM` 的显式来源历史关系照旧记录，不把父坐标当独立位置。

```powershell
node --max-old-space-size=128 tools/audit_uploaded_streetview.mjs --public `
  "--data-root=$stage" "--binzhou-source=$inputs/百度滨州.json" `
  "--zip=$inputs/11.25.zip" "$inputs/baidu-020-0000-6A-crawler-results.json" `
  "$inputs/baidu-020-0000-5C-crawler-results.json" "--output=$freshSummary"
```

`$stage` 为完成唯一性/完整性校验的归档根，`$inputs` 为受信原件目录，摘要须输出到归档外的新路径。滨州原件 SHA-256 固定为 `7dbfdcd80d11f22d2a446f4965e96d0531aba4fa23ae1148bdf3795cd15e79cc`。逐分片读取目录登记的百度街景，不查小蓝点或联网，不改 `data`；ZIP 流式校验成员大小和 CRC。非公开输出含私有路径，不宜发布。

公开摘要 v3 的 `catalog` 计归档主记录，`uploads` 计输入原始行，**两者不可相加**。`bySource` 仅统计 `sourceType` 标签；`byCategory`、`byStatus`、`byBasis` 及 `sourceByStatus` 记录审查类别、状态、依据及交叉计数。仅公布合计，不公布原件路径、ID 或轨迹。时间线数、移动数和 `metadataOnly` 是上传诊断而非判据。v1.10.1 的 v2 统计如仍显示，仅为尚未按布尔真值重算的历史快照，不能用作现行审查结果。
