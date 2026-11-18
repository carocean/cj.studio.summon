# 纯宿主原始 UTF-8 摘录适配器

`compileUtf8Excerpt(rawBytes, {resourceId, provenance, ranges})` 仅把可信宿主明确选择的
原始字节区间编译为既有 reading resource。无 IO、网络、模型、HTTP、持久化或权限授予。
不修改 reading schema。所有当前测试都是 synthetic，不是《史记》真实导入；此前503
取证失败仍成立。本模块不确认许可证、来源真实性、历史版次或内容正确性。

## 输入

- 普通 Buffer，1..8 MiB，先验大小后复制；拒绝 Proxy、Buffer 子类、SharedArrayBuffer。
  普通 ArrayBuffer 上不同 offset/length 的 Buffer view 可用，只取该 view。
  用 TypedArray 原生 getter 读取内部 length/offset/backing，不执行遮蔽这些属性的 getter；
  复制到独立 Buffer，后续调用者修改原 Buffer 或底层别名不会改变输出。
- 元数据为严格有界 C1 快照；必须精确 `resourceId/provenance/ranges`。
  provenance 沿用 `{kind:'host-declared',referenceId}`，只是声明，不是证据授权。
- ranges 为1..64个 `{blockId,startByte,endByte}`，半开区间；安全整数，非空，在界内，
  顺序递增且不重叠，blockId唯一。允许空隙，不自动排序、猜段落或截断。
- 整个原文件必须为合法 UTF-8，包括未选区域。无编码猜测或替代字符修复。
  文件开头 EF BB BF 记录为 leadingBom，解码仍保留 U+FEFF；要不显示 BOM 必须由
  宿主明确选择从字节3开始。内部 U+FEFF 同样保留。
- 区间不得切断 UTF-8 标量，也不得切在 CR 与紧接 LF 之间（本适配器的明确策略）。
  不推测组合字、ZWJ 或其它 grapheme 边界。
- 不删空格、不换行转换、不简繁转换、不 Unicode normalization、不解析 HTML。
  每段 UTF-8 重新编码必须与原 slice 逐字节相同。

UTF-8校验只证明字节合法，不证明原作者意图：某些其它编码字节可能恰好也是合法UTF-8；
不会声称可可靠识别所有其它编码。选中控制字符及超大段落仍由原 reading validator 拒绝。

## 输出

冻结的 `{resource,evidence}`。resource 使用既有 `compileReadingResource`，因此仍受
48 KiB C1 resource、每段2000标量、总8000标量等限制，无任何自动缩短。
selection/evidence各16 KiB上限，并保留C1本身独立上限。失败不修改原 bytes 或元数据。

Evidence 精确字段：

```
{
  schema: 'utf8-excerpt-evidence.v1',
  rawByteLength, rawSha256, encoding: 'utf-8', leadingBom,
  resourceId, contentDigest, provenance,
  ranges: [{blockId,startByte,endByte,rawSliceSha256}]
}
```

rawSha256/rawSliceSha256是普通字节SHA256，带`sha256:`前缀；contentDigest是既有C1域分离
的reading-content摘要。不同原文件取相同文本可有相同contentDigest但不同rawSha256。
都不是历史版次编号。此适配器不凭空添加取得时间、URL、响应头或许可状态；可信宿主
可在另一个真实取证记录中通过rawSha256绑定这些证据，不能由模型提供URL触发获取。
输出不含原始全文或未选字节。保存输出仍需宿主另行执行权限与隐私策略。

测试：`node --test runtime/test/utf8-excerpt.test.js runtime/test/reading-surface.test.js`
