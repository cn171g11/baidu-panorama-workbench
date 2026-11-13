# 地图显示与官网街景跳转验证

## 地图与报告

- 默认底图为高德暗色：使用高德标准瓦片并对瓦片层应用暗色滤镜；点位图层不反色。
- 高德模式点位为 BD-09 → GCJ-02；OSM 模式为 BD-09 → WGS84。切换底图会同时转换中心与弹窗位置，保留缩放级别。
- 散点使用单个 Canvas 分批绘制：常规元数据标记为黄色，未标可用为青色，源标注隐藏为红色白边，源标注时光机为紫色。
- 密度模式为视野内方格聚合，颜色表示相对密度；放大至 Z15 后绘制每个真实点，不以网格中心冒充点位。
- 点击地图选择当前视野内最近的匹配点。道路、日期或类型过滤可保留灰色背景上下文；搜索 panoid 只显示匹配结果。
- 报告仅读取小型已发布城市目录；构建逐个验证分片后生成每城 `displayCounts`，不在报告页下载全国点位。
- 省级行可展开城市；支持搜索、分类排序和仅隐藏城市筛选。筛选后省级合计重新计算。城市/隐藏数量链接能直接载入对应城市及类型。

## 分类口径

`classification.js` 在地图、构建、报告中共享规则：

1. 明确 `sourceType: time-machine` → 时光机；
2. 明确 `sourceType: hidden` 或 `isHidden: true` → 隐藏；
3. 明确 `sourceType: unknown` → 未知；
4. 其他 → 常规归档类别。

这些是**源数据标注**，不等于本次已用百度拓扑接口证明隐藏，也不等于影像现在可访问。不以 panoid 编码推断拍摄日期，不用时间线数组长度覆盖源标签。冲突观察版本保留但不重复计入主点位；当前滨州主记录中的隐藏 7,418、时光机 91 均可核对。

## 官网跳转

旧 query 入口 `?qt=pano&panoId=...` 被百度地图忽略，因此不再用于任何普通、隐藏或邻接 ID 链接。统一使用官网全景 hash 分享入口：

```text
https://map.baidu.com/#panoid=<encoded-id>&panotype=street&heading=0&pitch=0&l=19&tn=B_NORMAL_MAP&sc=0&newmap=1&shareurl=1&pid=<encoded-id>
```

主记录具有有限百度墨卡托 `x/y` 时，可附加 `@x,y,19z` 作为地图中心。邻接/时间线 ID 不能借用主记录的坐标，官网根据目标 ID 解析位置。归档 `zoom` 是全景缩放，不当作底图瓦片 zoom；null 坐标不转换成零点。

## 已取得的实际官网证据

桌面 Edge 中分别打开了深圳普通 ID、滨州源标注隐藏 ID和时间线 ID。验证同时要求：

- 官网 `#panoid` 最终仍为指定 ID；
- 可见全景容器与全景 Canvas；
- 页面进入“返回地图”的全景状态；
- 指定 ID 的 `pdata` 影像响应 HTTP 200。

三类实例通过；验证工具为 `tools/verify_official_links.mjs`。这不是全库影像可用性普查，也不是 Android App 或所有手机浏览器实测。百度网络限制、已删除影像、或手机官网跳转策略仍可能影响访问；手机若转到普通地图，可尝试浏览器“桌面版网站”。本站不代理、不保存影像、不保存官网认证参数。

## 本地与线上验收

```powershell
$env:GITHUB_SHA = git rev-parse HEAD
npm test
node tools/publish_pages.mjs
node tools/browser_smoke.mjs --site-root dist/pages --ui-fixture
node tools/browser_data_check.mjs --site-root dist/pages --require-pages --city 371600
node tools/browser_display_check.mjs --site-root dist/pages
```

`browser_display_check.mjs` 额外读取 Canvas 像素确认分类颜色，核对底图切换（中心以1像素精度、弹窗以坐标精度）、缩放的实际点数、报告折叠/隐藏筛选/深链接和360/390/768/1440布局。合成测试点位只在临时浏览器中，不发布到目录。

正式上线须等待 Pages 工作流成功，再核对线上构建提交、分类数和实际页面，不把 push 成功当作上线完成。
