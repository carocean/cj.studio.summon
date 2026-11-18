import 'dart:convert';

import 'package:material_ui/material_ui.dart';
import 'package:http/http.dart' as http;

import 'api.dart';
import 'choice_form.dart';
import 'text_interaction.dart';

/// No configurable remote endpoint, credentials, sensors, or model calls.
class SceneExperimentApi {
  SceneExperimentApi(this.client);
  final http.Client client;
  Future<Map<String, dynamic>?> interactionCurrent() async {
    final response = await client
        .get(Uri.parse('http://127.0.0.1:8091/scene/interaction-current'))
        .timeout(const Duration(seconds: 10));
    final data = jsonDecode(utf8.decode(response.bodyBytes));
    if (response.statusCode >= 400) {
      throw const ApiFailure(502, 'interaction_current_unavailable');
    }
    if (data == null) return null;
    if (data is! Map<String, dynamic> ||
        data.length != 2 ||
        !data.containsKey('sessionId') ||
        !data.containsKey('context')) {
      throw const ApiFailure(502, 'invalid_interaction_current');
    }
    return data;
  }

  Future<Map<String, dynamic>> request(
    String action, [
    Map<String, dynamic>? body,
  ]) async {
    if (action.startsWith('textgen-')) {
      return textGenerationRequest(client, action, body);
    }
    if (![
      'dish-read',
      'dish-command',
      'state',
      'usage',
      'usage-select',
      'usage-presented',
      'usage-query',
      'interaction-read',
      'interaction-edit',
      'interaction-save',
      'interaction-query',
      'interaction-close',
      'interaction-saved',
      'handoff-prepare',
      'handoff-confirm',
      'handoff-status',
      'handoff-cancel',
      'handoff-list',
      'text-entry',
      'text-request',
      'perceive',
      'update',
      'form-update',
      'form-route',
      'focus-grant',
      'form-focus',
      'focus-cancel',
      'focus-status',
      'hide',
      'show',
      'submit',
      'cancel',
      'new',
      'sense-capabilities',
      'sense',
      'sense-confirm',
      'sense-route-confirm',
      'sense-route-status',
      'sense-route-cancel',
      'speak',
      'creature-create',
      'creature-select',
      'creature-primary',
      'creature-sense',
      'market-subscribe',
      'market-grant',
      'market-unsubscribe',
      'market-route',
      'market-cancel',
      'route-visible',
      'route-speak',
    ].contains(action)) {
      throw const ApiFailure(0, 'invalid_scene_action');
    }
    final uri = Uri.parse('http://127.0.0.1:8091/scene/$action');
    final isUsage =
        action.startsWith('dish-') ||
        action == 'usage' ||
        action.startsWith('usage-');
    Future<http.Response> usageRequest() async {
      final request = http.Request(body == null ? 'GET' : 'POST', uri)
        ..followRedirects = false;
      if (body != null) {
        request.headers.addAll({
          'Content-Type': 'application/json',
          'X-Summon-Lab': 'synthetic',
        });
        request.body = jsonEncode(body);
      }
      final stream = await client.send(request);
      final bytes = <int>[];
      await for (final chunk in stream.stream) {
        if (bytes.length + chunk.length > 65536) {
          throw const ApiFailure(502, 'usage_response_too_large');
        }
        bytes.addAll(chunk);
      }
      return http.Response.bytes(
        bytes,
        stream.statusCode,
        headers: stream.headers,
      );
    }

    final response =
        await (isUsage
                ? usageRequest()
                : body == null
                ? client.get(uri)
                : client.post(
                    uri,
                    headers: {
                      'Content-Type': 'application/json',
                      'X-Summon-Lab': 'synthetic',
                    },
                    body: jsonEncode(body),
                  ))
            .timeout(
              Duration(
                seconds: ['sense', 'speak', 'route-speak'].contains(action)
                    ? 95
                    : 10,
              ),
            );
    final data = jsonDecode(utf8.decode(response.bodyBytes));
    if (response.statusCode >= 400 || (isUsage && response.statusCode != 200)) {
      throw ApiFailure(
        response.statusCode,
        data is Map && data['error'] is String ? data['error'] : 'scene_failed',
      );
    }
    if (action.startsWith('dish-') ||
        action == 'usage' ||
        action.startsWith('usage-') ||
        action.startsWith('interaction-') ||
        action.startsWith('handoff-') ||
        action.startsWith('sense') ||
        action == 'speak' ||
        action == 'route-speak' ||
        action == 'focus-status') {
      if (data is! Map<String, dynamic>) {
        throw const ApiFailure(502, 'invalid_sense_response');
      }
      return data;
    }
    if (data is! Map<String, dynamic> ||
        data['mode'] != 'deterministic-synthetic' ||
        data['creatures'] is! List) {
      throw const ApiFailure(502, 'invalid_scene_state');
    }
    return data;
  }
}

class SceneExperiment extends StatefulWidget {
  const SceneExperiment({
    super.key,
    this.client,
    this.workbenchOnly = false,
    this.onStateChanged,
  });
  final ValueChanged<Map<String, dynamic>>? onStateChanged;
  final bool workbenchOnly;
  final http.Client? client;
  @override
  State<SceneExperiment> createState() => _SceneExperimentState();
}

class _SceneExperimentState extends State<SceneExperiment> {
  late final http.Client _client;
  late final SceneExperimentApi _api;
  Map<String, dynamic>? _state;
  bool _busy = false;
  String? _error;
  final ChoiceDraft _draft = ChoiceDraft();
  @override
  void initState() {
    super.initState();
    _client = widget.client ?? http.Client();
    _api = SceneExperimentApi(_client);
    _request('state');
  }

  Future<void> _request(String action, [Map<String, dynamic>? body]) async {
    if (_busy) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final state = await _api.request(action, body);
      if (!mounted) return;
      setState(() {
        _state = state;
        _draft.reconcile(
          state['choiceForms']?['account'],
          state,
          'synthetic-account.v1',
          acknowledged: action == 'form-update',
        );
      });
      widget.onStateChanged?.call(state);
    } catch (error) {
      if (error is ApiFailure &&
          [
            'revision_conflict',
            'activity_conflict',
            'form_binding_conflict',
          ].contains(error.code)) {
        _draft.stale = true;
        try {
          final fresh = await _api.request('state');
          if (mounted) {
            _state = fresh;
            widget.onStateChanged?.call(fresh);
            _draft.reconcile(
              fresh['choiceForms']?['account'],
              fresh,
              'synthetic-account.v1',
            );
          }
        } catch (_) {
          /* Retain the original conflict; never retry a mutation. */
        }
      }
      if (mounted) {
        setState(
          () => _error = error is ApiFailure ? error.code : '本机实验服务不可用或响应无效',
        );
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  void dispose() {
    if (widget.client == null) _client.close();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final activity = _state?['activity'];
    final visible = activity is Map && activity['sceneVisible'] == true;
    final completed = activity is Map && activity['receipt'] != null;
    final revision = activity is Map ? activity['revision'] : null;
    final editable =
        activity is Map &&
        activity['status'] == 'draft' &&
        _state?['activeCreatureId'] == 'work' &&
        _error == null;
    final ready = _draft.ready;
    return Scaffold(
      appBar: widget.workbenchOnly ? null : AppBar(title: const Text('合成情境实验')),
      body: SingleChildScrollView(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            if (!widget.workbenchOnly)
              const Text(
                '确定性合成情境：没有真实传感器、LLM 或银行操作。仅连接本机 127.0.0.1:8091，无生产鉴权。请勿输入真实个人信息。',
              ),
            if (_busy) const LinearProgressIndicator(),
            if (_error != null)
              Text('操作未确认：$_error。请刷新核对状态后再操作。', key: const Key('scene-error')),
            OutlinedButton(
              key: const Key('scene-refresh'),
              onPressed: _busy ? null : () => _request('state'),
              child: const Text('刷新 / 恢复本机状态'),
            ),
            if (_state != null) ...[
              if (!widget.workbenchOnly)
                for (final creature in (_state!['creatures'] as List).take(10))
                  if (creature is Map && creature['name'] is String)
                    Text(
                      '${creature['id'] == _state!['activeCreatureId'] ? '当前生物：' : '生物：'}${creature['name']}',
                    ),
              if (!widget.workbenchOnly)
                for (final event in const [
                  ('hearing', 'work-context', '模拟听觉：进入工作情境'),
                  ('vision', 'work-context', '模拟视觉：看见工作情境'),
                  ('hearing', 'account-request', '模拟听觉：请求合成账户表单'),
                  ('vision', 'personal-context', '模拟视觉：回到伙伴情境'),
                ])
                  OutlinedButton(
                    key: Key('scene-${event.$2}-${event.$1}'),
                    onPressed: _busy || _error != null
                        ? null
                        : () => _request('perceive', {
                            'modality': event.$1,
                            'signal': event.$2,
                          }),
                    child: Text(event.$3),
                  ),
              if (activity == null ||
                  (activity is Map &&
                      [
                        'completed',
                        'expired',
                        'cancelled',
                      ].contains(activity['status'])))
                OutlinedButton(
                  key: const Key('scene-new'),
                  onPressed: _busy || _error != null
                      ? null
                      : () => _request('new', {
                          'previousActivityId': activity is Map
                              ? activity['id']
                              : null,
                        }),
                  child: const Text('创建全新合成任务（旧任务归档）'),
                ),
              if (activity is Map) ...[
                if (['draft', 'submitting'].contains(activity['status']))
                  OutlinedButton(
                    key: const Key('scene-cancel'),
                    onPressed: _busy || _error != null
                        ? null
                        : () => _request('cancel', {
                            'activityId': activity['id'],
                          }),
                    child: Text(
                      activity['status'] == 'submitting'
                          ? '取消未派发任务（已派发则须核对）'
                          : '取消此合成任务，保留历史',
                    ),
                  ),
                if (['uncertain', 'submitting'].contains(activity['status']))
                  OutlinedButton(
                    key: const Key('scene-reconcile'),
                    onPressed: _busy || _error != null || revision is! int
                        ? null
                        : () => _request('submit', {
                            'activityId': activity['id'],
                            'expectedRevision': revision,
                          }),
                    child: Text(
                      activity['status'] == 'uncertain'
                          ? '核对此前提交（不创建新任务）'
                          : '恢复此前提交（同一任务）',
                    ),
                  ),
                if (activity['status'] == 'expired')
                  const Text('任务已过期，不能续期或提交。可新建空白任务。'),
                if (activity['status'] == 'cancelled')
                  const Text('任务已取消，历史保留。可新建空白任务。'),
                Text(
                  '任务 ${activity['id']} · ${activity['status']} · 修订 $revision',
                ),
                Text(
                  _state?['activeCreatureId'] != 'work'
                      ? '工作任务已收为摘要，切回工作情境可恢复；数据仍保留。'
                      : visible
                      ? '视图已显示，任务由内核保留。'
                      : '视图已隐藏，任务仍保留在内核。',
                ),
                OutlinedButton(
                  key: const Key('scene-visibility'),
                  onPressed: _busy || _error != null
                      ? null
                      : () => _request(visible ? 'hide' : 'show', {
                          'activityId': activity['id'],
                        }),
                  child: Text(visible ? '隐藏视图，保留任务' : '恢复任务视图'),
                ),
                if (visible &&
                    _state?['activeCreatureId'] == 'work' &&
                    completed)
                  Text(
                    activity['status'] == 'completed'
                        ? '合成任务已提交：仅实验回执，没有开立真实账户。'
                        : '合成任务结果未确认，请刷新核对，勿重复提交。',
                    key: Key('scene-receipt'),
                  ),
                if (visible && _state?['activeCreatureId'] == 'work') ...[
                  ChoiceForm(
                    draft: _draft,
                    disabled: _busy,
                    fieldKey: (id) =>
                        'scene-field-$id-${activity['id']}-$revision',
                    onChanged: () => setState(() {
                      if (!_draft.stale) _error = null;
                    }),
                  ),
                  if (activity['status'] == 'draft')
                    FilledButton(
                      key: const Key('scene-save'),
                      onPressed:
                          _busy || !editable || !ready || revision is! int
                          ? null
                          : () => _request('form-update', _draft.submission()),
                      child: const Text('保存合成表单'),
                    ),
                  if (activity['status'] == 'draft')
                    FilledButton(
                      key: const Key('scene-submit'),
                      onPressed:
                          _busy ||
                              !editable ||
                              !ready ||
                              revision is! int ||
                              !_draft.saved
                          ? null
                          : () => _request('submit', {
                              'activityId': activity['id'],
                              'expectedRevision': revision,
                            }),
                      child: const Text('提交已保存的合成任务'),
                    ),
                ],
              ],
            ],
          ],
        ),
      ),
    );
  }
}
