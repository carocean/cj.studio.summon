import 'dart:async';
import 'dart:math';

import 'package:material_ui/material_ui.dart';
import 'package:flutter/services.dart';
import 'package:flutter/foundation.dart';

import 'api.dart';
import 'interaction_contract.dart';
import 'scene_experiment.dart';

/// In-memory recovery owned by the host controller, not a saved note or authority.
/// No model text selects a route, command, URL, widget class or save behavior.
class InteractionDraftState {
  Map<String, dynamic>? view;
  Map<String, dynamic> values = {};
  Map<String, dynamic>? pending, receipt;
  bool presented = false;
  String? returnSessionId;
  bool resumeReadOnly = false;
  bool stale = false, closed = false;
  String? message;
  bool get dirty =>
      view != null &&
      interactionCanonical(values) !=
          interactionCanonical(view!['draft']['values']);
}

class TemporaryInteractionSheet extends StatefulWidget {
  const TemporaryInteractionSheet({
    super.key,
    required this.api,
    required this.sessionId,
    required this.contextBinding,
    required this.recovery,
    this.recoveryOnly = false,
    this.access,
    this.onPauseForHearing,
    this.onTextDemand,
    this.onReturnToDraft,
  });
  final SceneExperimentApi api;
  final String sessionId;
  final Map<String, dynamic> contextBinding;
  final InteractionDraftState recovery;
  final bool recoveryOnly;
  final ValueListenable<bool>? access;
  final Future<void> Function()? onPauseForHearing;
  final Future<void> Function()? onTextDemand;
  final Future<void> Function(BuildContext)? onReturnToDraft;
  @override
  State<TemporaryInteractionSheet> createState() =>
      _TemporaryInteractionSheetState();
}

class _TemporaryInteractionSheetState extends State<TemporaryInteractionSheet>
    with WidgetsBindingObserver {
  InteractionDraftState get d => widget.recovery;
  final _text = <String, TextEditingController>{};
  int _epoch = 0;
  bool _busy = false, _foreground = true;
  Timer? _expiry;
  bool get _editable =>
      !widget.recoveryOnly &&
      (widget.access?.value ?? true) &&
      !_busy &&
      _foreground &&
      !d.stale &&
      !d.closed &&
      d.pending == null &&
      d.view != null &&
      DateTime.now().millisecondsSinceEpoch < d.view!['expiresAt'];
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    widget.access?.addListener(_accessChanged);
    _foreground =
        WidgetsBinding.instance.lifecycleState == null ||
        WidgetsBinding.instance.lifecycleState == AppLifecycleState.resumed;
    _syncControllers();
    if (_foreground) {
      if (d.pending != null) {
        _query();
      } else {
        _refresh();
      }
    }
  }

  void _accessChanged() {
    if (!mounted) return;
    if (widget.access?.value == false) {
      _epoch++;
      _busy = false;
      d.stale = true;
      d.message = '认证已失效；保留本页输入及原命令。认证后请主动核验，不会自动保存。';
    }
    setState(() {});
  }

  bool _current(int epoch) => mounted && _foreground && epoch == _epoch;
  void _syncControllers() {
    for (final c in _text.values) {
      c.dispose();
    }
    _text.clear();
    for (final f
        in (d.view?['program']['declaration']['fields'] as List? ?? [])) {
      if (f['type'] != 'choice') {
        _text[f['id']] = TextEditingController(text: d.values[f['id']] ?? '');
      }
    }
    _expiry?.cancel();
    final deadline = d.view?['expiresAt'];
    if (deadline is int) {
      final left = deadline - DateTime.now().millisecondsSinceEpoch;
      _expiry = Timer(Duration(milliseconds: max(0, left)), () {
        if (mounted) {
          setState(() {
            d.stale = true;
            d.message = '临时会话已到期。保留本机输入供查看，不能继续提交。';
          });
        }
      });
    }
  }

  Future<void> _refresh({
    int? acknowledgedRevision,
    bool discard = false,
  }) async {
    if (widget.recoveryOnly ||
        !(widget.access?.value ?? true) ||
        !_foreground ||
        _busy) {
      return;
    }
    final epoch = ++_epoch;
    setState(() => _busy = true);
    try {
      final raw = await widget.api.request('interaction-read', {
        'sessionId': widget.sessionId,
      });
      if (!_current(epoch)) return;
      final next = validatedInteractionSession(
        raw,
        sessionId: widget.sessionId,
        context: widget.contextBinding,
      );
      if (next == null) throw const ApiFailure(409, 'invalid_interaction_view');
      final same =
          d.view != null &&
          next['revision'] == d.view!['revision'] &&
          interactionCanonical(next) == interactionCanonical(d.view);
      if (d.view == null ||
          discard ||
          acknowledgedRevision == next['revision']) {
        d.view = next;
        d.values = Map<String, dynamic>.from(next['draft']['values']);
        d.stale = false;
        _syncControllers();
      } else if (same) {
        d.stale = false;
        d.message = null;
      } else if (!same) {
        d.stale = true;
        d.message = '宿主版本已变化。原输入仍在，不能自动迁移或覆盖。';
      }
    } catch (_) {
      if (_current(epoch)) {
        d.stale = true;
        d.message = '会话不可用或已失效。保留已有输入，不能提交。';
      }
    } finally {
      if (_current(epoch)) setState(() => _busy = false);
    }
  }

  String _commandId() =>
      'ui-${List.generate(16, (_) => Random.secure().nextInt(256).toRadixString(16).padLeft(2, '0')).join()}';
  Future<void> _mutate(String operation) async {
    if (!_editable) return;
    if (operation == 'edit' && !d.dirty) return;
    if (operation != 'edit' && d.dirty) return;
    if (operation == 'save' &&
        !interactionValuesValid(
          d.view!['program'],
          d.values,
          requireComplete: true,
        )) {
      return;
    }
    final body = <String, dynamic>{
      'commandId': _commandId(),
      'sessionId': widget.sessionId,
      'expectedRevision': d.view!['revision'],
      if (operation == 'edit') 'changes': Map<String, dynamic>.from(d.values),
      if (operation == 'save') 'confirmation': 'save-local-draft',
    };
    d.pending = {
      'operation': operation,
      'body': body,
      'programDigest': d.view!['program']['programDigest'],
      'draftRevision': d.view!['draft']['revision'],
    };
    final epoch = ++_epoch;
    setState(() => _busy = true);
    int? revision;
    try {
      final result = await widget.api.request('interaction-$operation', body);
      if (!_current(epoch)) return;
      if (result.keys.toSet().difference({'replayed', 'ack'}).isNotEmpty ||
          result.length != 2 ||
          result['replayed'] is! bool ||
          !_acceptAck(result['ack'])) {
        throw const ApiFailure(502, 'invalid_interaction_ack');
      }
      revision = result['ack']['revision'];
    } catch (error) {
      if (_current(epoch)) {
        final definitive =
            error is ApiFailure &&
            [
              'interaction_revision_conflict',
              'interaction_session_expired',
              'interaction_session_closed',
              'interaction_context_changed',
              'interaction_required_value',
              'invalid_interaction_value',
              'interaction_change_capacity',
              'interaction_note_capacity',
              'interaction_command_capacity',
            ].contains(error.code);
        if (definitive) {
          d.pending = null;
          d.stale = true;
          d.message = '宿主拒绝本次操作。输入保留，请核对当前会话。';
        } else {
          d.message = '结果尚未确认。已保留原命令编号，只查询，不重复发送。';
        }
      }
    } finally {
      if (_current(epoch)) setState(() => _busy = false);
    }
    if (_current(epoch) && revision != null && !d.closed) {
      await _refresh(acknowledgedRevision: revision);
    }
  }

  bool _acceptAck(dynamic ack) {
    final pending = d.pending;
    if (pending == null ||
        ack is! Map ||
        ack['sessionId'] != widget.sessionId) {
      return false;
    }
    final op = pending['operation'],
        expected = pending['body']['expectedRevision'];
    final fields = switch (op) {
      'edit' => {
        'fact',
        'sessionId',
        'revision',
        'programDigest',
        'draftRevision',
      },
      'save' => {
        'fact',
        'sessionId',
        'noteId',
        'noteDigest',
        'revision',
        'programDigest',
        'draftRevision',
        'savedAt',
      },
      _ => {'fact', 'sessionId', 'revision'},
    };
    if (ack.length != fields.length ||
        !ack.keys.every(fields.contains) ||
        ack['revision'] is! int) {
      return false;
    }
    if (op == 'close') {
      if (![
            'interaction_presentation_closed',
            'interaction_already_inactive',
          ].contains(ack['fact']) ||
          ack['revision'] < expected ||
          ack['revision'] > expected + 1) {
        return false;
      }
      d.closed = true;
      d.stale = true;
      d.message = '临时会话已关闭，已保存的本地副本不会被删除。';
    } else {
      if (ack['draftRevision'] is! int ||
          ack['revision'] != expected + 1 ||
          ack['programDigest'] != pending['programDigest'] ||
          ack['draftRevision'] !=
              pending['draftRevision'] + (op == 'edit' ? 1 : 0)) {
        return false;
      }
      if (op == 'edit' && ack['fact'] != 'interaction_draft_updated') {
        return false;
      }
      if (op == 'save') {
        if (ack['fact'] != 'local_note_saved' ||
            !interactionId(ack['noteId']) ||
            ack['noteDigest'] is! String ||
            !RegExp(r'^sha256:[a-f0-9]{64}$').hasMatch(ack['noteDigest']) ||
            ack['savedAt'] is! int ||
            ack['savedAt'] < d.view!['createdAt'] ||
            ack['savedAt'] >= d.view!['expiresAt']) {
          return false;
        }
        d.receipt = Map<String, dynamic>.from(ack);
      }
      d.message = op == 'save' ? '已保存本地副本。不是外部业务提交。' : '草稿已更新，尚未保存为本地副本。';
    }
    d.pending = null;
    return true;
  }

  Future<void> _query() async {
    if (_busy || !_foreground || d.pending == null) return;
    final epoch = ++_epoch, command = d.pending!['body']['commandId'];
    setState(() => _busy = true);
    int? revision;
    try {
      final result = await widget.api.request('interaction-query', {
        'commandId': command,
      });
      if (!_current(epoch)) return;
      if (result['commandId'] != command) {
        throw const ApiFailure(502, 'invalid_command_query');
      }
      if (result['status'] == 'completed' &&
          result.length == 3 &&
          _acceptAck(result['ack'])) {
        revision = result['ack']['revision'];
      } else if (result['status'] == 'not_started' && result.length == 2) {
        d.message = '尚未观察到该命令完成。保留原编号，不另发保存请求。';
      } else {
        throw const ApiFailure(502, 'invalid_command_query');
      }
    } catch (_) {
      if (_current(epoch)) d.message = '查询未确认，原命令仍保留；不会重发。';
    } finally {
      if (_current(epoch)) setState(() => _busy = false);
    }
    if (_current(epoch) && revision != null && !d.closed) {
      await _refresh(acknowledgedRevision: revision);
    }
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    _foreground = state == AppLifecycleState.resumed;
    if (!_foreground) {
      _epoch++;
      setState(() => _busy = false);
    } else if (d.pending != null) {
      _query();
    } else {
      _refresh();
    }
  }

  @override
  void dispose() {
    _epoch++;
    _expiry?.cancel();
    widget.access?.removeListener(_accessChanged);
    WidgetsBinding.instance.removeObserver(this);
    for (final c in _text.values) {
      c.dispose();
    }
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final fields = d.view?['program']['declaration']['fields'] as List? ?? [];
    return Scaffold(
      appBar: AppBar(
        title: const Text('临时交互'),
        actions: [
          if (widget.onReturnToDraft != null)
            IconButton(
              key: const Key('interaction-return-draft'),
              tooltip: '保留本稿，返回上一份保留草稿',
              icon: const Icon(Icons.undo),
              onPressed: () => widget.onReturnToDraft!(context),
            ),
          if (widget.onPauseForHearing != null)
            IconButton(
              key: const Key('interaction-new-need'),
              tooltip: '保留草稿，提出新需求（不自动录音）',
              icon: const Icon(Icons.mic_none),
              onPressed: widget.onPauseForHearing,
            ),
        ],
        leading: IconButton(
          key: const Key('interaction-hide'),
          tooltip: '收起界面，保留本机输入',
          icon: const Icon(Icons.close),
          onPressed: () => Navigator.of(context).pop(),
        ),
      ),
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.all(20),
          children: [
            if (!_foreground)
              const Text('已暂停显示，返回后核对宿主状态。')
            else ...[
              if (widget.recoveryOnly)
                const Text(
                  '历史恢复（只读）：仅核对原命令，不恢复编辑或保存权限。',
                  key: Key('interaction-recovery-only'),
                ),
              if (d.view != null)
                Text(
                  d.view!['program']['declaration']['title'],
                  key: const Key('interaction-title'),
                ),
              const Text('临时表单声明不代表模型理解已验证；此处仅可保存本地副本。未保存输入仅在本次运行内保留，关闭应用会丢失。'),
              if (d.message != null)
                Text(d.message!, key: const Key('interaction-status')),
              if (d.pending != null)
                Text(
                  '待核对命令：${d.pending!['body']['commandId']}',
                  key: const Key('interaction-command'),
                ),
              for (final f in fields)
                Padding(
                  padding: const EdgeInsets.only(top: 14),
                  child: f['type'] == 'choice'
                      ? DropdownButtonFormField<String>(
                          key: ValueKey(
                            'interaction-${f['id']}-${d.view!['revision']}',
                          ),
                          initialValue: d.values[f['id']],
                          isExpanded: true,
                          decoration: InputDecoration(labelText: f['label']),
                          items: [
                            for (final o in f['options'])
                              DropdownMenuItem<String>(
                                value: o['value'],
                                child: Text(
                                  o['label'],
                                  maxLines: 2,
                                  overflow: TextOverflow.ellipsis,
                                ),
                              ),
                          ],
                          onChanged: !_editable
                              ? null
                              : (value) =>
                                    setState(() => d.values[f['id']] = value),
                        )
                      : TextField(
                          key: ValueKey('interaction-${f['id']}'),
                          controller: _text[f['id']],
                          readOnly: !_editable,
                          minLines: f['type'] == 'multiline' ? 3 : 1,
                          maxLines: f['type'] == 'multiline' ? 6 : 1,
                          decoration: InputDecoration(
                            labelText: f['label'],
                            counterText:
                                '${(_text[f['id']]?.text ?? '').runes.length}/${f['maxLength']}',
                          ),
                          inputFormatters: [
                            TextInputFormatter.withFunction(
                              (old, next) =>
                                  interactionValuesValid(d.view!['program'], {
                                    ...d.values,
                                    f['id']: next.text,
                                  })
                                  ? next
                                  : old,
                            ),
                          ],
                          onChanged: (value) =>
                              setState(() => d.values[f['id']] = value),
                        ),
                ),
              if (widget.onTextDemand != null)
                TextButton(
                  key: const Key('interaction-text-demand'),
                  onPressed: widget.onTextDemand,
                  child: const Text('保留本页草稿，提出文字新需求'),
                ),
              if (_busy) const LinearProgressIndicator(),
              if (d.stale &&
                  d.pending == null &&
                  !widget.recoveryOnly &&
                  (widget.access?.value ?? true))
                TextButton(
                  key: const Key('interaction-revalidate'),
                  onPressed: _busy ? null : () => _refresh(),
                  child: const Text('核验原会话（保留输入）'),
                ),
              if (d.pending != null)
                TextButton(
                  key: const Key('interaction-query'),
                  onPressed: _busy ? null : _query,
                  child: const Text('查询原命令结果（不重发）'),
                ),
              FilledButton(
                key: const Key('interaction-update'),
                onPressed: _editable && d.dirty ? () => _mutate('edit') : null,
                child: const Text('更新临时草稿'),
              ),
              FilledButton(
                key: const Key('interaction-save'),
                onPressed:
                    _editable &&
                        !d.dirty &&
                        interactionValuesValid(
                          d.view!['program'],
                          d.values,
                          requireComplete: true,
                        )
                    ? () => _mutate('save')
                    : null,
                child: const Text('保存本地副本'),
              ),
              if (d.receipt != null)
                SelectableText(
                  '已保存副本：${d.receipt!['noteId']}',
                  key: const Key('interaction-receipt'),
                ),
              if (!widget.recoveryOnly &&
                  d.stale &&
                  !d.closed &&
                  d.pending == null)
                TextButton(
                  key: const Key('interaction-reload'),
                  onPressed: _busy ? null : () => _refresh(discard: true),
                  child: const Text('重新载入宿主版本（明确丢弃本机未确认输入）'),
                ),
              TextButton(
                key: const Key('interaction-close'),
                onPressed: _editable && !d.dirty
                    ? () => _mutate('close')
                    : null,
                child: const Text('结束临时会话（不删除已保存副本）'),
              ),
            ],
          ],
        ),
      ),
    );
  }
}
