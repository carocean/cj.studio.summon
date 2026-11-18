# iPhone测试交付核查：本地前置可转移，设备交付仍阻塞

核查基线：`512c9febfc83123c7a74d53a31987353ab174e6b`。本轮只调查与构建，没有公开部署、注册、付费、签名账户登录或安全设置修改。

## 结论

当前没有可给iPhone直接使用的安全地址或安装包。三个独立缺口不能用一张截图或成功编译代替：

1. 仅有连接中的Linux云电脑，没有可用Mac/Xcode/iPhone构建环境。保存的云配置也仅为空Default，不能提供iOS工具链。项目未配置DEVELOPMENT_TEAM，未发现IPA；这不代表用户没有Apple账号，只是此任务没有已验证的签名访问。
2. 没有已知、已授权且iPhone可访问的私有HTTPS域名/后端，已由主任务确认。不得将127.0.0.1转述为手机可用地址，也不自动开公开隧道、改防火墙、信任自签证书或改变认证策略。
3. 最新餐厅确认→正文组件只在测试中挂载，默认Home/Preview未调用。现有`CreatureHomeController.presentDish`打开旧`DishRemoteSurface`，不是新的明确确认链。打包默认入口不会自动获得新餐厅路径。

## 本轮实际完成的可转移前置

- 基线明确开启`SUMMON_PROTECTED_PREVIEW=true`、禁用Web资源CDN的release编译成功，耗时约62.5秒。
- 现有严格资源打包器成功：17个文件，28,640,171字节，CanvasKit-full，本地字体，未注册service worker。
- `PREPARATION_AUDIT.json` SHA256：`fee716379469b008dca14f3fc052f8ab8cef5956da59c4eeae26c8779d986b34`。
- 打包器/资源边界/渲染策略测试19/19通过。
- 输出仍明确`deployable:false`：默认CSP阻止Wasm/引擎样式；已有显式opt-in nonce渲染策略还缺真实浏览器验证。没有启用该策略或验证Safari。本轮不重复已知云浏览器loopback失败。
- iOS Info.plist解析通过；有摄像头/麦克风使用说明，无ATS放宽。Bundle ID为`cj.studio.summonApp`，deployment target15.0。工程引用Flutter生成Swift Package，不能因无Podfile就断言工程损坏；原生插件解析/链接仍需Mac实际验证。
- 实际尝试iOS构建命令在本工具链退出64；`flutter build --help`没有ios子命令，只有aar/apk/appbundle/bundle/linux/web。没有生成或验证IPA。

这些是资源准备和静态前置，不是手机QA、签名成功或可交付服务。

## 候选交付路径及精确缺口

### A. 同源受保护HTTPS Web预览

最少新增平台依赖，但当前仍缺被批准的手机可达HTTPS宿主、有效证书与Safari实测。现有gate拒绝代理伪造头，不能直接套一个反向代理/公开隧道就声称安全；实际拓扑需要专门复核。后端仍应只允许固定loopback upstream，邀请值不得写URL/构建包/日志，cookie与CSRF保留。

并且需要先补默认关闭的餐厅开发入口（见下），然后重建资源并用真正Safari核查登录、退出、键盘/焦点、后台失效、渲染CSP与无外域请求。现阶段不能给出可用链接。

### B. 已有Mac上的Xcode直连个人iPhone

Flutter官方文档要求macOS/Xcode进行iOS构建；个人设备测试可用免费个人开发账号，但仍须签名、设备信任和Developer Mode。当前无已连接Mac，也未验证用户现有账号/设备状态，本轮没有进行任何这些操作。必须先有已批准的既有环境，不能擅自新注册或改变设备安全设置。[Flutter iOS设置](https://docs.flutter.dev/platform-integration/ios/setup)

还有应用层缺口：`SUMMON_PROTECTED_PREVIEW`使用`PreviewSessionClient.currentPage()`；原生stub明确抛`preview_requires_browser`，因此不能把Web预览配置原样编成IPA当作已支持受保护后端。需要另做原生认证/会话接线与手机可达后端，不能通过硬编码测试邀请或放宽TLS补洞。

### C. TestFlight

适合后续持续分发，但须先有Xcode签名archive、App Store Connect应用及既有合法开发权限。Apple流程要求上传构建再邀请测试者，外部测试另有测试信息/审核要求。当前未验证这些账号或签名条件，不能承诺立刻发包；未注册、付费、上传或发送邀请。[Flutter iOS发布](https://docs.flutter.dev/deployment/ios)、[Apple TestFlight](https://developer.apple.com/testflight/)

## 下一阶段具体本地候选（本次调查时尚未实现）

后续隔离切片已实现默认关闭的本地开发入口，见 [餐厅开发入口](RESTAURANT-DEV-ENTRY.md)。这只闭合以下本地入口缺口，不改变本文手机网络、签名与浏览器验证阻碍。

可利用现有主替身和受保护开发入口，而不增加生产固定按钮或假麦克风：

1. 新增仅编译期开启、默认false的`SUMMON_RESTAURANT_DEV`。保持普通构建主界面、无默认文本框、无常驻餐厅按钮不变。
2. 在开发构建的替身长按交互中临时显示“查看宿主已准备的餐厅请求（开发）”，明确它不会录音，也不是自动感知。替身目前是非交互组件，这一步确实需要实现，不能称已有。
3. 经受信宿主配置固定sessionId与expectedContext，不从网页/LLM或URL参数取权限。增加controller呈现方法，复用现有`_presentDish`的foreground/authEpoch/scene检查，但挂载`DishConfirmationRemoteSurface`，禁止走通用dish-command。
4. 本地可信host先以明确标注的合成音频准备真实TTS/Vosk/Qwen待确认；开发动作只读取，绝不替用户自动确认。下一层仍由用户显式show，显示同菜正文；切换需求回到替身并保持旧已提交状态。
5. 覆盖开关关闭时不可达、未认证/错误scene/错误session拒绝、重复长按单一surface、退出/后台/新任务丢弃迟到结果、显示“合成输入/受控播放器”边界。

这个候选能在现有本地TLS/Flutter测试路径内复验主替身到餐厅链，但不能解决iPhone网络或原生签名阻碍。也不能替代真正手机麦克风/播放器接入。

## 最新能力边界保持不变

512c9fe的同次真实软件链使用Qwen2.5-1.5B；两个表达可见正文，否定clarify而非none严格失败。“解释一下这道菜”ASR误成“你试一下这道菜”，最终动作匹配不是可靠理解。4B合跑失败属于基础设施，不能让1.5B结果替代4B验收。详见`DISH-REAL-UI-INTEGRATION.md`。
