# 按需文字入口：听觉到生成界面的第一条替代输入链

## 为什么做

用户要求平常面对生物，以听觉、视觉交流；只有说要输入时才出现输入界面。
本轮填补这个具体缺口，不把系统改回聊天框，也不把有限口令称为自由理解。

正常初始 Scene 没有 `textEntry`，Flutter 不显示文本框。两条显式路径：

- 对当前生物说“打开文字输入”（也接受“我要输入”“我要打字”“改用文字”）。
  真实 ASR 的整句识别结果先形成候选，点击确认后才打开输入；OCR 中出现同样文字不触发。
- 不方便说话时点“改用文字”，直接请求当前情境的输入声明。这是可访问性替代，
  不以麦克风许可为前提，不悄悄打开听觉或视觉。

输入后可明确请求“开始工作”“模拟开户”“回到伙伴”等有限场景切换。
“模拟开户”只展开合成字段表单，绝不开户、提交、签约或发送用户资料。
不支持的句子不猜测执行。暂不接受文字路线规划、自由聊天、任意业务或模型调用。

## 协议与边界

`POST /scene/text-entry {context, visible}`：当前 context 的明确开/关请求。
打开后 Scene 才含有：

```json
{"schema":"scene-text-entry.v1","context":{"creatureId":"companion","sceneRevision":2},"maxLength":200,"source":"deterministic-policy"}
```

字段名为 `textEntry`。这只是受限声明，不是脚本/HTML，也不凭 `source` 字符串获得权限。
Flutter 校验声明和当前主体/情境版本；当前 HTTP 服务仍只供单所有者本机演示。

`POST /scene/text-request {context, text, confirmation:"apply-direct-text-scene"}`：
必须当前情境仍有输入入口，最多200个 UTF-16 code units。服务端重新匹配整句有限语法；
拒绝否定、引用、条件、复合指令和额外字段。成功只改变情境/生成模拟表单并返回完整 Scene。
原文不存入 SQLite、感知档案、聊天历史或模型上下文，不向外部服务传输。
允许的有限意图可作为 `direct-user-request` / `direct-text` 元数据记录，不能冒充传感器证据。

显式关闭、情境切换或其他 Scene 修改使入口关闭；旧 context 不能恢复旧草稿。
听觉候选仍受原感知事件有效期、当前生物与听觉授权世代约束，撤权后不能确认。
后台仅可持久保存“入口曾打开”的显示状态，重启可能恢复一个空入口，永远不恢复原文。
Flutter 在后台、离开、情境变化时清空草稿并拒收旧回包。
响应未知时先刷新已保存情境，不自动重发。客户端生命周期防护不是服务器取消协议。

## 真实证据与限制

2026-11-17，使用本机 MeloTTS 生成合成测试语音“打开文字输入”（约1.115秒）；
未经文字替换、纠错或补词，Paraformer 实际返回 **打开文字输入**。
实际 HTTP：声音→候选→显式确认→输入声明→文字“模拟开户”→工作生物和三字段合成表单，1/1通过。
并检查感知临时文件已清理，识别原文没有出现在持久感知文件或核心 SQLite。
这不是用户自然语音准确率、手机麦克风验证或任意语言的生成理解测试。

重现真实集成需本机官方模型和可用 Python（权重不入库）：

```bash
TEXT_ENTRY_REAL=1 TEXT_ENTRY_AUDIO=/absolute/path/to/synthetic-open-text.wav \
SENSE_PYTHON=/absolute/path/to/venv/bin/python SENSE_ASR_ENGINE=paraformer \
SENSE_PARAFORMER_MODEL=/absolute/path/to/paraformer-model \
node --test runtime/test/text-entry-real.test.js
```

没有这些显式输入时，该真实集成默认跳过；普通契约测试不冒充 ASR 实测。

## 本轮客户端与回归验收

- Flutter 全量161通过，1个可选live默认跳过；另设 `SUMMON_SCENE_LIVE=1`
  运行真实 Dart客户端→Node HTTP 联调1/1通过（开入口、否定句拒绝、场景切换、旧context拒绝、关闭）。
- 新增6项客户端测试覆盖默认无文本框、按需生成、未知口令保留可纠正状态、
  重复提交、后台清空与迟到回复、关闭/情境变化、较新导航胜过旧回复。
- Flutter analyze无问题；Web release编译成功（含Wasm dry run），不是手机安装/真机证据。Node全量213项：206通过，7个可选真实集成默认跳过；
  本功能真实ASR测试另行显式通过。独立只读复核未发现P1/P2。
- 不修改当前用户试用的冻结版本；源码提交不是远端发布，也不提供手机安装包。
