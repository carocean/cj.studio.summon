import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:material_ui/material_ui.dart';

import 'api.dart';
import 'interaction_contract.dart';
import 'real_usage.dart' show usageCommandId;
import 'scene_experiment.dart';
import 'text_interaction.dart';

class TextInteractionSheet extends StatefulWidget {
  const TextInteractionSheet({
    super.key,
    required this.api,
    required this.draft,
    required this.frame,
    required this.onOpen,
    this.access,
    this.onReturn,
  });
  final SceneExperimentApi api;
  final TextInteractionDraft draft;
  final Map<String, dynamic> frame;
  final ValueListenable<bool>? access;
  final Future<void> Function(BuildContext) onOpen;
  final Future<void> Function(BuildContext)? onReturn;
  @override
  State<TextInteractionSheet> createState() => _TextInteractionSheetState();
}

class _TextInteractionSheetState extends State<TextInteractionSheet>
    with WidgetsBindingObserver {
  TextInteractionDraft get d => widget.draft;
  late final TextEditingController _text;
  Map<String, dynamic>? _capability;
  Completer<void>? _abort;
  int _epoch = 0;
  bool _foreground = true;
  String? _working;
  bool get _allowed => _foreground && (widget.access?.value ?? true);
  bool _current(int epoch) =>
      mounted &&
      _allowed &&
      epoch == _epoch &&
      ModalRoute.of(context)?.isCurrent == true;
  void _stop() {
    _epoch++;
    final a = _abort;
    _abort = null;
    if (a != null && !a.isCompleted) a.complete();
    _working = null;
  }

  @override
  void initState() {
    super.initState();
    _text = TextEditingController(text: d.text);
    widget.access?.addListener(_accessChanged);
    WidgetsBinding.instance.addObserver(this);
    _foreground =
        WidgetsBinding.instance.lifecycleState == null ||
        WidgetsBinding.instance.lifecycleState == AppLifecycleState.resumed;
    unawaited(_loadCapability());
  }

  void _accessChanged() {
    if (!mounted) return;
    if (!(widget.access?.value ?? true)) {
      _stop();
      d.message = '认证已失效；本页文字和原命令保留，认证后请主动核对。';
    }
    setState(() {});
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    _foreground = state == AppLifecycleState.resumed;
    if (!_foreground) {
      _stop();
      d.message = '已停止等待；本页文字仍在。已有请求只核对原命令，不自动重发。';
    }
    if (mounted) setState(() {});
  }

  Future<void> _loadCapability() async {
    if (!_allowed || _working != null) return;
    final epoch = ++_epoch;
    setState(() => _working = 'state');
    try {
      final r = await widget.api.request('textgen-state');
      if (!_current(epoch)) return;
      _capability = textGenerationState(r);
      d.message = _capability == null
          ? '文字生成状态不可用。'
          : _capability!['enabled'] != true ||
                _capability!['plannerAvailable'] != true
          ? '宿主尚未启用文字模型生成；不会用有限口令或测试字段替代。'
          : null;
    } catch (_) {
      if (_current(epoch)) d.message = '无法核验文字生成状态，本页输入保留。';
    } finally {
      if (mounted && epoch == _epoch) setState(() => _working = null);
    }
  }

  Future<void> _verifyFrame(int epoch) async {
    final state = await widget.api.request('state');
    if (!_current(epoch)) throw const ApiFailure(409, 'text_surface_stale');
    if (state['mode'] != 'deterministic-synthetic' ||
        state['activeCreatureId'] != d.context?['creatureId'] ||
        interactionCanonical(state['context']) !=
            interactionCanonical(d.context)) {
      throw const ApiFailure(409, 'text_context_changed');
    }
  }

  Future<void> _request(String action) async {
    if (!_allowed ||
        (_working != null &&
            !(action == 'textgen-cancel' && _working == 'textgen-generate'))) {
      return;
    }
    if (action == 'textgen-generate' &&
        (d.body != null || !validUserText(d.text))) {
      return;
    }
    if (action != 'textgen-generate' && d.body == null) return;
    _stop();
    final epoch = _epoch, abort = Completer<void>();
    _abort = abort;
    setState(() => _working = action);
    try {
      if (action == 'textgen-generate') {
        await _verifyFrame(epoch);
        final cap = textGenerationState(
          await widget.api.request('textgen-state'),
        );
        if (!_current(epoch)) return;
        if (cap == null ||
            cap['enabled'] != true ||
            cap['plannerAvailable'] != true) {
          throw const ApiFailure(409, 'text_generation_unavailable');
        }
        d.body = {
          'commandId': usageCommandId(),
          'context': Map<String, dynamic>.from(d.context!),
          'text': d.text,
          'confirmation': 'generate-from-user-text',
        };
        d.record = null;
        d.cancelRequested = false;
      }
      if (action == 'textgen-cancel') d.cancelRequested = true;
      final r = await textGenerationRequest(
        widget.api.client,
        action,
        action == 'textgen-generate'
            ? d.body
            : {'commandId': d.body!['commandId']},
        cancel: abort.future,
      );
      if (!_current(epoch)) return;
      final record = textGenerationRecord(r, d.body!['commandId']);
      if (record == null) throw const ApiFailure(502, 'invalid_textgen_record');
      d.record = record;
      d.message = record['status'] == 'not_started'
          ? '尚未观察到原请求；不能据此认定未执行或已取消，不自动重发。'
          : record['status'] == 'running'
          ? '原请求仍在处理中；可核对或明确请求取消。'
          : record['status'] == 'completed'
          ? '已取得结果；尚未打开界面，也没有保存本地草稿。'
          : '原请求状态：${record['status']}。本页文字保留。';
    } catch (_) {
      if (mounted && epoch == _epoch) {
        d.message = d.body == null
            ? '情境或模型状态不可用；文字保留，未发起生成。'
            : '结果待核查；保留原命令，只查询，不自动重发或打开。';
      }
    } finally {
      if (mounted && epoch == _epoch) setState(() => _working = null);
      if (!abort.isCompleted) abort.complete();
    }
  }

  Future<void> _open() async {
    if (!_allowed || _working != null) return;
    final epoch = ++_epoch;
    setState(() => _working = 'open');
    try {
      await _verifyFrame(epoch);
      if (!mounted || !_current(epoch)) return;
      await widget.onOpen(context);
    } catch (_) {
      if (_current(epoch)) d.message = '结果尚不可打开。保留文字与原命令，请核验情境和会话。';
    } finally {
      if (mounted && epoch == _epoch) setState(() => _working = null);
    }
  }

  void _newRound() {
    if (!_allowed || _working != null || !(d.body == null || d.terminal)) {
      return;
    }
    setState(() {
      d.body = null;
      d.record = null;
      d.cancelRequested = false;
      d.context = Map<String, dynamic>.from(widget.frame);
      d.message = '已另起一次需求，原文字保留；只有再次点击才发送模型。';
    });
  }

  @override
  void dispose() {
    _stop();
    widget.access?.removeListener(_accessChanged);
    WidgetsBinding.instance.removeObserver(this);
    _text.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final result = d.record?['result'];
    return Scaffold(
      appBar: AppBar(
        title: const Text('按需文字入口'),
        leading: IconButton(
          key: const Key('textgen-hide'),
          tooltip: '收起并保留本页文字',
          icon: const Icon(Icons.close),
          onPressed: () {
            if (ModalRoute.of(context)?.isCurrent == true) {
              Navigator.of(context).pop();
            }
          },
        ),
      ),
      body: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const Text('本次文字需求'),
              const Text('明确发送后才交给宿主配置的模型。输入和旧稿只保留在本页内存；不是聊天历史，也不等于已保存。'),
              TextField(
                key: const Key('textgen-input'),
                controller: _text,
                readOnly: !_allowed || _working != null || d.body != null,
                maxLines: 5,
                onChanged: (v) => setState(() => d.text = v),
                decoration: const InputDecoration(
                  labelText: '描述本次需求（最多4000字符、16000 UTF-8字节）',
                ),
              ),
              Text(
                '${d.text.runes.length}/4000 字符，${utf8.encode(d.text).length}/16000 字节',
              ),
              if (d.message != null)
                Text(d.message!, key: const Key('textgen-status')),
              if (_working != null) const LinearProgressIndicator(),
              if (d.body == null)
                FilledButton(
                  key: const Key('textgen-submit'),
                  onPressed:
                      _allowed &&
                          _working == null &&
                          validUserText(d.text) &&
                          _capability?['enabled'] == true &&
                          _capability?['plannerAvailable'] == true
                      ? () => _request('textgen-generate')
                      : null,
                  child: const Text('将本次文字发给模型生成'),
                ),
              if (d.body != null)
                TextButton(
                  key: const Key('textgen-query'),
                  onPressed: _allowed && _working == null
                      ? () => _request('textgen-query')
                      : null,
                  child: const Text('核对原生成请求（不重发）'),
                ),
              if (d.body != null && !d.terminal)
                TextButton(
                  key: const Key('textgen-cancel'),
                  onPressed:
                      _allowed &&
                          (_working == null || _working == 'textgen-generate')
                      ? () => _request('textgen-cancel')
                      : null,
                  child: const Text('停止等待并请求取消'),
                ),
              if (result?['kind'] == 'clarify')
                SelectableText('模型建议补充：${result['question']}'),
              if (result?['kind'] == 'none')
                SelectableText('模型未生成界面：${result['reason']}'),
              if (result?['kind'] == 'form')
                FilledButton(
                  key: const Key('textgen-open'),
                  onPressed: _allowed && _working == null ? _open : null,
                  child: Text(d.cancelRequested ? '明确查看已完成结果' : '核验并打开生成界面'),
                ),
              if (d.terminal ||
                  (d.body == null &&
                      interactionCanonical(d.context) !=
                          interactionCanonical(widget.frame)))
                TextButton(
                  key: const Key('textgen-new'),
                  onPressed: _allowed && _working == null ? _newRound : null,
                  child: const Text('另起一次需求（保留文字，不自动发送）'),
                ),
              if (d.body == null)
                TextButton(
                  key: const Key('textgen-state'),
                  onPressed: _allowed && _working == null
                      ? _loadCapability
                      : null,
                  child: const Text('核验文字模型是否可用'),
                ),
              if (widget.onReturn != null)
                TextButton(
                  key: const Key('textgen-return-draft'),
                  onPressed: () => widget.onReturn!(context),
                  child: const Text('返回保留的本页草稿'),
                ),
            ],
          ),
        ),
      ),
    );
  }
}
