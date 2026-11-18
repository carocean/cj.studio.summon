import 'dart:async';
import 'dart:convert';

import 'package:material_ui/material_ui.dart';
import 'package:http/http.dart' as http;

import 'api.dart';
import 'scene_experiment.dart';
import 'perception_capture.dart';

/// Perception-first shell. Text entry is a bounded generated component, not a
/// permanent conversation affordance. Settings fields are developer setup only.
bool requestsPerceptionText(String text) => RegExp(
  r'^(我要输入|我想输入|文字输入|打开文字输入|请让我输入|iwanttotype|opentextinput)[。.!！]?$',
  caseSensitive: false,
).hasMatch(text.replaceAll(RegExp(r'\s+'), ''));

class PerceptionHome extends StatefulWidget {
  const PerceptionHome({
    super.key,
    this.client,
    this.capture,
    this.developerConsole,
  });
  final http.Client? client;
  final SenseCapture? capture;
  final WidgetBuilder? developerConsole;
  @override
  State<PerceptionHome> createState() => _PerceptionHomeState();
}

class _PerceptionHomeState extends State<PerceptionHome>
    with WidgetsBindingObserver {
  late final http.Client _client;
  late final SenseCapture _capture;
  final _endpoint = TextEditingController(text: 'http://127.0.0.1:8080'),
      _token = TextEditingController();
  final _generatedText = TextEditingController();
  SummonApi? _api;
  List<dynamic> _creatures = [];
  String? _subjectId, _modality, _resultModality;
  CapturedSense? _pending;
  Map<String, dynamic>? _receipt;
  bool _busy = false, _recording = false, _textAuthorized = false;
  bool _dialogueEnabled = false;
  bool get _canConverse =>
      ((_subject?['aibm']?['serviceAbilities'] as List?) ?? []).contains(
        'conversation',
      );
  Map<String, dynamic> _capabilities = {};
  int _epoch = 0;
  Timer? _recordLimit;
  bool _cameraSession = false, _startingCapture = false;
  String _status = '先在设置中连接自己的服务，再明确允许主体使用听觉或视觉。';
  Map<String, dynamic>? get _subject {
    for (final c in _creatures) {
      if (c['id'] == _subjectId) return Map<String, dynamic>.from(c);
    }
    return null;
  }

  bool _available(String modality) =>
      _capabilities[modality]?['available'] == true;
  bool _granted(String modality) =>
      ((_subject?['aibm']['serviceAbilities'] as List?) ?? []).contains(
        'sense.$modality',
      );
  @override
  void initState() {
    super.initState();
    _client = widget.client ?? http.Client();
    _capture = widget.capture ?? PlatformSenseCapture();
    WidgetsBinding.instance.addObserver(this);
  }

  Future<void> _discard() async {
    _epoch++;
    _recordLimit?.cancel();
    _recordLimit = null;
    if (mounted) {
      setState(() {
        _recording = false;
        _pending = null;
        _modality = null;
      });
    }
    try {
      await _capture.cancel();
    } catch (_) {
      /* No automatic restart after platform denial. */
    }
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.inactive &&
        (_cameraSession || _startingCapture)) {
      return;
    }
    if (state != AppLifecycleState.resumed) {
      unawaited(_discard());
    }
  }

  Future<void> _run(Future<void> Function() action) async {
    if (_busy) return;
    setState(() => _busy = true);
    try {
      await action();
    } on ApiFailure catch (e) {
      if (mounted) {
        setState(() {
          _receipt = null;
          _textAuthorized = false;
          _generatedText.clear();
          _status = '处理未完成：${e.code}。没有成功感知回执，请核对主体权限和处理引擎。';
        });
      }
    } catch (_) {
      if (mounted) setState(() => _status = '采集或处理失败。请检查系统权限、设备、服务与处理引擎后重试。');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _settings() async {
    final connect = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('开发连接设置'),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Text('采集内容只在你确认后发送到此服务；不要填写模型密钥。'),
            TextField(
              key: const Key('sense-endpoint'),
              controller: _endpoint,
              decoration: const InputDecoration(labelText: '服务地址'),
            ),
            TextField(
              key: const Key('sense-token'),
              controller: _token,
              obscureText: true,
              decoration: const InputDecoration(labelText: '开发访问令牌'),
            ),
          ],
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('取消'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(context, true),
            child: const Text('连接'),
          ),
        ],
      ),
    );
    if (!mounted || connect != true) return;
    await _run(() async {
      await _discard();
      _api = null;
      setState(() {
        _creatures = [];
        _subjectId = null;
        _receipt = null;
        _textAuthorized = false;
        _generatedText.clear();
      });
      final api = SummonApi(
        endpoint: _endpoint.text,
        token: _token.text,
        client: _client,
      );
      final listing = await api.request('/v1/creatures');
      final capabilities = await api.request(
        '/v1/perceptions/capabilities',
      ); // Missing endpoint is a real block, never a mock fallback.
      if (!mounted) return;
      setState(() {
        _api = api;
        _dialogueEnabled = false;
        _capabilities = capabilities;
        _creatures = listing['creatures'] as List;
        _subjectId = _creatures.isEmpty
            ? null
            : _creatures.first['id'] as String;
        _status = '已连接。能力授权与系统采集权限是两道独立边界。';
      });
    });
  }

  Future<void> _grant(String modality, bool enabled) async {
    await _discard();
    final id = _subjectId;
    await _api!.request(
      '/v1/kernel/mounts',
      body: {
        'subjectId': id,
        'serviceId': 'sense.$modality',
        'enabled': enabled,
      },
    );
    final listing = await _api!.request('/v1/creatures');
    if (mounted) {
      setState(() {
        _creatures = listing['creatures'] as List;
        if (!_creatures.any((c) => c['id'] == _subjectId)) _subjectId = null;
        _receipt = null;
        _textAuthorized = false;
        _generatedText.clear();
        _status = enabled
            ? '已允许此主体处理$modality；仍不会自动采集。'
            : '已撤销感官处理能力，未发送媒体已清除。';
      });
    }
  }

  Future<void> _photo() async {
    if (!_granted('vision') || !_available('vision')) return;
    await _discard();
    final epoch = _epoch;
    if (!mounted) return;
    CapturedSense? media;
    _cameraSession = true;
    try {
      media = await _capture.photograph(context);
    } finally {
      _cameraSession = false;
    }
    if (!mounted || epoch != _epoch || media == null) return;
    if (media.bytes.length > 4 * 1024 * 1024) {
      throw const ApiFailure(413, 'media_too_large');
    }
    setState(() {
      _pending = media;
      _modality = 'vision';
      _receipt = null;
      _textAuthorized = false;
      _generatedText.clear();
      _status = '图像已采集，尚未发送。请确认没有不希望分享的内容。';
    });
  }

  Future<void> _start() async {
    if (!_granted('hearing') || !_available('hearing')) return;
    await _discard();
    final epoch = _epoch;
    _startingCapture = true;
    try {
      await _capture.startHearing();
    } finally {
      _startingCapture = false;
    }
    if (!mounted || epoch != _epoch) {
      await _capture.cancel();
      return;
    }
    setState(() {
      _recording = true;
      _receipt = null;
      _textAuthorized = false;
      _generatedText.clear();
      _status = '正在录音，最长 15 秒。停止后仍需确认发送。';
    });
    _recordLimit = Timer(const Duration(seconds: 14), () {
      if (mounted && !_busy) unawaited(_run(_stop));
    });
  }

  Future<void> _stop() async {
    _recordLimit?.cancel();
    final epoch = _epoch;
    CapturedSense? media;
    try {
      media = await _capture.stopHearing();
    } finally {
      if (mounted) setState(() => _recording = false);
    }
    if (!mounted || epoch != _epoch) return;
    setState(() => _recording = false);
    if (media == null) return;
    if (media.bytes.length > 4 * 1024 * 1024) {
      throw const ApiFailure(413, 'media_too_large');
    }
    setState(() {
      _pending = media;
      _modality = 'hearing';
      _status = '录音已停止，尚未发送。原始媒体仅用于本次处理。';
    });
  }

  Future<void> _send() async {
    final media = _pending, modality = _modality, subjectId = _subjectId;
    if (media == null || modality == null || !_granted(modality)) return;
    final epoch = _epoch;
    // Remove raw media from the visible state immediately; retries require new consent/capture.
    setState(() {
      _pending = null;
      _modality = null;
      _receipt = null;
      _textAuthorized = false;
    });
    final result = await _api!.request(
      '/v1/perceptions',
      body: {
        'creatureId': subjectId,
        'modality': modality,
        if (modality == 'hearing')
          'responseMode': _dialogueEnabled && _canConverse
              ? 'dialogue'
              : 'perception',
        'media': {
          'mimeType': media.mimeType,
          'base64': base64Encode(media.bytes),
        },
      },
    );
    if (!mounted || epoch != _epoch || _subjectId != subjectId) return;
    setState(() {
      _receipt = result;
      _resultModality = modality;
      final text = result['result']?['text'];
      _textAuthorized =
          modality == 'hearing' &&
          text is String &&
          requestsPerceptionText(text) &&
          result['presentation']?['components'] is List &&
          (result['presentation']['components'] as List).any(
            (c) => c is Map && c['type'] == 'text_input',
          );
      _status = '感知处理已返回。以下是受限组件呈现，不是任意业务界面生成。';
    });
  }

  bool get _textRequested => _textAuthorized;
  Future<void> _submitText() async {
    if (!_textAuthorized ||
        _receipt == null ||
        _generatedText.text.trim().isEmpty) {
      return;
    }
    final epoch = _epoch, subjectId = _subjectId;
    final result = await _api!.request(
      '/v1/perceptions/text',
      body: {
        'creatureId': subjectId,
        'perceptionId': _receipt!['id'],
        'text': _generatedText.text.trim(),
      },
    );
    if (!mounted || epoch != _epoch || subjectId != _subjectId) return;
    setState(() {
      _receipt = result;
      _resultModality = 'text';
      _generatedText.clear();
      _status = '文本已交给当前主体的受限感知呈现流程；没有自动执行外部服务。';
    });
  }

  List<Widget> _presentation() {
    final raw = _receipt?['presentation']?['components'];
    if (raw is! List) return [];
    final result = <Widget>[];
    bool inputAdded = false;
    for (final component in raw.take(20)) {
      if (component is! Map) continue;
      final type = component['type'];
      if (type == 'transcript' || type == 'ocr_text' || type == 'status_text') {
        final text = component['text'];
        if (text is! String) continue;
        result.add(
          Card(
            child: ListTile(
              title: Text(
                type == 'ocr_text'
                    ? '视觉文字识别（不是完整场景理解）'
                    : type == 'status_text' || _resultModality == 'text'
                    ? '主体状态 / 本地规则结果'
                    : '听觉转写',
              ),
              subtitle: Text(
                text.length > 8000 ? text.substring(0, 8000) : text,
              ),
            ),
          ),
        );
      } else if (type == 'text_input' && _textRequested && !inputAdded) {
        inputAdded = true;
        result.add(
          TextField(
            key: const Key('generated-input'),
            controller: _generatedText,
            enabled: !_busy,
            onChanged: (_) => setState(() {}),
            maxLength: 4000,
            decoration: const InputDecoration(labelText: '根据本次语音需求生成的文字输入'),
          ),
        );
        result.add(
          FilledButton(
            key: const Key('submit-generated-input'),
            onPressed: _busy || _generatedText.text.trim().isEmpty
                ? null
                : () => _run(_submitText),
            child: const Text('提交本次请求的文字输入'),
          ),
        );
      }
    }
    return result;
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _epoch++;
    _recordLimit?.cancel();
    unawaited(_capture.dispose().catchError((_) {}));
    _endpoint.dispose();
    _token.dispose();
    _generatedText.dispose();
    if (widget.client == null) _client.close();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(
      title: const Text('Summon · 感知空间'),
      actions: [
        IconButton(
          key: const Key('scene-experiment'),
          tooltip: '合成情境实验',
          icon: const Icon(Icons.science),
          onPressed: _busy || _recording
              ? null
              : () => _run(() async {
                  await _discard();
                  if (!mounted) return;
                  await Navigator.of(this.context).push(
                    MaterialPageRoute(builder: (_) => const SceneExperiment()),
                  );
                }),
        ),
        IconButton(
          key: const Key('sense-settings'),
          tooltip: '开发连接设置',
          icon: const Icon(Icons.settings),
          onPressed: _busy || _recording ? null : _settings,
        ),
        if (widget.developerConsole != null)
          IconButton(
            tooltip: '开发控制台',
            icon: const Icon(Icons.build),
            onPressed: _busy || _recording
                ? null
                : () => _run(() async {
                    await _discard();
                    if (!mounted) return;
                    await Navigator.of(this.context).push(
                      MaterialPageRoute(builder: widget.developerConsole!),
                    );
                  }),
          ),
      ],
    ),
    body: SafeArea(
      child: SingleChildScrollView(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            const Text('听觉与视觉是入口，不是聊天附件。只在你明确启用后采集；不会后台监听或监视。'),
            const Text('首期听觉：离线语音转写；视觉：OCR 文字识别。不等同通用视觉/声音理解。'),
            if (_api != null)
              Text(
                '服务端引擎：听觉 ${_capabilities['hearing']?['available'] == true ? '可用' : '不可用/未报告'}；视觉 ${_capabilities['vision']?['available'] == true ? '可用' : '不可用/未报告'}。此状态不证明本机传感器可用。',
              ),
            if (_busy) const LinearProgressIndicator(),
            Text(_status, key: const Key('sense-status')),
            if (_api != null && _creatures.isNotEmpty)
              DropdownButton<String>(
                key: const Key('sense-subject'),
                value: _subjectId,
                isExpanded: true,
                items: _creatures
                    .map(
                      (c) => DropdownMenuItem<String>(
                        value: c['id'] as String,
                        child: Text(
                          '主体：${c['name']}',
                          overflow: TextOverflow.ellipsis,
                        ),
                      ),
                    )
                    .toList(),
                onChanged: _busy || _recording
                    ? null
                    : (id) {
                        unawaited(_discard());
                        setState(() {
                          _subjectId = id;
                          _dialogueEnabled = false;
                          _receipt = null;
                          _textAuthorized = false;
                          _generatedText.clear();
                        });
                      },
              ),
            if (_subject != null) ...[
              SwitchListTile(
                key: const Key('allow-hearing'),
                title: const Text('允许此主体处理语音'),
                value: _granted('hearing'),
                onChanged: _busy || _recording
                    ? null
                    : (value) => _run(() => _grant('hearing', value)),
              ),
              SwitchListTile(
                key: const Key('allow-vision'),
                title: const Text('允许此主体处理图片'),
                value: _granted('vision'),
                onChanged: _busy || _recording
                    ? null
                    : (value) => _run(() => _grant('vision', value)),
              ),
            ],
            if (_subject != null)
              SwitchListTile(
                key: const Key('sense-dialogue'),
                title: const Text('听完后交给当前主体回应'),
                subtitle: const Text(
                  '开启后，转写和回应会保存为主体会话；若配置真实模型，转写将发送给服务端配置的模型。需主体具有 conversation 能力。',
                ),
                value: _dialogueEnabled && _canConverse,
                onChanged: _busy || _recording || !_canConverse
                    ? null
                    : (value) => setState(() => _dialogueEnabled = value),
              ),
            FilledButton.icon(
              key: const Key('hear'),
              onPressed: _busy || !_granted('hearing') || !_available('hearing')
                  ? null
                  : () => _run(_recording ? _stop : _start),
              icon: Icon(_recording ? Icons.stop : Icons.mic),
              label: Text(_recording ? '停止录音' : '开始本次听觉采集'),
            ),
            OutlinedButton.icon(
              key: const Key('see'),
              onPressed:
                  _busy ||
                      _recording ||
                      !_granted('vision') ||
                      !_available('vision')
                  ? null
                  : () => _run(_photo),
              icon: const Icon(Icons.camera_alt),
              label: const Text('开始本次视觉采集'),
            ),
            if (_pending != null) ...[
              if (_modality == 'vision')
                Image.memory(
                  _pending!.bytes,
                  height: 180,
                  errorBuilder: (_, _, _) => const Text('图像预览不可用'),
                ),
              Text(
                '${_modality == 'vision' ? '图像' : '录音'} ${(_pending!.bytes.length / 1024).toStringAsFixed(1)} KiB，待确认发送',
              ),
              FilledButton(
                key: const Key('send-sense'),
                onPressed: _busy ? null : () => _run(_send),
                child: const Text('发送给所选主体处理'),
              ),
              TextButton(
                key: const Key('discard-sense'),
                onPressed: _busy ? null : () => _discard(),
                child: const Text('丢弃，不发送'),
              ),
            ],
            if (_receipt != null) ...[
              Text(
                '处理引擎：${_receipt!['result']?['engine'] ?? '未知'} · 模型：${_receipt!['result']?['model'] ?? '未知'}',
              ),
              Text(
                '处理类别：${_resultModality == 'text'
                    ? '本地文本呈现规则，不是音视觉识别'
                    : _receipt!['result']?['realProcessing'] == true
                    ? '服务报告已进行真实处理'
                    : '未确认，不能当作真实识别'}',
              ),
              Text('限制：${_receipt!['result']?['limitations'] ?? '请核对服务端能力'}'),
              ..._presentation(),
              ...dialogueWidgets(_receipt!['dialogue']),
            ],
          ],
        ),
      ),
    ),
  );
}

// Only inert, bounded display components are accepted. No links/actions/inputs.
List<Widget> dialogueWidgets(dynamic raw) {
  if (raw is! Map) return [];
  String clipped(dynamic value, [int limit = 4000]) => value is String
      ? value.substring(0, value.length > limit ? limit : value.length)
      : '';
  final widgets = <Widget>[
    Text(
      raw['providerMode'] == 'demo'
          ? '主体回应 · 演示规则，未使用真实 LLM'
          : raw['providerMode'] == 'llm'
          ? '主体回应 · 服务端配置的 LLM'
          : '主体回应 · 提供方未确认',
    ),
  ];
  if (raw['status'] != 'completed') {
    widgets.add(const Text('转写已完成，但主体回应失败。不会自动重试。'));
    return widgets;
  }
  final answer = clipped(raw['answer'], 12000);
  if (answer.isNotEmpty) widgets.add(Text(answer));
  final presentation = raw['presentation'];
  final components = presentation is Map ? presentation['components'] : null;
  if (components is! List) return widgets;
  for (final component in components.take(12)) {
    if (component is! Map) continue;
    final title = clipped(component['title'], 120);
    switch (component['type']) {
      case 'status_text':
        final text = clipped(component['text']);
        if (text.isNotEmpty) widgets.add(Text(text));
      case 'bullet_list':
        final items = component['items'];
        if (items is! List) continue;
        widgets.add(
          Card(
            child: Padding(
              padding: const EdgeInsets.all(12),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  if (title.isNotEmpty) Text(title),
                  for (final item in items.take(10))
                    if (item is String) Text('• ${clipped(item, 500)}'),
                ],
              ),
            ),
          ),
        );
      case 'key_values':
        final entries = component['entries'];
        if (entries is! List) continue;
        widgets.add(
          Card(
            child: Padding(
              padding: const EdgeInsets.all(12),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  if (title.isNotEmpty) Text(title),
                  for (final item in entries.take(10))
                    if (item is Map &&
                        item['label'] is String &&
                        item['value'] is String)
                      Text(
                        '${clipped(item['label'], 120)}：${clipped(item['value'], 500)}',
                      ),
                ],
              ),
            ),
          ),
        );
    }
  }
  return widgets;
}
