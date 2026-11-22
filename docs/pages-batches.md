# GitHub Pages 分批直接托管城市

## 当前方式

当前源归档为321集合 / 18,325,109唯一panoid。发布配置选择33集合：5个国内集合只发布源标注hidden、使用县级分片；28个海外集合的97条记录全量发布普通时间分片。`hiddenOnlyCities`是**要过滤的国内城市列表**，不是豁免列表；省蓝点资源独立发布。此前ad0ac9d部署在真实县级浏览器门禁失败，不能据其push声称海外已上线。修复说明与真实加载回归见[城市加载反馈](<loading-feedback.md>)。下方旧批次数量是历史记录，不代表当前快照。

根 `data/` 保留完整百度元数据，构建不会删除或改写。`.github/workflows/pages.yml` 用 `tools/publish_pages.mjs` 生成本站同源城市分片；不再仅发布指向 GitHub Raw 的链接。

[发布配置](<../config/pages-publication.json>) 控制实际发布城市。澳门归属修正后保留24,796条；阿拉善盟、滨州、澳门112,521条已有线上验收。2026-11-19按用户无人值守请求加入香港与拉萨并用本地panoid补齐：香港403,873条、拉萨133,284条，累计5集合 / **649,678条**；全国293集合 / 19,356,607唯一ID。7个已属深圳的重复ID保留原归属。香港父界严格校验失败，完整点位暂以未匹配分片发布；拉萨采用8县区真实OSM边界。详情见 [香港拉萨导入](<hk-lhasa-import-20261119.md>) 和 [澳门修正](<macau-import-20261117.md>)。构建清单未经实际线上验收不得称为已上线。

缩减清单时Pages每次部署整体替换旧快照，旧城市gzip不会残留。CI以滨州验证国内县级街景，以鹿儿岛验证海外普通分片，另外用微型合成HTTP分段body检查加载框/取消/失败反馈，并验证山西蓝点像素和数据报告；不能仅凭其中一种检查证明所有新功能正确。

## 增加城市

1. 只在现有 `cities` 数组追加六位城市 ID，不移除已成功发布的 ID。也可以使用工具先查看计划，再追加较小城市：

```powershell
node tools/expand_pages.mjs 20 --dry-run
node tools/expand_pages.mjs 20
```

`--dry-run` 不写配置；正式命令保留已有城市并按点数从小到大增加最多20城。它不会自动部署或改动根数据。每一批实际部署成功后才能继续执行下一批。

2. 本地运行：

```powershell
$env:GITHUB_SHA = git rev-parse HEAD
npm run build:pages
node tools/browser_data_check.mjs --site-root dist/pages --require-pages --result-dir dist/check-new-batch
```

3. 检查构建输出 `total`、`collections`、`compressedDataBytes` 和实际大小；默认上限900MB。
4. 只提交发布配置/构建代码/必要页面改动。不要提交 `dist`、APK、签名材料、本地AI记录或原始下载包。
5. 推送后等待 workflow `build`、`deploy` 均成功，再核对线上 `build.json`、`publication.json` 和真实城市 `.json.gz`，浏览器须没有GitHub Raw请求。可完整核验当前已发布所有城市：

```powershell
node tools/verify_pages.mjs --commit <完整Git提交SHA> --output dist/verified-batch.json
```

[完整线上核验工具](<../tools/verify_pages.mjs>)支持普通与 `counties/<id>/points-NNN.json.gz` 县级路径，逐资产核对压缩/解压SHA、大小与计数。仍须结合 [县级真实浏览器](<../tools/browser_county_check.mjs>) 与 [海外普通城市浏览器](<../tools/browser_data_check.mjs>) 的交互检查；只通过下载核验不能证明载入入口、进度框和地图绘制正常。
6. 成功后再扩下一批。失败时保留完整源数据；恢复上次成功发布的城市清单并重新部署。Pages每次部署是整体快照，不能靠省略旧文件累积文件，必须把已成功城市继续包含在清单中。

## 尝试全量

将 `cities` 暂设为 `["all"]` 可以构建完整280城市。约792MB gzip仍符合Pages的1GB容量上限，但先前两次部署在服务端同步阶段超过deploy-pages最大10分钟，因此优先先少量城市再逐批扩大。若再次超时，不删除任何记录以“成功”；改回上次成功批次。

## 发布安全和计数

- manifest为 `codec: "gzip"`、`source: "github-pages"`，URL只允许本站相对路径 `baidu/<id>/points-NNN.json.gz`。
- 分片gzip压缩前核对全库验证SHA，写后回读并解压逐字节比对。
- 浏览器核对gzip前后的大小与SHA，并验证百度来源、重复ID和条数。
- `catalog.total`、`collections` 和统计只计当前已发布批次；`catalog.publication` 保存全国源总量与剩余城市。
- 当前根源目录321集合、18,325,109唯一ID；历史280城/18,991,223是最初输入基线。站点的部分发布不表示删除未发布源数据。
- GitHub Pages本身仍不保证中国大陆所有网络可达；此方案减少对独立GitHub Raw域名的依赖，不是国内CDN保证。
