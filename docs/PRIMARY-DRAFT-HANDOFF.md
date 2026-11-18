# 主生物协调工作生物：合成草稿字段副本回传

## 切片目的与非目标

从“切换到另一个生物”前进到“主生物明确委托工作生物，并取得有来源的结果”。
最小切片只回传一个具体版本的三个合成字段：customerAlias、accountType、contactPreference。
工作生物使用无历史的deterministic.concat受控环境，原样产生授权字段副本。
它证明授权委托、上下文隔离和结果交付，不证明模型理解、智能审核、推荐或业务执行。
不更改业务草稿，不调用真实银行，不产生外部交易，也不消费银行执行Permit。

这是同一可信宿主内的不同HostIdentity，不是已部署的独立模型Agent或进程沙箱。
当前HTTP仍为单demo owner，不是生产多用户认证。真实LLM、跨机委托和第三方插件不在范围内。

## 不可省略的授权

主生物designation不是所有者或管理员身份。明确确认前仅准备冻结计划，不签发能力。
计划冻结owner、原primary/work主体、Registry版本、scene版本、任务ID/版本、字段内容与摘要、
固定期限和所有阶段ID。主关系变化不能把旧结果重新指向新主生物。

明确确认后，由可信宿主按这份合成许可签发：

1. owner控制的唯一source，只允许draft-return目的和原primary/worker两个接收者。
2. 根Grant交给primary，maxDepth=1；primary衰减出worker子Grant，maxDepth=0。
3. 子Grant只有同一source和read/derive/disclose；3 calls分别用于context、run、delivery。
   字节预算按实际UTF-8内容三次收费，不因重试、重启或更换主生物增加。
4. worker的Context只有这份字段副本，stateRefs为空，不夹带来源生物私有历史或媒体。

只读、派生、披露三者不是一个默认权限。source与Grant的接收者交集必须允许目标；
任意替换recipient或purpose不能利用已有artifact取得正文。

## 为什么要本机收件箱

已有 `ControlledContextLab.disclose` 首次返回正文，但命令重放只给历史ack。
不能在它返回后才另存接收状态，否则提交成功后崩溃会留下“预算已扣，接收方没有副本”。

`LocalArtifactMailbox` 是运行层内部的同库broker，不扩展微内核通用协议。
它在一个SnapshotStore.command事务内调用受控上下文的permitInputIn(charge:true)，
同时保存recipient副本、索引与无正文回执。崩溃只能观察到两者都成功或都未成功。
微内核的唯一披露检查、源/授权期限、来源闭包和预算仍参与此路径，没有直接读取artifact正文绕过策略。

回执 `fact:local_recipient_copy_saved` 只证明这个本机副本已保存，不证明用户看过、模型理解过或业务办理过。
同一命令重放只返回这个事实，不发送第二份正文、不重复扣预算。

## 读取与身份边界

- inspect/list只向冻结recipient返回交付事实，永不包含正文。
- read先验证真实recipient handle，再刷新来源/授权过期状态，完整复核artifact、context、purpose、recipient。
  已经交付的本地副本重读不视作新发送，所以不再次消费disclosure budget。
- 宿主从不可变收件记录里的sender重建内部身份，仅用于验证固定artifact；不会把该handle交给recipient。
- owner管理source不代表owner就是primary。HTTP界面只能显示原本owner自己的输入预览与“已回传副本”事实，
  不把owner假扮成primary去读邮箱正文。未来用户侧结果投影需独立明确授权设计。
- sender会话handle退出/撤销不是数据撤权。真正撤回后续正文访问须撤销source或Grant。
  receiver旧会话handle撤销则立即不能读取；重新认证也仍受同一数据Grant约束。
- 撤权、过期后历史回执保留，正文读取失败。不可宣称已经抹去接收者之前看过的内容。
  不可变历史快照仍可能持有字节；逻辑期限不是物理安全擦除承诺。

## 外层编排恢复契约

prepare按冻结关系去重，不因网络重试重建期限或预算。每owner最多32个计划；邮箱每recipient最多64次交付。
确认分阶段执行固定source/root/child/context/run/delivery命令。阶段之间中断后只恢复原参数，
不能用新请求ID绕开已消费预算。

未交付时若任务、情境、注册关系或期限失效，应先持久锁存invalidating终止意图，续撤本交接根Grant，
再进入blocked/expired/cancelled；重启不得复活。已投递则以邮箱历史回执为事实优先级，
即使外围阶段状态尚未写完也不能重新派发或谎称取消成功。

列表走独立接口，不把完整任务账本塞进Scene聚合快照；历史增长、配额满后的维护不是无限能力。

## 本机收件箱验证

9项限定测试通过：明确衰减委托、收件主体隔离、错误actor/recipient/purpose、
原始私有source不进入worker Context、重复读取/重放不多扣、source与Grant撤权、期限回拨锁存、
事务中预算已扣但后续写失败时整体回滚、会话handle与数据撤权区别。
包含真实子进程在mail写入事务提交前及提交后SIGKILL，两种恢复都只产生一份副本且最终只扣3 calls。
SIGKILL不是断电或生产存储保证。

外层Scene/HTTP接入与客户端状态必须按后续验证记录区分，不能仅凭收件箱测试宣称App协调体验已完成。

## Scene / HTTP 已接入的固定流程

`PrimaryDraftHandoff` 与Scene共用单写库。五个POST入口：

- `/scene/handoff-prepare {context}`：必须当前原主生物在前台、不是work，且已有完整draft。
- `/scene/handoff-confirm {handoffId,confirmation:"share-synthetic-draft"}`：明确确认或明确继续同一授权。
- `/scene/handoff-status {handoffId}`：核对，不推进业务阶段。
- `/scene/handoff-cancel {handoffId}`：终止未交付流程并续撤授权；已交付返回真实交付事实。
- `/scene/handoff-list {}`：恢复最多32条本owner精简记录，不推进已确认阶段，不返回邮箱正文。

单计划顶层是 `mode:deterministic-synthetic-draft-return`、`contentReturned:false` 和 `handoff`。
其中values是owner原本的输入预览，不是通过owner代理读取primary邮箱得到的内容。

状态必须区分：prepared真正未确认；首次明确确认先持久写running，再开始source/root/child等阶段。
running表示已确认但完成尚待核对/继续，不保证后台正在执行。状态查询、重启和重复prepare不能偷偷继续它。
终态是delivered、blocked、expired或cancelled；invalidating是必须续撤的持久终止意图。

同一完整binding的prepare去重并复用原期限，不把过期/取消记录刷新为新许可。
当前若要重新准备，须真实更新草稿版本或情境，仍须重新明确确认；不提供自动续租。

固定阶段的恢复已实测：confirmed、source、root、child、context、run、mail、termination-intent、
root-revoked九个边界真实SIGKILL。原ID/期限/预算不变；邮件回执优先，不重复派发。
语音路线直接提交场景的分支也会续撤待交接授权；清理中断不会改写已经完成的路线事实。

新委托的主体映射是owner+creature稳定hash，与旧账户PermitLab的demo-work fixture actor分开。
两者不能混用资源、用途或权限。这是显式迁移边界，不等于已完成全运行时统一身份迁移。

本轮后端全量256项：248通过、8个可选真实集成默认跳过；交接专项27/27含上述9个SIGKILL。
正文读取只存在运行层内部，HTTP没有handoff-read入口。

## Flutter 交接面板验收（首页改版前的功能基线）

按需面板先读取交接列表，不自动准备/确认；原字段预览与明确授权分开。
结果不称业务成功，只称字段副本已回传。未知响应、离开、后台与较新页面均保持原ID核对，
不自动重派或建立替代ID；切换历史ID失败时不会把旧控制绑定到新ID。
查询running不执行，继续已确认交接仍是一次明确的同ID操作。

此功能基线Flutter全量182通过、2个可选live默认跳过；handoff专项11/11；analyze无问题；
Web release成功。另显式执行真实Dart客户端→Node HTTP 1/1通过：root之后注入中断、
查询running、明确继续同ID、交付回执重放不变、已交付取消仍保留事实，以及新版本计划可明确取消。

用户随后明确要求默认首页仅有拟人替身动画、没有任何常驻按钮。交接逻辑保留为按需面板，
不能把本节基线中的历史菜单/入口按钮当作最终默认首页要求。首页改版需另行验证与真实截图。
