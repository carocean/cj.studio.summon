import 'package:material_ui/material_ui.dart';

import 'scene_experiment.dart';
import 'api.dart';

Map<String, dynamic>? trustedTextEntry(Map<String, dynamic>? state) {
  final entry = state?['textEntry'], frame = state?['context'];
  if (entry is! Map ||
      frame is! Map ||
      entry.length != 4 ||
      entry['schema'] != 'scene-text-entry.v1' ||
      entry['source'] != 'deterministic-policy' ||
      entry['maxLength'] is! int ||
      entry['maxLength'] != 200) {
    return null;
  }
  final context = entry['context'];
  if (context is! Map ||
      context.length != 2 ||
      context['creatureId'] is! String ||
      (context['creatureId'] as String).isEmpty ||
      (context['creatureId'] as String).length > 64 ||
      context['creatureId'] != state?['activeCreatureId'] ||
      context['creatureId'] != frame['creatureId'] ||
      context['sceneRevision'] is! int ||
      context['sceneRevision'] < 1 ||
      context['sceneRevision'] > 9007199254740991 ||
      context['sceneRevision'] != frame['sceneRevision']) {
    return null;
  }
  return Map<String, dynamic>.from(context);
}

/// An explicitly requested, short-lived command surface; not a chat history.
class SceneTextEntry extends StatefulWidget {
  const SceneTextEntry({
    super.key,
    required this.api,
    required this.frame,
    required this.onState,
  });
  final SceneExperimentApi api;
  final Map<String, dynamic> frame;
  final ValueChanged<Map<String, dynamic>> onState;
  @override
  State<SceneTextEntry> createState() => _SceneTextEntryState();
}

class _SceneTextEntryState extends State<SceneTextEntry>
    with WidgetsBindingObserver {
  final _text = TextEditingController();
  bool _busy = false, _foreground = true, _uncertain = false;
  int _epoch = 0;
  String? _message;
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
  }

  @override
  void didUpdateWidget(SceneTextEntry oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.frame['creatureId'] != widget.frame['creatureId'] ||
        oldWidget.frame['sceneRevision'] != widget.frame['sceneRevision']) {
      _epoch++;
      _text.clear();
      _busy = false;
      _uncertain = false;
      _message = null;
    }
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    _foreground = state == AppLifecycleState.resumed;
    if (!_foreground) {
      _epoch++;
      _text.clear();
      setState(() {
        _uncertain = _uncertain || _busy;
        _busy = false;
        _message = _uncertain ? '响应未确认，请先刷新情境；不会自动重发。' : null;
      });
    } else {
      setState(() {});
    }
  }

  Future<void> _send({bool close = false, bool refresh = false}) async {
    if (_busy ||
        !_foreground ||
        (!close &&
            !refresh &&
            (_uncertain ||
                _text.text.trim().isEmpty ||
                _text.text.length > 200))) {
      return;
    }
    final epoch = ++_epoch;
    final text = _text.text;
    if (close || refresh) _text.clear();
    setState(() {
      _busy = true;
      _message = null;
    });
    try {
      final state = await widget.api.request(
        refresh
            ? 'state'
            : close
            ? 'text-entry'
            : 'text-request',
        refresh
            ? null
            : close
            ? {'context': widget.frame, 'visible': false}
            : {
                'context': widget.frame,
                'text': text,
                'confirmation': 'apply-direct-text-scene',
              },
      );
      if (!mounted || epoch != _epoch || !_foreground) return;
      _text.clear();
      _uncertain = false;
      widget.onState(state);
    } catch (error) {
      if (!mounted || epoch != _epoch) return;
      if (error is ApiFailure &&
          error.status == 400 &&
          error.code == 'unsupported_text_request') {
        setState(() => _message = '这句话不在有限口令内。可改为“开始工作”“模拟开户”或“回到伙伴”；没有切换情境。');
        return;
      }
      // A transport failure cannot establish whether the command was applied.
      _text.clear();
      _uncertain = true;
      setState(() => _message = '未确认或不支持这句话。请刷新情境后再操作；不会自动重发。');
    } finally {
      if (mounted && epoch == _epoch) setState(() => _busy = false);
    }
  }

  @override
  void dispose() {
    _epoch++;
    WidgetsBinding.instance.removeObserver(this);
    _text.clear();
    _text.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => Card(
    child: Padding(
      padding: const EdgeInsets.all(16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          const Text('按需文字入口'),
          const Text(
            '仅支持“开始工作”“模拟开户”“回到伙伴”等有限口令，不是真实开户或自由聊天。原文不保存、不送模型，请勿输入个人资料。',
          ),
          TextField(
            key: const Key('scene-text-input'),
            controller: _text,
            enabled: !_busy && !_uncertain && _foreground,
            maxLength: 200,
            onChanged: (_) => setState(() {}),
            decoration: const InputDecoration(labelText: '告诉当前伙伴要切换的演示情境'),
          ),
          if (_message != null) Text(_message!),
          FilledButton(
            key: const Key('scene-text-submit'),
            onPressed:
                _busy ||
                    _uncertain ||
                    !_foreground ||
                    _text.text.trim().isEmpty ||
                    _text.text.length > 200
                ? null
                : () => _send(),
            child: const Text('按有限口令切换演示情境'),
          ),
          if (_uncertain)
            TextButton(
              key: const Key('scene-text-refresh'),
              onPressed: _busy ? null : () => _send(refresh: true),
              child: const Text('刷新并核对情境'),
            ),
          TextButton(
            key: const Key('scene-text-close'),
            onPressed: _busy ? null : () => _send(close: true),
            child: const Text('关闭文字入口'),
          ),
        ],
      ),
    ),
  );
}
