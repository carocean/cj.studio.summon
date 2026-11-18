# 临时交互程序：纯编译切片

## 做了什么

`runtime/src/interaction-program.js` 是与 Flutter、设备和传输解耦的纯函数模块。它接受结构化提议，生成不可变编译声明与本地草稿对象；不访问网络/磁盘，不调用模型，不授予权限或真正保存数据。

第一种表达是可选临时表单：字段标题、数量、排列、ID、类型和选项由提议决定，不按“笔记”等词挑固定页面。当前类型限 text / multiline / choice；模型可提出的唯一原语元数据是 `local-draft.save`，但仅编译不会执行它。平时无界面、语音交互、未来硬件与宠物形态仍是产品目标，不由此首种表达限制。

## 契约和演进

- `compileInteractionProgram(proposal)`：闭合schema、有限大小与字段边界；拒绝可执行代码/未知动作属性、外部原语、默认填值。返回版本和摘要，`authorityGranted:false`、`semanticsVerified:false`。
- `createInteractionDraft(program)`：创建全部值为null的未保存草稿对象。
- `validateInteractionDraft(program,draft,{requireComplete})`：检查值与字段一致、长度/选项/必填约束。编译或草稿摘要不是签名，不能证明来源或权限。
- `updateInteractionDraft(program,draft,request)`：独立的宿主/用户编辑输入，严格绑定programDigest与draftRevision，不接受模型直接填充真实用户值。
- `reviseInteractionProgram(program,draft,proposal,request)`：完整新声明，不是任意可执行patch语言；以稳定ID保留已有值，新字段为空。重版绑定旧程序摘要和草稿版本；已填字段删除、类型改变、约束不兼容或碰撞均拒绝。显式字段迁移映射由宿主提供，提议本身不能批准数据迁移。

标签等字符串仅是字面内容，不是HTML、URL动作或脚本。未来渲染器不得把它们自动转成链接/动作。字段显示语义可能改变，即使摘要或ID校验通过，也不能证明模型理解正确或数据迁移语义正确，仍需产品层向用户呈现变更与允许其修正。

## 尚未完成的连接

后续独立宿主模块已落地（见下文），但当前仍没有Scene引用、HTTP适配、Flutter新渲染器或用户请求的端到端笔记闭环。现有choice-form不能替代本契约。未来需独立会话存储（不把完整程序塞进接近上限的Scene状态），绑定所有者/生物/情境/来源/期限和版本；提交时原子重新核验。

模型外层还需明确 `clarify` / `none` / 不呈现的结果，而不是强迫每句生成表单。隔离评测中的包裹协议只是研究协议，不自动成为主链接口。只有通过真实推理、语义审查和受控执行验证后，才能分别说明模型生成、可操作界面与保存链的完成程度。

## 本轮验证

纯编译器独立13/13通过，包括控制字符与Unicode长度、恶意对象、摘要/版本篡改、选项/类型/标签变更与精确值保留。全仓已跟踪Node测试（含独立loopback探针）276项：268通过、8项可选真实依赖跳过、0失败。未跟踪的外部预览工作不混入此统计。编译器提交 `4e65bd9`。此结果不包含真实模型语义质量、Flutter新表单、设备采集或数据库保存验收。

独立复核另枚举575种三字段到四候选字段的子集/迁移组合：48接受、527拒绝；接受结果保留各原值恰好一次，无丢失/复制/覆盖。另查孤立surrogate、Unicode scalar计数及嵌套额外键，未发现P1/P2。重算摘要不能构成授权：未来宿主必须读取自己持久会话中的当前声明，不能相信客户端自报digest。

## 持久本机笔记宿主（6d8771f）

`InteractionSession`将编译器接到真实SQLite，但不调用模型或外部业务。create/read/edit/revise/close/save/query/readSaved均在受信本机宿主边界使用：通过HostIdentity认证owner，使用数据库里的当前program/draft并用会话revision做CAS，不能以客户端重算的摘要取得授权。来源metadata只是宿主描述，不证明推理发生。

保存要求明确`save-local-draft`确认，笔记快照、命令结果与回执同事务写入。相同commandId及相同输入返回原ack，不重复保存；改输入重放拒绝。close只关闭呈现，不删除已保存笔记。owner仍可查询历史命令及读自己的已保存笔记，query不恢复编辑或重派工作。

过期和情境失效在活动读取/新变更时观察并持久锁存，不会因之后时钟回拨而复活；没有后台sweep，宿主必须提供单调sceneRevision来暴露未被观察的情境ABA。实验容量为累计每owner16会话/64保存/1024命令，每会话32次草稿变更，当前没有清理回收。

独立session12/12通过，含提交前异常回滚、真正子进程SIGKILL提交前/后恢复、owner隔离与关闭/过期后的历史回执。连compiler为25/25。此处“真实保存”仅指本机临时数据库验收，不是用户真实笔记已被创建、远端同步或手机端可用了。

提交后全仓已跟踪Node复跑288项：280通过、8项可选集成跳过、0失败。模型研究推理与Flutter媒体字幕另行验收。

独立QA发现并修复宿主回调中撤销身份的边界（e9785c0）：create的context/clock回调可能在事务初次验证之后撤销身份，旧代码仍可提交会话。现apply后提交前重新认证，observe回调后也先认证才写失效锁存。六项回归覆盖create/read/save，无跨owner泄露且模块尚未接用户链。修复后编译+会话31/31，全仓已跟踪Node294项：286通过、8可选跳过、0失败。

## 同域HTTP接线（c7c2a4c / 56dca68）

SceneLab已在同一store/identity域持有InteractionSession。可信宿主可create/revise；HTTP不接受客户端程序安装，仅提供read/edit/save/query/close/saved。独立GET `/scene/interaction-current`从create同事务索引的最后会话派生ref或null，不扩大原Scene聚合；旧create重放不会复活旧引用。

编辑请求上限128KiB是传输JSON转义预算，实际草稿仍受编译器16KiB与字段长度限制。所有HTTP请求严格UTF-8，中文/emoji跨分块保值，非法字节及BOM返回invalid_json且不写入。仍为固定owner的loopback实验，`X-Summon-Lab`不是认证，不能直接公开部署。

新增4项真实HTTP/持久化测试；连精简IR新增8项后，全仓已跟踪Node306项：298通过、8可选跳过。Flutter通用渲染与真实听觉到模型协调正在独立接线，不能把这些后端测试当成用户已能在手机完成笔记。

## 模型字段IR与内部程序分离（d49e72c）

模型仅提出form(title,fields)、clarify(question)、none(reason)。字段key原样映射ID，text/multiline由宿主固定2000/4000字符上限，choice的原字符串精确映射value/label；schema及local-draft.save常量由宿主补充，不要求模型生成权限，也不授予保存。严格拒绝多余/缺失/重复属性、未知类型和非法值，不修JSON、不抽代码块、不按标签猜类型，不重解释旧失败。

研究提示与生产/用户请求提示必须区别：研究runner明确是合成资料，不能不加说明地用于真实用户媒体。首4个冻结合成请求在真实本机4B推理中4/4符合预期，其中两个form通过生产编译器；没有保存或执行。完整冻结20项首次运行中断，仅前10项有记录：结构10/10、精确语义9/10（reorder失败）；65e3055保留原始结果，后10项另以显式continuation运行，不覆盖旧失败，小样本不证明通用理解。


## 通用Flutter与显式听觉生成（110899d / cc2b195）

Flutter按程序原字段顺序呈现text/multiline/choice，保存需显式动作；原页面有未保存内容时先阻止替换，不声称已实现任意层无缝切换。未知结果仅查询原command，过期/变场景后的本地副本仅可读，不恢复旧权限。该提交作者验收Flutter232/232、analyze与Web构建通过，真实Dart→Node测试是宿主fixture程序，不是模型语义或真机媒体验收。

新增LocalInteractionPlanner仅显式连接本机127.0.0.1，默认不启动/接入模型。听觉生成路由只接受实际ASR事件ID与当前context，不接受客户端文本/程序；配置后保留单条短时转写，模型前后重验授权/TTL/轮次，仅创建空草稿，不自动保存。开始生成即撤销旧规则回复音频缓存，新生成响应尚无语音。生产提示与研究提示不同，研究成绩不能直接宣称生产理解能力。

全仓已跟踪Node最终325项：317通过、8可选跳过、0失败。听觉桥独立12/12覆盖断连、TTL、撤权、预取消、新轮次及在途旧语音拦截，无P1/P2。仍是本地单owner实验；未公开部署、未推送、未验证用户手机摄像头/麦克风。
