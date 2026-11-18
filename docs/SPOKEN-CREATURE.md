# 按名字呼唤自己的生物

## 体验目的

一个用户有多个AI生物，不应只能通过列表选择或硬编码“工作/个人”入口交互。
当前增加有限整句“切换到〈注册名称〉”与“请切换到〈注册名称〉”，让正在听的生物
提出具体的目标实例。确认前显示目标名称和ID；系统不凭音频自动决定切换。

这是前台情境交接，不是跨Agent委托、调用业务、分享会话、改变主生物或授权传感器。
已有任务、草稿和回执保留，当前文字入口收起。目标生物此前听视觉关闭的仍然关闭。
调用一个已登记的商业生物也不会恢复被撤销的订阅或服务许可。

## 唯一名称，不猜身份

在本机demo owner的认证Registry命名空间中精确查找完整名称：

- 唯一命中：`ready`，返回目标实例ID、注册名称和Registry修订。
- 重名：`ambiguous`，不返回任何目标身份，不给确认按钮，用户到伙伴列表按实例选。
- 没有这个完整名字：`unavailable`，不自动创建、订阅、纠错或选择相近名字。

不裁剪名称内部空格，不把复合句中的短名字摘出来，不把否定、引用、条件句当请求。
名称内容仅作为数据。即使一个生物名字像指令，也只是精确查找其ID，不执行名称里的内容。
OCR不能产生此候选；按需文字入口当前也不解析此命名语法，仍是其既有有限场景口令。

## 协议与微内核边界

沿用 `sense` / `sense-confirm`，不加任意目标执行端点。听觉结果的metadata可含：

```json
{"schema":"spoken-creature.v1","status":"ready","registryRevision":7,"targetCreatureId":"named-pet","targetName":"工作伙伴"}
```

字段为 `creatureProposal`；只ready时 `candidate="creature-request"` 且
`status="awaiting_confirmation"`。ambiguous/unavailable没有target ID/name，保持observation。
不存在命名请求时不增加该字段。确认需另带完整 `expectedCreatureProposal`，其余协议不变。

确认是在已有HostIdentity/Registry与SnapshotStore单写域事务上完成：

1. 原感知处理必须成功，来源生物听觉授权及世代仍有效。
2. 事件必须未过期，来源情境版本仍当前，且完整目标声明与服务器保存的完全相同。
3. Registry修订必须未变；新增同名生物、改主生物等任何注册关系修改均保守拒绝旧候选。
4. 同一事务保存前台生物切换与事件已应用状态；重放仅回当前状态，不重新切换。
5. 后台准备回复或合成声音时若Registry改变，丢弃旧候选/语音，不把旧目标作为当前事实。

哈希比对不是客户端签名或生产登录。HTTP仍是单demo owner的loopback实验，不得公开为多用户服务。
没有为目标授Grant、消费业务Permit、触发外部效果或发送源生物的音频/历史给目标。

## 真实音频：有成功，也有识别失败

2026-11-17，官方本机MeloTTS合成两个测试音频，原样交给Paraformer：

| 合成输入 | ASR实际输出 | 结果 |
|---|---|---|
| 切换到工作伙伴 | 细换的工作伙伴 | 不匹配，保持原生物，没有候选 |
| 请切换到工作伙伴。 | 请切换到工作伙伴 | 精确候选，经HTTP确认后切到named-pet |

第二条切换后再查感知能力，目标hearing和vision都保持不可用，primary仍是原伙伴。
两段音频都没有为通过测试而纠错、替换识别结果或扩展误识别别名。完整组合测试1/1通过，
但只有其中一条音频得到可执行候选；这不是自然语音准确率评估，更不是已可替代真机试用。

可选真实集成需显式提供成功与失败的两段合成音频、Python和官方模型：

```bash
SPOKEN_CREATURE_REAL=1 \
SPOKEN_CREATURE_AUDIO=/absolute/path/to/switch-creature-polite.wav \
SPOKEN_CREATURE_REJECT_AUDIO=/absolute/path/to/switch-creature.wav \
SENSE_PYTHON=/absolute/path/to/venv/bin/python SENSE_ASR_ENGINE=paraformer \
SENSE_PARAFORMER_MODEL=/absolute/path/to/paraformer-model \
node --test runtime/test/spoken-creature-real.test.js
```

普通测试使用明确mock处理器验证契约，不冒称音频准确率。后端全量220项：212通过、8个
可选真实集成默认跳过；本功能真实音频组合另行显式通过。独立复核相关30/30，无P1/P2。

## 客户端即时交接

命名呼唤确认成功后，当前感知页若仍是栈顶且可返回，会立即返回生物主场景并刷新实际后端状态，
展示目标生物，而不是留在来源生物的采集页等待用户再点返回。其他感知确认流程不变。
如果确认期间用户已打开较新的页面，迟到响应不能把那一页弹出；独立页面无可返回路由时仅保留成功提示。

新增组件测试验证精确名称/ID展示、完整声明回传、同名/缺名拒绝、OCR/伪造拒绝、迟到处理，
以及真实CreatureHome导航与刷新后显示目标、较新路由不被旧响应pop（呼唤组10/10通过）。
这仍是Flutter组件和本地HTTP验证，不是远程模拟器、手机录音或设备安装测试。

最终客户端验证：Flutter全量171通过、1项既有可选live默认跳过，analyze无问题，
Web release编译成功（含Wasm dry run）。命名呼唤的真实音频/HTTP证据为上文另行执行的组合测试，
不能把客户端mock感知测试称为真机链。未更新用户正在使用的冻结快照，也未发布远端。
