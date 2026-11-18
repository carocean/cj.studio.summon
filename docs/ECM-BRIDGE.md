# v0.16 ECM / OpenPorts 只读桥

## 范围

保留 Flutter 感知入口、AIOS 主体/权限/调度内核和可替换模型层。ECM 作为潜在业务服务运行层，当前只对已存在的 OpenPorts Hello 服务做真实只读协议验证，不把 Hello 包装成菜单业务。不迁移内核，不依赖 MIC 热卸载，不修改框架源代码。

已有源码与验证依据：`carocean/cj.studio.ecm` 的装配/JSS 服务、`carocean/cj.netos.openport` 的 CjOpenport/OpenportCommand、`carocean/cj.studio.gateway2` 的 HTTP 通道、`carocean/cj.netos.examples` 的 Hello 示例。本轮使用独立复制的既有 Gateway 2.4.6/OpenPorts 示例 runtime 和 JDK8 启动进程，测试后终止。原始框架和运行二进制不纳入本仓库。

## 真实协议与边界

固定请求：`GET /hello/helloworld.ports?name=Summon`，头 `Rest-Command: helloworld`、`Accept-Encoding: gzip`。真实响应 HTTP200、gzip/chunked，解压后外层 JSON `status=200`，`dataText` 仍是 JSON 字符串，二次解析为 `Hello Summon!`。不能依赖 Content-Type，示例返回 text/html。既有框架无压缩路径有 Content-Length:0 framing 缺陷，本桥不修改框架，以gzip协商使用成功路径；空响应会明确失败。

配置只在部署端：

```sh
export OPENPORTS_HELLO_ENDPOINT=http://127.0.0.1:6060/hello/helloworld.ports
# 可选 OPENPORTS_TOKEN：部署密钥，使用 CjOpenport 默认 cjtoken 头。
# 不传 AIOS APP_TOKEN，不传 owner 身份，不放客户端或仓库。
```

URL 不接受用户信息、query、fragment；非localhost只接受HTTPS；拒绝重定向。目的地址、命令和参数不能来自请求、媒体或模型。唯一输入固定为非个人字符串 `Summon`。Token 默认头只验证过测试服务契约，实际 Hello 不要求 token，不代表业务 token/用户身份体系已经联通；使用其他 token 名的业务服务尚不支持。

启动后，不自动给主体授予外部能力。通过现有挂载接口明确添加 `ecm.hello.read`，再用 `/v1/invocations` 指定主体、服务、模拟空间和 `text` renderer；调用参数必须为空。未配置桥时服务发现标为不可用，发现不会发送网络请求。普通 Flutter开发页面尚未提供该探针按钮，主感知界面不添加静态业务菜单。

调用前检查所有者、活动状态、AIBM服务/空间/呈现边界；异步返回后复查授权世代，撤权再授予也不能提交旧输出。读取请求一旦发出无法撤回，但不给外部服务任何写操作权限。输出只返回受限业务文本，不返回端点、token或远端诊断；超时5秒、解压后最多32KiB，业务文本最多4000字符。空间目前是模拟而非可信定位。

## 验证和下一步

测试区分本地HTTP协议替身与真实Java进程：`server/test/openports.test.js` 前三项验证gzip、框架双层JSON、HTTP/业务错误、空响应、超限、超时、跳转、身份不透传、发现不执行和撤权世代；最后一项显式 opt-in，用 AIOS 实际鉴权 HTTP→调度器→真实OpenPorts，并断言未带认证的调用401、有认证返回 `Hello Summon!`。

```sh
OPENPORTS_REAL_TEST_ENDPOINT=http://127.0.0.1:6060/hello/helloworld.ports \
  node --test server/test/openports.test.js
```

下一步在明确只读业务接口和身份契约后对接 menu.read，保留真实回执与授权；再把业务结果转成感知/业务状态驱动的受限呈现。尚未验证业务租户身份映射、Gateway路由集群、MIC、生产吞吐或容灾，不宣称已完成 ECM 业务系统集成。

### v0.17 复核加固

每个桥实例最多2个并发上游读取，超额立即返回 openports_busy，成功/失败/超时均释放计数。业务文本若包含配置token的原文、URI编码或Base64编码则拒绝整个响应，以免将合法dataText里的凭据回显带回客户端；拒绝错误不含原内容，不记录业务文本。此检查不是任意变形/部分密钥泄漏的通用DLP，仍只能连接可信固定部署端点，真实业务密钥体系未验收。
