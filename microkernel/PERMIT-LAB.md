# Linked Permit lab 0.4：受控来源到模拟执行

下列0.3基线保留用于说明增量，最新联通能力与仍存限制见文末0.4节。

这是 `docs/PERMIT-LAB-PLAN.md` 的**更小实现子集**，不是完整执行授权协议。它证明模拟派发的事务骨架，不替代多生物、真实听视觉、业务生成场景体验。

## 已实现

- 持久 authorityDomain；固定只读服务清单 `simulated.record.v1` 和封闭 `synthetic.empty.v1` 上下文。输入仅两个枚举 `synthetic-form` / `synthetic-scene`，没有真实表单、媒体或个人数据。
- 管理员签发**独立模拟额度**，限定controller、次数、期限、epoch；不会把 read/derive/disclose Grant 转为执行权限。prepare原子保留一次额度，未消费取消只释放一次；消费不明继续保留，可信观测后结算。
- 每activity至多一个attempt，fence固定1；已终结活动不复活，不提供重派。绑定域、活动、尝试、清单、输入、环境构造的无来源上下文、效果、执行器、接收方、预算及世代。
- issued→consumed及派发事件与command ack同事务。唯一同步broker仅在首次消费后到达私有模拟sink；命令重放只有历史ack。
- 独立 SQLite sink，效果键包含域与effectId，完整绑定摘要冲突拒绝；同活动fence检查先于去重。本版本不签发第二fence，不能因此宣称已验证重派隔离。
- 消费后的持久状态立即为uncertain；重启不扫描重发。controller可受控核对自己已消费的合成事实，即使执行额度后来撤销；查询不是新的执行权。
- 取消意图和事实独立；已消费取消不退款，迟到观测仍结算并保留cancel_requested。
- 不公开registerReceipt，回执仅来自私有固定sink。dispatch ack只称dispatch_recorded；业务观测从inspect/reconcile取得，不能把返回ack视为“开户完成”。

## 测试

微内核当前31项。新增10项：immutable binding/身份、重放、单slot/预算/释放、撤权与观察到过期后的重启回拨、消费后未发送、sink已写回执丢失/迟到取消、拒绝任意来源/issuer/真实业务，以及两个真实子进程SIGKILL断点（消费提交后和sink提交后）。每个断点都重新打开两个数据库并核对，不自动重发。另测issued重启恢复/身份隔离，以及关闭broker后拒绝派发且不消费预算。

`testFault`是**可信宿主构造参数**，不是Agent/API输入。仅固定异常或杀死测试子进程，不接受代码回调。生产接入前应从生产配置中隔离该测试能力。

## 0.3时的未实现项（0.4联通更新见后）

- 没有接入Grant委托闭包、真实Context来源、持久生产身份、远端认证、真实权限隔离或插件沙箱。原上下文lab与本切片仍分开，不能声称已端到端授权。
- 模拟额度无委托且只计次数；不是模型token/货币计量或通用预算结算。每活动仅一个attempt，没有安全重派、跨活动互斥、分布式限流或远端fencing证明。
- 未接Flutter、真实模型、真实设备、网络发送、实际开户或其他现实写动作。枚举场景是固定协议测试数据，**不是生成式表单能力**。
- 固定sink仅一种观测确认，不是完整多级回执注册机制；无任意商户的accepted/claimed/observed验证。
- SIGKILL不等于掉电、磁盘损坏；无法观察的时钟回拨仍非完全单调保证。持久command历史容量治理尚待后续单独任务。
- 宿主拥有store和身份管理能力，本实验不防恶意宿主直接篡改数据、换sink或伪造身份。接入真实Agent前需独立进程/接口封装，而不是把整个PermitLab/store对象交出。

下一步先独立QA，之后逐步连接受控Context/Grant和实际结构化场景纵切；不以增加模拟版本取代产品交互链。

## 0.4：Grant / Context 在消费处联通

`prepareFromArtifact` 只接受 `ControlledContextLab` 已生成的Artifact引用和用途。受控环境读取完整原始/继承依赖闭包，校验来源控制者、期限、read+disclose权限及固定接收者local-sink；冻结Artifact摘要、原Context摘要、闭包与所有祖先Grant世代。它不接受Agent自报来源或隐藏状态。

`dispatch` 在**同一个core SQLite事务**中重新检查这些绑定及当前来源/Grant边界，扣每个贡献Grant的数据calls/bytes，并消费Permit及记账。任何数据预算失败都会回滚全部扣费与许可消费。之前独立保留的模拟执行额度维持保留，可由未消费取消释放。数据披露扣费在消费后未知结果时不退，不因恢复而再次扣费。数据权限与模拟执行额度是两个必要条件，read/disclose并不自动授予执行。

Context服务和GrantLedger必须连接同一store/身份域，否则broker构造时拒绝。观察到的过期仍先持久保存，避免后续拒绝回滚过期事实。每次联通操作捕获broker/ledger两个可信时钟的较大值作为同一观测时刻，再传给所有allocation/Grant/source刷新；不能门处按较大时间拒绝、锁存时却按较小时间而让回拨复活。此内部observedAt不对Agent开放，不承诺未观察到的时间流逝。消费后无异步调度间隙，私有sink接收完全缓冲的合成枚举数据并再次验证输入/效果摘要；回执只保留效果证据，不返回来源内容。linked活动的inspect不返回input/context，避免状态查询绕过来源披露门。

**仍严格限定**：payload允许synthetic-form/synthetic-scene及文末新增的固定三枚举合成表单，不是真实业务表单，也不允许任意文本/媒体；未知模型上下文不接入。合成内容也保留来源限制，用来检验撤权和跨Agent边界。实际执行权仍为无委托的管理员simulation额度，尚不是通用可衰减执行Grant，重派与生产认证未实现。

新增9项联通测试，微内核40项：重启后绑定与一次扣费，prepare后撤源/撤Grant，接收方/用途/主体/非合成内容拒绝，数据预算失败原子回滚，过期重启回拨，未知结果结算，继承memory及祖先撤权，错误store/身份域拒绝，以及两个可信时钟不同步时的过期锁存。银行合成表单产品链仍待下一阶段，不把内核协议联通声称为端到端体验已完成。

## runtime联通所需的封闭结构化载荷

新增syntheticInput解析器，在原两个枚举之外仅接受规范编码的固定三字段合成表单（demo客户、模拟账户类别、模拟联系偏好）。Source/Artifact完整字节摘要绑定到Permit，sink再次验证完整对象及摘要。没有任意文本、真实身份信息或模型可执行代码。业务情境与表单编排位于独立runtime子项目，不放入内核；字段白名单是本轮模拟执行器边界，未来真实业务模式需独立评审。
