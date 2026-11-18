# 确认后同菜详情与分层真实性联调

## 实际运行的感知/语义/传输实验

使用本机已有离线模型，没有下载模型或将转写发往远端：

1. 真实LocalVoice（sherpa-onnx / vits-melo-tts-zh_en）合成用户测试音频“这是什么菜？”，真实Vosk small-cn-0.22转写为“这 是 什么 菜”，原有限整句模式到同菜details。约6.2秒。此项不包含LLM。
2. 受控ASR转写“你刚念的这个，我没听明白，展开讲讲呗。”交给真实本地Qwen，生成待确认提案，再由测试宿主明确确认进入同菜details。约24.4秒。此项不是真实ASR。
3. 同一次实验中：真实LocalVoice合成音频→真实Vosk转写“这 是 什么 菜”→真实Qwen解释提案→确认前view仍none→实际TLS测试客户端明确发送show→经dish-read读取同菜/task的SQLite details。整项约18.9秒，其中ingest至确认读回约14.75秒。

三项均通过。第三项是新的真实**软件模型**组合证据，不能声称真人说话、真实麦克风、实体扬声器停声或真人点击。narrator的TTS/播放器仍为受控fixture，真实TTS仅用于生成输入录音；明确确认由测试客户端发出。此实验没有Flutter。

本地验证使用固定合成输入；逐例实验日志未纳入公开发布。模型为既有Qwen3-4B-Q4_K_M，使用原始已知仍有失败的语义提示词，未重新采用V2失败候选。单个正例通过不提高此前质量评估结论，显式确认仍必需。

### 可复现配置

本地llama-server启动配置沿用`DISH-SEMANTICS-V2.md`中的CPU/上下文/采样参数；显式加载所记录SHA256权重。测试使用：

```
DISH_REAL_ASR=1 DISH_REAL_LLM=1 DISH_REAL_CHAIN=1
DISH_LLM_ENDPOINT=http://127.0.0.1:18083/v1/chat/completions
DISH_LLM_MODEL=summon-local-qwen3-4b-q4km
VOICE_PYTHON=<已有离线环境Python>
VOICE_MODEL_DIR=<已有vits-melo-tts-zh_en目录>
SENSE_PYTHON=<已有离线环境Python>
SENSE_ASR_ENGINE=vosk
SENSE_VOSK_LANGUAGE=zh
SENSE_VOSK_MODEL=<已有vosk-model-small-cn-0.22目录>
node --test --test-name-pattern='opt-in actual synthesized|opt-in real LLM colloquial|opt-in combined offline' runtime/test/dish-hearing.test.js
```

上述变量须export后再运行命令。本次监督脚本在测试完成后停止并回收模型服务。专用真实组合测试显式使用60秒感知事件TTL，原默认TTL未改，超时仍拒绝；未用延长无限等待换取通过。

Node默认回归485项：472通过、13跳过、0失败。新增真实组合用例默认跳过，必须显式开启；上述3项真实实验另行执行通过，不混入默认全绿数字。独立只读审查确认真实实现串接及受控播放器边界。

## 按需确认后的实际详情显示

`DishConfirmationRemoteSurface`现在要求宿主指定sessionId与切换需求回调。显示确认前读取none+stopped的菜品快照；用户明确show、宿主返回presented后再次通过受保护dish-read读取。仅接受同session/task/dish/catalog/context/播报sequence/name、revision恰好增加1且原description/imageRef不变的details状态，才显示菜名与说明正文。

子确认组件先消费终态，再用onResult通知父组件替换为只读详情，避免卸载仍pending的组件误触失效。未开放generic dish-command；详情中的“切换需求 / 收起”只关闭本地展示并回调宿主，已提交的持久状态仍保留，不宣称撤销、自动导航到新业务或自动授权。默认Home和文本输入方式未改。

读取失败、错误绑定、撤权、后台、session/API替换、切换需求或销毁都会拒绝迟到正文。按需详情使用纯Text，不渲染模型或资源提供的可执行界面定义。

独立的Flutter真实TLS实验使用受控ASR/模型/播放器，验证实际可见菜品正文；不能与前述真实模型实验拼称同一条全真实Flutter/真机链。两条实验共同说明相应软件接口可联通，不代表真实环境感知或通用语义可靠性。

详情阶段验证：37项定向测试通过；Flutter完整重跑398通过、2跳过、0失败；静态分析No issues found。前一次全量因电脑断线中断，不计为通过，恢复后从头完整重跑。独立只读终审核对绑定、终态回调顺序、六类late-read失效及实际可见正文断言，未发现新P1/P2。
