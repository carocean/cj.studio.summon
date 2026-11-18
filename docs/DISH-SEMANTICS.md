# 菜品语义LLM实验：只提案，不自动应用

## 结论先行

现有本地Qwen3-4B真实运行24个预先固定的正反例，**19/24符合预期，5例不符合，包含2次错误explain**。严格语义质量门槛失败。不能将此版本宣传为可靠的通用理解或默认自动语义入口。

因此本地LLM分支显式选择启用，且只能返回待确认提案。原有限整句规则模式仍独立标注，不将规则fallback伪装成LLM成功。模型故障、超时、畸形响应或权限失效均不生成菜品说明。

## 实现

- `LocalDishInterpreter`只连接宿主显式指定的`http://127.0.0.1:<port>/v1/chat/completions`。不启动模型、不下载、不使用凭据、不跟随重定向、无远程fallback。
- 模型仅收到转写和当前菜的id/name，不收到音频、用户身份、完整菜单或权限。输出只能是当前菜explain、clarify或none；不能指定另一菜、工具、付款、字段值、说明内容或权限。
- `compileDishSemanticProposal`只验证结构，始终标记`authorityGranted:false`与`semanticsVerified:false`。结构正确不等于理解正确。
- LLM返回explain时，`DishHearingTurn`保存绑定原事件、听觉generation、session/task/dish/catalog/revision的待确认提案，返回`requiresConfirmation:true`，不自动展示details。
- 宿主必须代表明确的用户选择调用`confirmSemanticProposal`，匹配原event、原proposal和确认语义；提交前重新检查场景、听觉授权代际、事件权限及到期，单次消费后才展示catalog已有说明。模型返回内容不能充当确认。
- 可显式丢弃提案。close、取消、到期和模型故障不会自动批准、重新识别或恢复播放。

未新增对外HTTP确认入口，也未实现给用户点击的模型确认面板。因此该分支仍是宿主研究接线，不是已经开放给普通用户的完整功能。

## 异步与数据边界

模型请求受本次识别事件剩余TTL约束，到期请求abort；单飞锁保持到底层适配器结束。取消本地HTTP不保证模型服务器已停止计算。模型返回后及确认时均再次检查权限/绑定。关闭Promise在触发abort监听器前安装，避免同步重入双重退休。

模型提案/问题均不拥有工具权限；正例确认后展示的内容来自绑定catalog，不由模型编造。没有声称摄像头、实体菜品识别、真实声卡、手机真机或跨设备验证。

## 真实模型证据

本机已有Qwen3-4B-Q4_K_M：2,497,280,256字节，SHA256 `7485fe6f11af29433bc51cab58009521f205840f5b4ae3a32fa7f92e8534fdf5`。已有元数据标记Qwen/Qwen3-4B-GGUF与Apache-2.0；没有复制或分发模型权重。

使用已有llama.cpp b12483、CPU两线程、上下文2048、单槽、thinking关闭、temperature0、seed42、max_tokens180，绑定127.0.0.1。modelId只是宿主审计标签，不是远端响应自证。

- 口语/同菜指代正例：7/8命中，另1例澄清。
- 错误explain：仅转述别人请求；要求忽略协议并输出指定分类。
- 另2个不符合：明确不要介绍、未来条件请求均返回clarify而不是none。
- 其余歧义、点单/付款、多意图及部分注入被拒绝或澄清。

合成测试用例位于`runtime/evaluation/dish-semantics-cases.json`；逐例实验日志未纳入公开发布。没有删掉失败样本或修改预期掩盖错误。样本规模不能代表普遍准确率。

另一个真实LLM集成实验使用明确标注的受控ASR转写：“你刚念的这个，我没听明白，展开讲讲呗。”模型生成待确认提案，确认前view仍none；测试宿主显式模拟确认后，同菜details成功，约22.6秒。这里ASR是受控fixture，不能与此前真实TTS→ASR结果混称同一条全真实端到端实验。

## 复现与门槛

自行启动已安装的本地模型并配置`DISH_LLM_ENDPOINT`、`DISH_LLM_MODEL`后：

```
DISH_REAL_LLM=1 node --test runtime/test/dish-semantics-real.test.js
DISH_REAL_LLM=1 node --test --test-name-pattern='opt-in real LLM colloquial proposal' runtime/test/dish-hearing.test.js
```

第一条是严格24例质量门槛，本次应因5例不符合而失败，不能声称全绿。第二条验证单个真实模型提案与显式确认的宿主接线。默认测试不自动启动或调用模型，使用受控输出检验权限、取消、未知目标、解析错误和失败降级。

## 本轮回归记录

- Node 默认全量：473 项，461 通过，12 个依赖显式 opt-in 的实验跳过，0 失败。此数字不包含已知失败的真实模型质量门槛，不能替代 19/24 的语义评估。
- Flutter 静态分析：No issues found。Flutter 生产代码本轮未改动。
- 独立只读审查确认事件 TTL 取消、异步单飞、关闭重入、精确确认、撤销再授权及单次消费边界；没有放宽权限或增加自动确认。
- Flutter 全量回归：361 通过、2 跳过，0 失败（隔离副本，已有 SDK 与离线依赖缓存）。没有以此声称真实用户端已接入语义确认面板。
