# GitHub Pages 分批直接托管城市

## 当前方式

根 `data/` 保留完整百度元数据，构建不会删除或改写。`.github/workflows/pages.yml` 用 `tools/publish_pages.mjs` 生成本站同源城市分片；不再仅发布指向 GitHub Raw 的链接。

[发布配置](<../config/pages-publication.json>) 控制实际发布城市。2026-11-14曾按用户要求从44集合缩减为滨州单城，2026-11-16恢复阿拉善盟。2026-11-17追加澳门常规街景后，用户两次指出误归珠海点；按确认共撤回4,107条（1,387条原珠海ID，2,720个090063前缀点移入珠海）。澳门现 **24,796条**（全090107），珠海 **102,720条**，其他澳门坐标未改。当前选定3集合 / **112,521条**，完整活动归档仍293集合 / 19,019,450条。来源保留和归属修正见 [澳门导入记录](<macau-import-20261117.md>)；本次部署验收前不能将新构建称为已上线。

缩减清单时Pages每次部署整体替换旧快照，旧城市gzip不会残留。当前CI实际浏览器回归仍以滨州为基准；新增澳门另运行真实堂区加载与来源字段验证，不能仅凭既有滨州CI检查证明新城市内容正确。

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

该工具逐城下载普通城市gzip，但目前不支持 `counties/<id>/points-NNN.json.gz` 县级路径；**县级部署不要重试它来等待上线**。县级验证应从同一线上manifest逐资产核对压缩/解压SHA、大小与计数，结合 `browser_county_check.mjs --url <站点根URL> --city <ID>` 的实际浏览器检查；本次澳门验证脚本和报告只放忽略的dist。
6. 成功后再扩下一批。失败时保留完整源数据；恢复上次成功发布的城市清单并重新部署。Pages每次部署是整体快照，不能靠省略旧文件累积文件，必须把已成功城市继续包含在清单中。

## 尝试全量

将 `cities` 暂设为 `["all"]` 可以构建完整280城市。约792MB gzip仍符合Pages的1GB容量上限，但先前两次部署在服务端同步阶段超过deploy-pages最大10分钟，因此优先先少量城市再逐批扩大。若再次超时，不删除任何记录以“成功”；改回上次成功批次。

## 发布安全和计数

- manifest为 `codec: "gzip"`、`source: "github-pages"`，URL只允许本站相对路径 `baidu/<id>/points-NNN.json.gz`。
- 分片gzip压缩前核对全库验证SHA，写后回读并解压逐字节比对。
- 浏览器核对gzip前后的大小与SHA，并验证百度来源、重复ID和条数。
- `catalog.total`、`collections` 和统计只计当前已发布批次；`catalog.publication` 保存全国源总量与剩余城市。
- 根源目录完整280城市、18,991,223唯一ID不变。站点的部分发布不表示缺失源数据。
- GitHub Pages本身仍不保证中国大陆所有网络可达；此方案减少对独立GitHub Raw域名的依赖，不是国内CDN保证。
