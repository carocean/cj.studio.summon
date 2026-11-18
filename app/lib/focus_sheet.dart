import 'dart:convert';
import 'dart:math';

import 'package:material_ui/material_ui.dart';
import 'package:http/http.dart' as http;

import 'api.dart';
import 'choice_form.dart';
import 'scene_experiment.dart';

/// In-memory recovery belongs to the Home session, not a widget's visibility.
class FocusRecovery {
  String? requestId;
  Map<String, dynamic>? binding;
  Map<String, String>? values;
  void clear() {
    requestId = null;
    binding = null;
    values = null;
  }
}

bool _int(dynamic v) => v is int && v >= 0 && v <= 9007199254740991;
bool _id(dynamic v) =>
    v is String && RegExp(r'^[A-Za-z][A-Za-z0-9.-]{0,63}$').hasMatch(v);
bool _closed(dynamic v, Set<String> keys) =>
    v is Map && v.length == keys.length && v.keys.every(keys.contains);
bool _inputs(dynamic v) =>
    _closed(v, {'topic', 'duration', 'pace'}) &&
    choiceContracts['synthetic-focus.v1']!.entries.every(
      (e) => e.value.contains(v[e.key]),
    );
bool _sameInput(Map a, Map b) =>
    ['topic', 'duration', 'pace'].every((k) => a[k] == b[k]);
Map<String, dynamic>? validatedFocusPlan(dynamic raw) {
  try {
    if (!_closed(raw, {
          'planId',
          'requestId',
          'creatureId',
          'serviceId',
          'input',
          'createdAt',
          'dueAt',
          'status',
          'receipt',
        }) ||
        !_id(raw['planId']) ||
        !_id(raw['requestId']) ||
        !_id(raw['creatureId']) ||
        raw['serviceId'] != 'synthetic.focus.v1' ||
        !_inputs(raw['input']) ||
        !_int(raw['createdAt']) ||
        !_int(raw['dueAt']) ||
        raw['dueAt'] - raw['createdAt'] !=
            int.parse(raw['input']['duration']) * 60000 ||
        !['active', 'elapsed', 'cancelled'].contains(raw['status'])) {
      return null;
    }
    final r = raw['receipt'];
    if (!_closed(r, {
          'receiptId',
          'fact',
          'source',
          'serviceId',
          'serviceVersion',
          'requestId',
          'planId',
          'creatureId',
          'input',
          'createdAt',
          'dueAt',
        }) ||
        !_id(r['receiptId']) ||
        r['fact'] != 'plan_saved' ||
        r['source'] != 'deterministic-synthetic-focus' ||
        r['serviceVersion'] != 1 ||
        !_inputs(r['input']) ||
        !_sameInput(r['input'], raw['input']) ||
        [
          'serviceId',
          'requestId',
          'planId',
          'creatureId',
          'createdAt',
          'dueAt',
        ].any((k) => r[k] != raw[k])) {
      return null;
    }
    return jsonDecode(jsonEncode(raw));
  } catch (_) {
    return null;
  }
}

class FocusSheet extends StatefulWidget {
  const FocusSheet({super.key, required this.client, required this.recovery});
  final http.Client client;
  final FocusRecovery recovery;
  @override
  State<FocusSheet> createState() => _FocusSheetState();
}

class _FocusSheetState extends State<FocusSheet> {
  late final SceneExperimentApi _api;
  final ChoiceDraft _draft = ChoiceDraft();
  Map<String, dynamic>? _state;
  bool _busy = false;
  String? _error, _notice;
  @override
  void initState() {
    super.initState();
    _api = SceneExperimentApi(widget.client);
    _request('state');
  }

  void _reconcile(Map<String, dynamic> state) {
    _state = state;
    _draft.reconcile(
      state['choiceForms']?['focus'],
      state,
      'synthetic-focus.v1',
    );
    final recovery = widget.recovery, id = recovery.requestId;
    if (id == null) return;
    final requests = state['focus']?['requests'];
    final matching = requests is List
        ? requests.where((r) => r is Map && r['requestId'] == id).toList()
        : [];
    if (matching.length != 1) {
      _notice = '请求 $id：结果未知，不会重新派发。';
      return;
    }
    final request = matching.single;
    if (request['status'] == 'cancelled') {
      _notice = '请求 $id 已取消。创建回执如已存在仍是历史事实，不表示用户完成。';
      recovery.clear();
      return;
    }
    if (request['status'] == 'completed') {
      final plans = state['focus']?['plans'];
      final matchingPlans = plans is List
          ? plans
                .where(
                  (p) =>
                      p is Map &&
                      p['requestId'] == id &&
                      p['planId'] == request['planId'],
                )
                .toList()
          : [];
      final plan = matchingPlans.length == 1
          ? validatedFocusPlan(matchingPlans.single)
          : null;
      if (plan != null &&
          plan['creatureId'] == recovery.binding?['targetCreatureId'] &&
          recovery.values != null &&
          _sameInput(plan['input'], recovery.values!)) {
        _notice = '请求 $id 的计划已保存。回执只证明保存，不代表完成专注。';
        recovery.clear();
        return;
      }
    }
    _notice = '请求 $id 尚未取得匹配的计划回执，请查询或放弃，不自动重派。';
  }

  Future<void> _request(String action, [Map<String, dynamic>? body]) async {
    if (_busy) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final state = await _api.request(action, body);
      // Preserve recovery even if the sheet is closed while the response is in flight.
      if (!mounted) return;
      setState(() => _reconcile(state));
    } catch (error) {
      if (error is ApiFailure &&
          ['form_binding_conflict', 'revision_conflict'].contains(error.code)) {
        _draft.stale = true;
        try {
          final state = await _api.request('state');
          if (mounted) _reconcile(state);
        } catch (_) {}
      }
      if (mounted) {
        setState(
          () => _error =
              '结果未确认：${error is ApiFailure ? error.code : '本机连接异常'}。不会自动重提；请查询或放弃当前请求。',
        );
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _queryRecovery() async {
    final recovery = widget.recovery, id = widget.recovery.requestId;
    if (_busy || id == null) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final report = await _api.request('focus-status', {'requestId': id});
      if (!mounted || recovery.requestId != id) return;
      if (!_closed(report, {'requestId', 'status', 'plan'}) ||
          report['requestId'] != id ||
          ![
            'not_started',
            'completed',
            'cancelled',
          ].contains(report['status'])) {
        throw StateError('invalid_focus_status');
      }
      final plan = validatedFocusPlan(report['plan']);
      if (report['status'] == 'completed') {
        if (plan == null ||
            plan['requestId'] != id ||
            plan['creatureId'] != recovery.binding?['targetCreatureId'] ||
            recovery.values == null ||
            !_sameInput(plan['input'], recovery.values!)) {
          throw StateError('focus_receipt_mismatch');
        }
        _notice = '请求 $id 已保存计划（当前状态：${plan['status']}）。保存事实不等于用户完成。';
        recovery.clear();
      } else if (report['status'] == 'cancelled' && report['plan'] == null) {
        _notice = '请求 $id 已被取消；不会重新派发。';
        recovery.clear();
      } else if (report['status'] == 'not_started' && report['plan'] == null) {
        _notice = '请求 $id 尚未开始。不会新建 ID 或自动重派；可显式放弃。';
      } else {
        throw StateError('invalid_focus_status');
      }
      final fresh = await _api.request('state');
      if (mounted) {
        setState(() {
          _state = fresh;
          _draft.reconcile(
            fresh['choiceForms']?['focus'],
            fresh,
            'synthetic-focus.v1',
          );
        });
      }
    } catch (_) {
      if (mounted) setState(() => _error = '请求核对结果未知，不自动重派。');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final focus = _state?['focus'],
        grant = focus is Map ? focus['grant'] : null;
    final primary = _state?['primaryCreatureId'];
    final current =
        primary is String &&
        primary == _state?['activeCreatureId'] &&
        focus is Map &&
        focus['primaryCreatureId'] == primary;
    final grantValid =
        current &&
        grant is Map &&
        grant['creatureId'] == primary &&
        grant['enabled'] is bool &&
        _int(grant['revision']) &&
        _int(grant['generation']);
    final plans = focus is Map ? focus['plans'] : null;
    return SafeArea(
      child: SingleChildScrollView(
        padding: const EdgeInsets.all(20),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text('一起专注', style: Theme.of(context).textTheme.headlineSmall),
            const Text('本机合成计划记录。不发送通知、不限制应用、不联网、不收费。时长与节奏只是计划参数，回执不是用户完成证明。'),
            const Text('未确认请求在此生物空间会话内保留，关闭重开可核对；应用进程重启不保证保留尚未到达服务器的请求。'),
            if (_busy) const LinearProgressIndicator(),
            if (_error != null) Text(_error!, key: const Key('focus-error')),
            if (_notice != null) Text(_notice!, key: const Key('focus-notice')),
            TextButton(
              key: const Key('focus-refresh'),
              onPressed: _busy
                  ? null
                  : () => widget.recovery.requestId != null
                        ? _queryRecovery()
                        : _request('state'),
              child: const Text('查询计划与请求状态'),
            ),
            if (!current) const Text('当前不是主生物。可查询或取消旧计划；请返回伙伴面板明确选择主生物后新建。'),
            if (grantValid)
              SwitchListTile(
                key: const Key('focus-grant'),
                title: const Text('允许当前主生物保存本机专注计划'),
                subtitle: const Text('独立服务权限，不开启感官、不自动创建。'),
                value: grant['enabled'],
                onChanged: _busy || widget.recovery.requestId != null
                    ? null
                    : (value) => _request('focus-grant', {
                        'creatureId': primary,
                        'enabled': value,
                        'expectedRevision': grant['revision'],
                      }),
              ),
            if (widget.recovery.requestId != null) ...[
              Text('待核对请求：${widget.recovery.requestId}'),
              OutlinedButton(
                key: const Key('focus-abandon'),
                onPressed: _busy
                    ? null
                    : () => _request('focus-cancel', {
                        'requestId': widget.recovery.requestId,
                      }),
                child: const Text('放弃此请求（不重新派发）'),
              ),
            ],
            if (current && focus['activePlan'] == null) ...[
              ChoiceForm(
                draft: _draft,
                disabled: _busy || widget.recovery.requestId != null,
                onChanged: () => setState(() {}),
              ),
              if (focus['activePlan'] == null)
                FilledButton(
                  key: const Key('focus-create'),
                  onPressed:
                      _busy ||
                          !_draft.ready ||
                          widget.recovery.requestId != null
                      ? null
                      : () {
                          final id =
                              'focus-${DateTime.now().microsecondsSinceEpoch.toRadixString(36)}-${Random().nextInt(1048576)}';
                          widget.recovery.requestId = id;
                          widget.recovery.binding = Map<String, dynamic>.from(
                            _draft.current!['binding'],
                          );
                          widget.recovery.values = Map.of(_draft.values);
                          _request('form-focus', {
                            ..._draft.submission(),
                            'requestId': id,
                          });
                        },
                  child: const Text('确认保存这份合成计划'),
                ),
            ],
            if (plans is List)
              for (final raw in [
                if (focus['activePlan'] is Map &&
                    !plans.any(
                      (p) =>
                          p is Map &&
                          p['planId'] == focus['activePlan']['planId'],
                    ))
                  focus['activePlan'],
                ...plans.take(4),
              ])
                if (validatedFocusPlan(raw) != null)
                  Card(
                    child: Padding(
                      padding: const EdgeInsets.all(12),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.stretch,
                        children: [
                          Text('计划保存回执 · ${raw['creatureId']}'),
                          Text(
                            '${raw['input']['topic']} · ${raw['input']['duration']} 分钟 · ${raw['input']['pace']}',
                          ),
                          Text(
                            '状态：${raw['status'] == 'active'
                                ? '计划时间内'
                                : raw['status'] == 'elapsed'
                                ? '计划时间已过（不代表完成）'
                                : '已取消'}',
                          ),
                          Text('回执：${raw['receipt']['receiptId']}'),
                          if (raw['status'] == 'active')
                            TextButton(
                              key: Key('focus-cancel-${raw['requestId']}'),
                              onPressed: _busy
                                  ? null
                                  : () => _request('focus-cancel', {
                                      'requestId': raw['requestId'],
                                    }),
                              child: const Text('取消这份计划（保留保存回执）'),
                            ),
                        ],
                      ),
                    ),
                  ),
          ],
        ),
      ),
    );
  }
}
