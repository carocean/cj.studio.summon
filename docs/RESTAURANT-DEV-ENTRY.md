# 默认关闭的本地餐厅开发入口

此版本继承先前的离线语音与模型联调，失败及适用边界见下文。此切片不是生产服务、手机交付或真实麦克风接入；没有部署、远程访问、证书信任安装或认证设置变更。

## 入口与权限

普通构建不变。只有编译时同时明确设置 `SUMMON_PROTECTED_PREVIEW=true` 和 `SUMMON_RESTAURANT_DEV=true`，且使用已认证的受保护传输、有效宿主固定目标，才允许主替身长按。长按只打开临时开发说明，选择“查看宿主已准备的餐厅请求（开发）”只读取请求，不代表录音或同意模型提案。

宿主固定目标是 `meal / companion / sceneRevision 1`，不是URL、网页或模型提供的权限。客户端重新读取当前场景并检查授权代次、前后台、目标与场景；重复打开被拒绝。后端再次校验会话、CSRF、当前上下文及一次性确认凭据。只有明确点击“展开说明”后才提交同菜详情；模型不能替用户确认。切换需求收起界面但保留已提交状态。

页面注明“合成输入 / 受控播放器 / 不会录音”。`controlled` 模式的 ASR 和模型都是测试替身，不是实际语音理解；`real` 模式才调用已有离线 TTS/Vosk/本地模型，但播放器仍受控、输入仍为固定合成语音。

## 本地可复验构建

先按 `app/README.md` 准备已批准的 Flutter SDK 与依赖。在仓库根目录执行（示例输出目录必须不存在）：

```sh
cd app
flutter --no-version-check build web --release --no-pub \
  --no-web-resources-cdn --no-wasm-dry-run \
  --dart-define=SUMMON_PROTECTED_PREVIEW=true \
  --dart-define=SUMMON_RESTAURANT_DEV=true \
  --output /tmp/summon-restaurant-web
cd ..
node app/tool/prepare_preview.mjs --ack-preview-build \
  /tmp/summon-restaurant-web /tmp/summon-restaurant-prepared
```

打包结果保持 `deployable:false`。启动器显式使用已有严格 nonce 渲染配置，并不证明浏览器/Safari已验证。产物检查或Flutter widget集成不能替代真正Web引擎运行。

## 仅本机启动

启动器必须显式开启，固定监听 `127.0.0.1`。没有host参数、公开隧道或自动安装证书；邀请值从私密文件读取，不放URL、构建包或日志。TLS密钥/证书和邀请文件由已授权宿主提供。没有合适证书时不要自行关闭TLS验证。

```sh
RESTAURANT_PREVIEW=1 RESTAURANT_MODE=controlled \
RESTAURANT_SITE=/tmp/summon-restaurant-prepared/site \
RESTAURANT_TLS_KEY=/absolute/path/to/local-key.pem \
RESTAURANT_TLS_CERT=/absolute/path/to/local-cert.pem \
RESTAURANT_INVITATION_FILE=/absolute/path/to/private-invitation \
node app/tool/restaurant_preview.mjs
```

邀请文件需要仅所有者可读写（例如0600），内容为43至128字符的随机base64url值。启动器不会生成或泄露真实邀请。测试使用临时证书，仅在独立测试客户端加载该证书，不改系统信任。

启动日志只给loopback origin和非敏感边界。已有受信本机浏览器可打开该origin，以邀请登录；长按替身，查看开发请求，再明确展开说明。待确认请求有既有短时效；过期不能强行确认，重新启动会建立新的临时会话。SIGINT/SIGTERM清理本轮临时数据库，不影响原项目数据。

后端仅允许固定只读场景/餐厅读取及既有确认/失效流程，不提供客户端录音注入、宿主stop、普通dish-command或任意场景变更。它不是面向互联网的多用户服务。

### 实际离线软件链选项

将 `RESTAURANT_MODE=real`，并按 `DISH-REAL-UI-INTEGRATION.md` 配置已有 `VOICE_PYTHON`、`VOICE_MODEL_DIR`、`SENSE_PYTHON`、`SENSE_ASR_ENGINE=vosk`、`SENSE_VOSK_LANGUAGE=zh`、`SENSE_VOSK_MODEL`、`DISH_LLM_ENDPOINT`、`DISH_LLM_MODEL`。模型端点仍受现有适配器localhost约束；启动器不会下载模型、安装软件或启动远程模型。模型服务需在启动前就绪。

这只是同一固定合成问题的可重复入口。仍保留之前否定表达的严格失败与ASR错词证据，不以本轮一个通过例子提升语义质量结论。

## 交付限制

- 没有iPhone可达的已授权私有HTTPS后端。
- Linux环境不能生成签名iOS安装包，未验证Mac/Xcode或Apple签名权限。
- 未进行真实设备、摄像头、麦克风、真实播放器、全双工或Safari验证。
- 不能把云电脑127.0.0.1发给手机当可用地址。

本轮测试与构建结果见文末记录；没有部署。

## 复验命令与结果解释

```sh
# 仓库根目录，后端完整回归
node --test server/test/*.test.js microkernel/test/*.test.js runtime/test/*.test.js app/tool/*_test.mjs
# 实际prepare产物经TLS交付与明确确认；不是浏览器渲染测试
RESTAURANT_TEST_SITE=/tmp/summon-restaurant-prepared/site \
  node --test app/tool/restaurant_preview_test.mjs
cd app
flutter --no-version-check analyze --no-pub
flutter --no-version-check test --no-pub --concurrency=1
# 缺少protected开关时仍不可进入
flutter --no-version-check test --no-pub --concurrency=1 \
  --dart-define=SUMMON_RESTAURANT_DEV=true \
  test/restaurant_dev_entry_test.dart test/restaurant_dev_entry_live_test.dart
# 双开关：真实本地TLS启动器 + Flutter widget界面 + 明确测试点击
flutter --no-version-check test --no-pub --concurrency=1 \
  --dart-define=SUMMON_PROTECTED_PREVIEW=true \
  --dart-define=SUMMON_RESTAURANT_DEV=true \
  test/restaurant_dev_entry_test.dart test/restaurant_dev_entry_live_test.dart
```

最后一项使用受控ASR/模型/播放器与合成菜单，实际经过本轮启动器、HTTPS、cookie/CSRF、SQLite及Flutter组件；明确确认是测试点击，不是人类验收。测试包含默认关闭、非受保护客户端、未授权、错误场景/会话、重复打开、迟到结果、撤权/后台、新授权notifier替换及移除前旧按钮回调。启动器另测未完成TLS握手、半包HTTP请求的限时关闭，避免SIGTERM卡住。

独立审查发现并修复两个问题：未握手连接可卡住关闭；更换授权对象后旧面板仍监听旧授权。后者第一版同步移除路由触发Flutter构建期异常，实际失败记录保留；最终使用同步失效的路由授权代理和帧后移除，增强测试在旧按钮仍挂载时触发回调，验证不能提交。

本轮初始出现`/tmp`空间不足；并发编译期间另有编译器意外退出/人工中断（退出根因未单独确证），未计为通过；随后把隔离副本放到工作盘并串行复验。未通过修改业务规则来隐藏失败。

### 最终本地验证记录

- `flutter analyze --no-pub`：无问题。
- 双开关入口与本轮启动器TLS联调：14通过、1跳过，0失败。
- 仅餐厅开关、缺少protected开关：2通过、13按开关跳过，0失败。
- 默认无开关完整Flutter回归：400通过、18明确跳过，0失败。真实模型测试仍为opt-in，不能把跳过视为模型通过。
- 独立只读审查完成，已修复问题由增强实际测试复验；没有未闭合P2。

- 双开关Web release：37.1秒成功；第一次含Wasm dry run的构建失败（dry run退出247、dart2js失败），根因未确证。最终按工具建议禁用非交付目标dry run，不改变CanvasKit/dart2js交付目标。
- 此官方配置产出单个精确CanvasKit目标，打包器原先只接受末尾额外空对象，因而先拒绝`build_config_target`。现只兼容“精确一个目标”或原有“精确目标+空对象”，正反例16/16通过，不接受其他目标、路径或字段。
- 最终prepare产物17个文件、28,660,967字节，仍`deployable:false`；审计SHA256为`47b7ea9b20e8b4605758577eea6d55909056f74b6d129d95541bc337011e7416`。
- 实际release资源的本机TLS启动器测试2/2通过：未登录不能读JS，登录后JS字节与构建产物一致；缺CSRF不能确认，显式确认后同菜详情、重放拒绝及logout后拒绝均通过。没有实际浏览器CanvasKit渲染验证。
- 无任何开发开关的默认Web release：38.4秒成功；产物不包含`restaurant-dev-avatar`或`restaurant-dev-open`标记，双开关产物包含。结合默认组件测试确认没有开发手势/菜单，不将字符串检查单独视作完整UI验收。
- 最终完整Node回归：492项，478通过、14明确跳过、0失败。不是把可选真实ASR/模型跳过记为通过。
