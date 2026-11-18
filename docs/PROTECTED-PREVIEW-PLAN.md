# 受保护文本预览：下一验收切片

本文件是未实现计划，不是iPhone试用地址或部署证明。独立原型TLS测试3/3仅接假上游。用户试用快照与既有GitHub认证交接不变；禁止直接公开现有单demo-owner loopback服务。

## 最小范围

1. 客户端保留本地实验传输；预览模式固定页面自身HTTPS origin，不接收任意URL。Scene API与听觉生成必须共用受保护传输，内存CSRF，禁止跨源/重定向。401或退出不代表先前mutation回滚，保留命令ID供查询，不自动重发。
2. 保护门逐项列举新增usage/interaction端点，不开放通配scene路径。先接实际使用的文本生成会话读写链；授予权限的其他入口单独评审。
3. 逐路由字节上限与真实上游一致，interaction-edit为128KiB而usage保持4096；严格UTF-8，不得由代理替换非法字节后再提交。测试中文、转义字符、分块超限、错误编码与未知路由。
4. 本地真实TLS→保护门→createSceneServer验证：未登录/错误Origin/CSRF拒绝；已登录读取空历史；显式选择及原command查询；读取/编辑/明确保存生成表单。不得因此计入模型、手机或真实银行验证。
5. 登录页邀请只POST，不进URL/日志/浏览器持久存储。HttpOnly/Secure/SameSite、精确Host/Origin、直接TLS及禁止forwarded authority不放宽。

## 后续独立关卡

- Flutter本地构建资产清单、MIME、CanvasKit/Wasm/CSP、禁止外部CDN与离线私有缓存。不能直接通配CSP或绕过证书警告。
- 明确每个操作超时、取消、断开与结果未知语义，不能无限加时。
- Safari麦克风采样格式、播放手势、相机方向、权限撤回/后台/锁屏需真机验证。文本可用不等于感官可用；采集/上传必须明确告知，不能称数据只留手机。
- 合法HTTPS托管和身份路径仍待核验。当前Sites Worker并非现有Node SQLite/本地ASR/GGUF的直接托管环境；没有Mac/iOS签名环境，不声称TestFlight或安装包。

## 完成标准

先交付本地受保护文本链的可复验测试，逐条列出未运行阶段；不改变用户会话、不开放公网、不操作现有GitHub认证交接。发布前另外核验实际URL、身份恢复、资源请求与端到端客户端行为。
