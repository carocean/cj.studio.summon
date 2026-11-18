# Permit 实验下一切片

状态：实现计划；当前 boundary lab 0.2 **尚未实现**下列协议。遵循四份 ADR，不扩展真实业务执行。

## 目标与最小边界

对生成式系统而言，生成场景提案不等于获准发送/执行。下一切片证明：一个持久活动只能有一个有效执行尝试；提案、输入、上下文、接收者不可在批准后替换；消费与重放不会赋予第二次发送权；取消意图和业务事实分别保存。产品锚点见 [系统验收](GENERATIVE-SYSTEM-ACCEPTANCE.md)。

只实现可信宿主内的固定模拟服务与独立 SQLite sink。无网络、无外部模型、无任意执行回调；暂不把它接旧 server 的实际服务。Grant 的 read/derive/disclose 不自动升级为 execute。新增执行授权必须有独立受审核的模式、资源控制者和预算规则，不靠改 operations 白名单就声称完整。

## 持久记录

- AuthorityDomain：可信宿主首次创建并持久保存；重启沿用，不由请求自报。
- ServiceManifest：管理方注册的固定 `simulated.record.v1`，含输入/输出模式摘要、允许效果 `simulation-only`、执行器及回执签发者身份、成功判据。禁止动态 endpoint 或回调。
- Activity：controller、purpose、effectId、intentStatus、activeAttemptId、nextFence。effectId在安全重派时不变，不复用到不同内容。
- Attempt：activityId、executor、fence、完整不可变绑定和预算保留、dispatchStatus。
- Permit：attemptId、manifestDigest、inputDigest、contextDigest、effectDigest、recipient、Grant/Source世代、期限、状态 issued/consumed/invalidated。不能只绑定可变资源 ID。
- Outbox：消费事实及相同绑定；不作为通用队列自动重发。
- Receipt：可信接收端身份、domain/activity/attempt/effect/fence及摘要、证据等级与事实；和取消意图分离。

任何私密原文不出现在普通 command ack；只返回引用。不可把任意调用者提交的 contextDigest 当作环境构造上下文的证明。

## 原子边界与命令

1. `createActivity`：身份与执行Grant范围校验；固定controller/effectId/purpose。初期仅管理员配置模拟执行授权，不承诺生产用户认证。
2. `prepare`：检查expectedRevision、无active slot、意图仍有效；从可信存储构造绑定，验证所有依赖/世代，原子保留预算、创建Attempt+issued Permit、占slot。清单及输入快照不可变。
3. `dispatch`：只能由固定broker调用，不向Agent提供可发送函数。紧邻消费重新验证全部边界；同事务 issued→consumed+Outbox+dispatch_recorded。事务提交前绝不能触达sink。
4. broker在本次首次成功消费后，使用内部一次性资格同步调用固定sink。重放ack、另一个commandId、重启后的旧outbox均无该资格。不得把“replayed:false”视为可传给任意调用者的权力。
5. sink独立事务：验证固定宿主身份、作用域、fence、摘要和接收者，再按(domain,effectId)去重；相同效果不同内容冲突。同活动旧fence拒绝；不同活动不能共享effectId绕过归属。仅落模拟记录。
6. `reconcile`：受保护的只读查询，结果来自固定sink，不信用户/模型自报。更新观测事实；不重新执行效果。查询授权与普通业务执行权限区分，避免撤权后无法核对本方已发生事实，也不能借核对读取他人结果。
7. `cancel`：取消未消费许可/slot；消费后只登记cancel_requested，不自动退款、抹事实或补偿。

预算先保留；未消费取消可释放一次，消费后未知保持保留。现有Grant预算实验是保守只扣不退，接入前需增加明确 reserve/settle/release 账项和幂等性，不能以剩余额度推断是否派发过。首轮不自动重派；安全重派与跨活动资源互斥留下一独立切片。

## 崩溃、并发与回执验收

| 断点/反例 | 期望 |
|---|---|
| prepare事务中崩溃 | 无半占slot/半预算 |
| prepare后，消费前重启 | issued记录可由授权broker重新核验，不绕过撤权 |
| consume提交前崩溃 | 无sink写入，消费事务回滚 |
| consume提交后、sink前崩溃 | uncertain，不自动发送；查询只报告尚未观察到效果，不能证明永不会迟到 |
| sink提交后、回执前崩溃 | uncertain→受控查询后observation_confirmed；效果只一份 |
| 完整完成后同commandId重放 | 仅历史ack，不再发送、不再扣费 |
| 两次prepare/两个消费者 | 单slot、单消费，另一请求拒绝或仅历史ack |
| 修改输入/清单/接收者/来源世代 | 拒绝；没有可变引用穿透 |
| 取消后收到真实迟到事实 | 取消意图仍在，事实保留；不虚报未执行 |
| accepted回执/伪造issuer | accepted非完成；伪造不能升格可信事实 |

这些测试使用真实子进程崩溃和独立sink数据库，但模拟服务不能证明真实商户幂等，也不能证明生产沙箱、分布式一致性或真机体验。
