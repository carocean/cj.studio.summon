# 餐厅场景：同设备菜品焦点与呈现修订实验

## 来源与范围

AIWatch BP 第6页：菜单播报中，用户打断询问陌生菜名，要求图片、放大，随后转手机查看。当前实现仅为同设备的纯状态协议，不是餐厅App、自然语言理解或实时语音打断。跨设备、下单、付款和评价均不实现。

`runtime/src/dish-focus.js` 编译显式标为 synthetic 的菜品数据，保存 taskId、catalogDigest、稳定dishId、revision、递增speechSequence和视图参数。菜单名称、描述、图片引用来自合成fixture；description/imageRef缺失保留null，不猜测菜品或生成虚假照片。imageRef仅符号ID，不取URL、不加载图片，也不证明授权或来源。

## 状态顺序

1. `speak(dishId)` 将焦点切至明确菜品，并创建新的语音序号，状态为playback-requested。**不表示实际开始发声。**
2. `interrupt(speechSequence)` 固定当前菜品，进入stop-required。
3. 可信播放器确认停止后，宿主调用 `stopped(speechSequence)`。停声失败不可伪造确认。
4. `details`、`image`、`zoom(in/out)` 在原task/dish上调整呈现。每次需要原revision；放大范围1000–3000 permille，步长250，越界拒绝。
5. `hide` 仅收起呈现，保留task/dish；下一道菜只有此前声音已确认停止时才能切换。

此协议只描述半双工停声之后继续交互的门槛。没有VAD、声学回声消除、自动识别语音起点或麦克风并行采集，不得称为真实barge-in。正常播放完成目前也未单列事件；本实验固定走显式停止链，后续应依据真实播放器证据扩展。

## 绑定与隔离

- 所有输入先经既有canonical snapshot限制；不接受扩展字段、任意URL或命令。
- 修改catalog后摘要变化，旧焦点不可静默绑定新图片或新菜资料。
- 旧revision、旧speechSequence和重复停止均拒绝；同菜重复播报也用新序号。
- 纯函数返回不可变新状态，错误不修改原状态。但这不是宿主事务CAS：未来HTTP接线必须在可信owner/creature/context绑定下原子核对并保存。
- 客户端不能凭此声明自己已停声、自己有权限或已向设备发送内容。

## 本轮验证（独立副本，不是远端发布）

基线HEAD8734b12：Node403项395通过/8可选跳过，preview asset12/12；Flutter串行349通过/2跳过，analyze无问题，默认Web release编译成功（58.2秒）。历史4失败与exit130未在本轮重现，不推断旧失败全由调度造成。所有Flutter命令使用双analytics suppress变量及缓存依赖，不改用户设置。

最终Node全量423项：415通过、8跳过、0失败，含新增8项菜品协议测试及12项preview asset测试。独立审查发现非字符串命令名可被属性键隐式转换的问题，已添加严格类型门槛和拒绝测试。

新增专项覆盖：第二道菜指代连续、停声门槛、过期响应、重复事件、缺图降级、缩放边界、catalog变更、无效状态、不可变输入及修订耗尽。仅纯协议测试，无真实声音、LLM、图片渲染或真机证据。

## 下一接线

可信宿主保留当前播报item与sequence；播放器stop结果驱动确认；需求解释必须输出绑定当前焦点的引用而非随意名称。先接真实本机音频停止与同设备呈现，分别测试迟到合成/失败/取消，再做设备授权和迁移。不能先在默认首页增加固定菜单入口来冒充生成式交互。

## 本地微内核接线（不含传输层）

`runtime/src/dish-session.js` 将纯协议接入真实 `HostIdentity` 与 SQLite `SnapshotStore`。受信宿主安装不可变合成菜单，已认证 owner 创建自己的 session。每个动作在事务内核对并写入修订，不接受客户端替换整份状态。owner 普通命令不能声称 `stopped`；只有配置的宿主管理员能调用 `confirmStopped`。这是可信宿主接口约束，并非实际播放器证据的自动验证。

会话绑定 owner、creatureId、sceneRevision、taskId、catalogDigest 和随机宿主 epoch。观察到场景变化后持久标为 stale，场景值回退不恢复；适配器重建或进程重启后，旧记录与迟到播放确认均失败关闭，不能用旧记录恢复播放。`close` 退休此宿主。没有网络路由、远程身份、权限授予、外部API调用、音频采集/播放或Flutter渲染。此阶段“端到端”仅指身份→宿主→纯协议→真实SQLite事务→读回，不是设备端到端。

目前没有命令幂等回执，重复/超时重试应先读回当前修订再决定；没有自动删除持久记录或跨epoch迁移。后续接线不能把客户端上报当作已验证的物理停声事实。自然播放完成与音频运行时仍是后续工作。

接线后最终Node全量431项：423通过、8跳过、0失败，其中菜品纯协议8项、宿主8项。独立审查指出同步context回调可退休宿主或推进会话，使外层读返回旧状态；已在回调后复验宿主生命周期与存储修订，并用真实SQLite补测退休时read/command/create拒绝及旧读取冲突。没有将内核测试称为真机或实时音频验证。

## 受保护传输阶段

SceneLab仅公开`dish-read`和`dish-command`，经既有TLS邀请登录、会话cookie、Origin/CSRF校验及请求体上限转发。owner由服务器固定绑定，不由请求选择。安装菜单、创建会话、确认播放停止仍是宿主内部方法，无公开路由；`command.kind=stopped`也被拒绝。读视图中的菜名、说明、图引用来自同一已绑定catalog，不接受请求替换内容。

每会话focus修订最多256，达到后拒绝新增命令，原状态仍可读。限制用于避免远程重复details/hide无限追加SQLite历史。安装和创建仍由受信宿主控制，不宣称多租户配额完整。

真实临时TLS测试覆盖未登录、缺CSRF、异源、owner注入、未公开宿主端点、伪造stopped、未停声时图片拒绝、同菜详情→图引用→放大、过期修订、畸形命令、超大请求、场景变化及退出失效。测试没有实际播音，只用显式合成宿主确认。

## Flutter按需呈现接线

受信客户端宿主通过`CreatureHomeController.presentDish(sessionId, expectedContext:...)`请求打开已有会话。不会新增默认主页菜单、文本框或菜品按钮。打开前校验当前场景及授权周期；退出再登录或替换授权对象后，旧请求不能打开界面。

`DishRemoteSurface`只读已有会话并提交details/image/zoom/hide四类命令，绝不提交stopped。授权撤销、退后台或绑定变化会清除呈现并丢弃迟到响应；失败结果不自动重试，用户需重新打开读取当前状态。缩放不乐观更新，仅使用通过同session/context/task/catalog/dish和递增revision校验的响应。

`DishView`严格校验结构与JS安全整数；`DishSurface`没有场景时为空白。合成图只支持`synthetic-soup`本地CustomPaint插画，并标注非真实菜图，不下载远程图片。业务菜品图片获取、许可、真实麦克风与播放尚未实现。所有会话仍由宿主显式创建，不称已经具备自然语言自动生成菜单能力。

真实Flutter链路专项`dish_live_test.dart`使用临时自签证书仅供测试客户端显式信任，经过真实登录、TLS、保护代理和SQLite。宿主fixture显式创建合成菜品并模拟停止确认，Flutter实际点击说明→插画→125%放大，核对同session/dish/task/catalog、修订递增，再真实HTTP读回持久状态。审计客户端只发送image/zoom，不发送stopped。此结果证明合成数据的软件闭环，不证明真实语音、真实摄像头、真机或跨设备。

独立只读审查确认此链路不是响应mock；证书没有加入系统信任。Flutter运行于桌面widget测试并使用原生HTTP，不能替代真实浏览器cookie/CORS、手机真机与跨设备验证，也未覆盖从首页自动识别需求并创建会话。

本阶段最终验证：Node全量433项，425通过/8跳过/0失败；Flutter全量361通过/2跳过/0失败（含12项新增菜品UI/真实TLS专项），analyze无问题，默认Web release构建成功54.3秒。最初真实链路测试在最终读回步骤因Flutter fake-async等待方式超时，已改为泵动测试事件循环等待真实请求完成，未改变生产业务逻辑；完整套件复跑通过。所有结果来自隔离克隆，未发布或推送。
