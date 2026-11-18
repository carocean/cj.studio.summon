# 受控 CanvasKit 渲染策略准备（deployable: false）

这是可信宿主显式选择的独立策略，不是默认启用，不是浏览器或手机验收。
`createProtectedPreview({ ..., assets, renderProfile: {kind: 'flutter-canvaskit-v1'} })`
启用准备模式。省略或 null 保持旧策略。HTTP 不提供选择、修改策略或 nonce 的入口。

## 唯一文档契约

资源打包器从 `runtime/src/preview-render-profile.js` 导入 `PREVIEW_RENDER_HTML`，
将其精确 UTF-8 字节放在 `/`，类型 `text/html`。必须有非空同源
`/flutter_bootstrap.js`，类型为 JavaScript。其它 HTML（含 `/index.html`）拒绝。
模板没有 base、内联脚本、事件属性或可变用户文本。构造时复制资产，随后修改宿主 Map
不改变服务快照。模板字符串不匹配就拒绝；不是对任意 HTML 做正则净化。

每次认证通过的根 HTML 响应生成 32 随机字节的 base64url nonce（43 字符），
替换唯一固定 meta `summon-preview-style-nonce` 的占位值。外部 bootstrap 必须
验证唯一 meta 和格式；占位未替换须 fail closed；把 nonce 传给
`_flutter.loader.load({nonce, config: {nonce, ...}})`。此值仅为 CSP style nonce，
不是登录凭据或 CSRF token；不得持久化或加入 URL。

根响应保留原 CSP，并增加：

- `script-src 'self' 'wasm-unsafe-eval'`
- `style-src 'self' 'nonce-<本次值>'`
- `worker-src 'none'`

不允许通用 unsafe-eval/unsafe-inline、外域、blob worker 或通配。
Wasm 编译权确实比旧策略宽，限明确 opt-in 文档；不声称它消除可信 JS/Wasm 的风险。
策略不自动信任 inline script，脚本 nonce 不在 script-src 白名单。
浏览器使用文档 CSP 约束所加载脚本，JS 资源响应本身仍是旧 CSP。
登录壳、API、错误响应保持旧 CSP。所有响应仍 no-store, private / no-cache，
不生成 ETag 或 Last-Modified，不处理条件请求为 304。每个并行/再次导航 HTML 独立 nonce。

## 信任与限制

资产本来就是可信宿主代码；这里不是第三方 JS 沙箱，不静态证明 bootstrap 的任意内容
安全。Host 需要使用已审计专用 bootstrap、本地字体与本地 CanvasKit；对 JS MIME/存在性
的检查不能代替代码审核。不能把不可信文件作为资产输入。

字体、worker、媒体、渲染兼容性未因此获得验证；不增加媒体 API 权限。
仍需真实浏览器验证 Wasm CSP 支持、SDK nonce 样式、动态 CSSOM、实际中文字体、
Safari 输入/焦点、认证状态及无外域请求。默认 service worker 不应注册。
没有部署、OS/browser 设置改变或放宽网络/证书安全。

本切片真实临时 CA TLS 测试覆盖 nonce 变化/绑定、不缓存、未认证和登录策略、
根模板注入/重复 meta/其它 HTML 拒绝、默认兼容、宿主配置 getter/Proxy 拒绝。
没有启动引擎、浏览器、SDK 或模型。
