# 同设备菜品播报与停止屏障

## 范围

受信本地宿主协调器 `DishNarration` 将绑定菜名的合成、播放启动请求、用户请求停止、宿主确认及同菜说明连接起来。它不是语音识别、真实barge-in、全双工、声卡驱动或跨设备协议。无新增HTTP权限；客户端仍不能提交stopped。

`SceneLab.createDishNarration({synthesizer, player, timeoutMs?})` 是宿主工厂。宿主必须显式安装合成菜单、创建会话后调用 `start({sessionId,dishId,expectedRevision})`。接口只从当前绑定catalog取菜名，不接受任意客户端文本、音频、URL或路径，也不会默默截断长说明。

## 顺序与边界

1. 检查身份/场景/修订和共享播放器空闲，预留speak→interrupt→stopped→details四步容量。
2. 提交speak并绑定session/task/dish/catalog/speechSequence；合成菜名。生成的WAV按既有PCM大小及格式规则验证后才进入播放器。
3. 每次异步等待后核对身份、场景与generation。取消或迟到合成结果不会进入播放器；播放启动成功也只返回`physicalPlaybackVerified:false`，不把软件调用当成真人听见声音的证明。
4. `requestExplanation` 固定当前菜，递增generation并取消合成，提交interrupt。立即请求停止；若play启动还未结束，等待它settle后再执行最终stop。
5. 所有停止屏障成功、绑定仍有效后，仅由宿主admin确认stopped，再切换details。说明来自绑定catalog，不编造未知菜品。

停止失败/超时不确认、不展示、不开始下一播报。超时不会丢弃底层停止Promise；重试仍等待同一未决链，防止迟到stop影响新音频。共享同一个player实例的协调器单飞。不同包装器若偷偷共享同一硬件，仍是受信宿主必须避免的配置错误。

适配器的`stop()`必须仅在本次输出通道及待启动音频确实静止后resolve。协调器不可能校验不诚实驱动的物理行为；测试适配器的确认只代表软件时序。

## 撤权、场景与生命周期

正在异步操作时检测到撤权或场景失效，仍会取消合成并执行安全停止，但不会继续业务确认/呈现。`cancel(admin)`是宿主主动失效钩子；没有声称自动订阅所有系统权限变化。

SceneLab在存在未退休协调器时拒绝场景变更和关闭，要求宿主先`await narrator.close()`。停止不确定则退休失败，不能跳过屏障。此限制是最小安全策略，不是最终的无缝场景切换。直接使用底层类的宿主必须在权限变更、应用退后台、设备断开等事件调用取消/退休钩子。

自然播完、连续菜单自动切下一道、语音起点检测及摄像头推断尚未实现。停止是显式宿主请求，不冒称用户说话即打断。

## 验证

默认测试使用合成PCM和受控播放器，真实HostIdentity/SQLite验证迟到合成、延迟play、失败/超时stop、撤权、场景变化、并发取消、共享通道及容量。可选`DISH_REAL_TTS=1`加已有`VOICE_PYTHON`、`VOICE_MODEL_DIR`运行实际离线中文TTS，仅把真实WAV送入受控播放器，不实际驱动声卡。

Flutter真实TLS验收fixture现通过宿主协调器完成start→请求停止→确认→details，再沿既有保护传输显示同菜说明、插画、放大。其播放器与PCM仍为合成fixture，不能替代真人音频/真机测试。

本轮验证：开启`DISH_REAL_TTS=1`的Node全量450项，442通过、8跳过、0失败，包含17项新协调器测试及实际离线中文TTS。Flutter菜品真实TLS、既有GenerationVoicePlayer和半双工turn-mode共10项全部通过。未修改Flutter生产代码，本轮不重报此前Web构建为新验证。

独立审查推动修复：超时底层stop链必须保留；取消与同步abort/stop回调重入须有generation及预先安装屏障；所有scene-state写入统一退休门槛；重新认证的同principal admin仅可安全退休，不恢复旧业务授权。最终只读复核确认这些窗口闭合。
