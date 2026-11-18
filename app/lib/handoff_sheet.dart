import 'dart:convert';

import 'package:material_ui/material_ui.dart';
import 'package:http/http.dart' as http;

import 'scene_experiment.dart';
import 'creature_registry.dart';

bool _closed(dynamic v, Set<String> keys) =>
    v is Map && v.length == keys.length && v.keys.every(keys.contains);
bool _id(dynamic v) =>
    v is String && RegExp(r'^[A-Za-z][A-Za-z0-9.-]{0,63}$').hasMatch(v);
bool _int(dynamic v) => v is int && v >= 0 && v <= 9007199254740991;
bool _hash(dynamic v) =>
    v is String && RegExp(r'^sha256:[a-f0-9]{64}$').hasMatch(v);
const _statuses = {
  'prepared',
  'running',
  'delivered',
  'blocked',
  'expired',
  'cancelled',
  'invalidating',
};
const _values = {
  'customerAlias': ['demo-a', 'demo-b'],
  'accountType': ['daily', 'savings'],
  'contactPreference': ['none', 'demo-email'],
};
bool _inputs(dynamic v) =>
    _closed(v, _values.keys.toSet()) &&
    _values.entries.every((e) => e.value.contains(v[e.key]));
bool _receipt(dynamic r, String handoffId, int expiry) =>
    _closed(r, {
      'schema',
      'mailId',
      'sender',
      'recipientId',
      'artifactId',
      'artifactDigest',
      'contextDigest',
      'purpose',
      'deliveredAt',
      'retentionUntil',
      'fact',
    }) &&
    r['schema'] == 'local-artifact-delivery.v1' &&
    r['fact'] == 'local_recipient_copy_saved' &&
    r['purpose'] == 'draft-return' &&
    _id(r['mailId']) &&
    _id(r['sender']) &&
    _id(r['recipientId']) &&
    r['sender'] != r['recipientId'] &&
    r['artifactId'] == 'ha-${handoffId.substring(8)}' &&
    _hash(r['artifactDigest']) &&
    _hash(r['contextDigest']) &&
    _int(r['deliveredAt']) &&
    r['retentionUntil'] == expiry &&
    r['deliveredAt'] < expiry;
bool _base(Map h) =>
    h['handoffId'] is String &&
    RegExp(r'^handoff-[a-f0-9]{48}$').hasMatch(h['handoffId']) &&
    _statuses.contains(h['status']) &&
    _id(h['coordinatorId']) &&
    h['coordinatorId'] != 'work' &&
    h['workerId'] == 'work' &&
    _int(h['expiresAt']) &&
    (h['status'] == 'delivered'
        ? _receipt(h['receipt'], h['handoffId'], h['expiresAt'])
        : h['receipt'] == null);
Map<String, dynamic>? validatedHandoff(dynamic raw) {
  if (!_closed(raw, {'mode', 'contentReturned', 'handoff'}) ||
      raw['mode'] != 'deterministic-synthetic-draft-return' ||
      raw['contentReturned'] != false) {
    return null;
  }
  final h = raw['handoff'];
  if (!_closed(h, {
        'handoffId',
        'status',
        'coordinatorId',
        'workerId',
        'values',
        'binding',
        'expiresAt',
        'budget',
        'reason',
        'receipt',
      }) ||
      !_base(h) ||
      !_inputs(h['values']) ||
      !(h['reason'] == null ||
          [
            'binding_changed',
            'authority_withdrawn',
            'source_withdrawn',
            'deadline_observed',
            'owner_cancelled',
          ].contains(h['reason']))) {
    return null;
  }
  final b = h['binding'], budget = h['budget'];
  if (!_closed(b, {
        'ownerId',
        'coordinatorId',
        'workerId',
        'registryRevision',
        'context',
        'activityId',
        'activityRevision',
        'valuesDigest',
      }) ||
      !_id(b['ownerId']) ||
      b['coordinatorId'] != h['coordinatorId'] ||
      b['workerId'] != 'work' ||
      !_int(b['registryRevision']) ||
      b['registryRevision'] < 1 ||
      !_closed(b['context'], {'creatureId', 'sceneRevision'}) ||
      b['context']['creatureId'] != h['coordinatorId'] ||
      !_int(b['context']['sceneRevision']) ||
      b['context']['sceneRevision'] < 1 ||
      !_id(b['activityId']) ||
      !_int(b['activityRevision']) ||
      b['activityRevision'] < 1 ||
      !_hash(b['valuesDigest']) ||
      !_closed(budget, {'calls', 'bytes'}) ||
      budget['calls'] != 3 ||
      !_int(budget['bytes']) ||
      budget['bytes'] < 1 ||
      budget['bytes'] !=
          3 *
              utf8
                  .encode(
                    jsonEncode({
                      for (final k in (_values.keys.toList()..sort()))
                        k: h['values'][k],
                    }),
                  )
                  .length) {
    return null;
  }
  return Map<String, dynamic>.from(h);
}

List<Map<String, dynamic>>? validatedHandoffList(dynamic raw) {
  if (!_closed(raw, {'handoffs', 'limit', 'contentReturned'}) ||
      raw['limit'] != 32 ||
      raw['contentReturned'] != false ||
      raw['handoffs'] is! List ||
      raw['handoffs'].length > 32) {
    return null;
  }
  final result = <Map<String, dynamic>>[], ids = <String>{};
  for (final h in raw['handoffs']) {
    if (!_closed(h, {
          'handoffId',
          'status',
          'coordinatorId',
          'workerId',
          'activityId',
          'expiresAt',
          'receipt',
        }) ||
        !_base(h) ||
        !_id(h['activityId']) ||
        !ids.add(h['handoffId'])) {
      return null;
    }
    result.add(Map<String, dynamic>.from(h));
  }
  return result;
}

bool canPrepareHandoff(Map<String, dynamic>? s) {
  final task = s?['activity'];
  if (s == null ||
      s['mode'] != 'deterministic-synthetic' ||
      !_id(s['primaryCreatureId']) ||
      s['primaryCreatureId'] == 'work' ||
      s['activeCreatureId'] != s['primaryCreatureId'] ||
      registeredCreature(s, s['primaryCreatureId']) == null ||
      registeredCreature(s, 'work') == null ||
      task is! Map ||
      task['status'] != 'draft' ||
      task['form'] is! Map ||
      task['form']['fields'] is! List) {
    return false;
  }
  final values = <String, dynamic>{};
  for (final f in task['form']['fields']) {
    if (f is! Map || f['id'] is! String || values.containsKey(f['id'])) {
      return false;
    }
    values[f['id']] = f['value'];
  }
  return _inputs(values) &&
      s['context'] is Map &&
      s['context']['creatureId'] == s['primaryCreatureId'];
}

bool handoffMatchesScene(Map h, Map<String, dynamic>? s) {
  if (!canPrepareHandoff(s)) return false;
  final b = h['binding'], task = s!['activity'];
  final values = {for (final f in task['form']['fields']) f['id']: f['value']};
  return s['primaryCreatureId'] == h['coordinatorId'] &&
      s['registryRevision'] == b['registryRevision'] &&
      s['context']['creatureId'] == b['context']['creatureId'] &&
      s['context']['sceneRevision'] == b['context']['sceneRevision'] &&
      task['id'] == b['activityId'] &&
      task['revision'] == b['activityRevision'] &&
      _values.keys.every((k) => values[k] == h['values'][k]);
}

bool _same(dynamic a, dynamic b) {
  if (a is Map && b is Map) {
    return a.length == b.length &&
        a.keys.every((k) => b.containsKey(k) && _same(a[k], b[k]));
  }
  return a == b;
}

bool _samePlan(Map a, Map b) => [
  'handoffId',
  'coordinatorId',
  'workerId',
  'values',
  'binding',
  'expiresAt',
  'budget',
].every((k) => _same(a[k], b[k]));
String _deadline(int n) => n <= 8640000000000000
    ? DateTime.fromMillisecondsSinceEpoch(n, isUtc: true).toIso8601String()
    : '$n ms（服务时钟）';

class HandoffSheet extends StatefulWidget {
  const HandoffSheet({super.key, required this.client});
  final http.Client client;
  @override
  State<HandoffSheet> createState() => _HandoffSheetState();
}

class _HandoffSheetState extends State<HandoffSheet>
    with WidgetsBindingObserver {
  late final SceneExperimentApi _api;
  Map<String, dynamic>? _scene, _plan;
  List<Map<String, dynamic>> _history = [];
  String? _selected, _message;
  bool _busy = false, _foreground = true, _unknown = false;
  int _epoch = 0;
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _api = SceneExperimentApi(widget.client);
    _run('list');
  }

  bool _current(int e) {
    if (!mounted || !_foreground || e != _epoch) return false;
    if (ModalRoute.of(context)?.isCurrent == false) {
      _epoch++;
      setState(() {
        _unknown = true;
        _busy = false;
        _scene = null;
        _message = '交接期间页面已变化，请核对原交接；不会自动重派。';
      });
      return false;
    }
    return true;
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    _foreground = state == AppLifecycleState.resumed;
    if (!_foreground) {
      _epoch++;
      setState(() {
        _unknown = _unknown || _busy;
        _busy = false;
        _scene = null;
        _message = '已暂停。请核对交接状态，不会自动重派。';
      });
    } else {
      setState(() {});
    }
  }

  Future<void> _run(String action, [String? id]) async {
    if (_busy || !_foreground) return;
    final e = ++_epoch;
    setState(() {
      _busy = true;
      _message = null;
    });
    if (id != null) {
      if (id != _selected) setState(() => _plan = null);
      _selected = id;
    }
    try {
      if (action == 'list') {
        final response = await _api.request('handoff-list', {});
        final history = validatedHandoffList(response);
        if (history == null) throw StateError('invalid history');
        final scene = await _api.request('state');
        if (!_current(e)) return;
        Map<String, dynamic>? plan;
        if (_selected != null) {
          plan = validatedHandoff(
            await _api.request('handoff-status', {'handoffId': _selected}),
          );
          if (plan == null ||
              plan['handoffId'] != _selected ||
              (_plan != null &&
                  _plan!['handoffId'] == _selected &&
                  !_samePlan(plan, _plan!))) {
            throw StateError('invalid status');
          }
        }
        if (!_current(e)) return;
        setState(() {
          _history = history;
          _scene = scene;
          _plan = plan;
          _unknown = false;
        });
      } else {
        if (_unknown && action != 'status' && action != 'cancel') return;
        Map<String, dynamic> response;
        if (action == 'prepare' || action == 'confirm') {
          final scene = await _api.request('state');
          if (!_current(e)) return;
          if (!canPrepareHandoff(scene) ||
              (action == 'confirm' &&
                  (_plan == null || !handoffMatchesScene(_plan!, scene)))) {
            setState(() {
              _scene = scene;
              _unknown = true;
              _message = '主生物或草稿已变化，请核对原交接；不会重新授权。';
            });
            return;
          }
          if (action == 'prepare') {
            setState(() {
              _selected = null;
              _plan = null;
            });
            response = await _api.request('handoff-prepare', {
              'context': scene['context'],
            });
          } else {
            response = await _api.request('handoff-confirm', {
              'handoffId': _selected,
              'confirmation': 'share-synthetic-draft',
            });
          }
          if (!_current(e)) return;
          final plan = validatedHandoff(response);
          if (plan == null ||
              (action == 'confirm' &&
                  (plan['handoffId'] != _selected ||
                      !_samePlan(plan, _plan!))) ||
              (plan['status'] == 'prepared' &&
                  !handoffMatchesScene(plan, scene))) {
            throw StateError('invalid handoff');
          }
          setState(() {
            _scene = scene;
            _plan = plan;
            _selected = plan['handoffId'];
            _unknown = false;
          });
        } else {
          response = await _api.request('handoff-$action', {
            'handoffId': _selected,
          });
          if (!_current(e)) return;
          final plan = validatedHandoff(response);
          if (plan == null ||
              plan['handoffId'] != _selected ||
              (_plan != null &&
                  _plan!['handoffId'] == _selected &&
                  !_samePlan(plan, _plan!))) {
            throw StateError('invalid handoff');
          }
          final scene = await _api.request('state');
          if (!_current(e)) return;
          setState(() {
            _scene = scene;
            _plan = plan;
            _unknown = false;
          });
        }
      }
    } catch (_) {
      if (_current(e)) {
        setState(() {
          _unknown = true;
          _message = '响应未确认或格式不符。请核对列表/原交接，不会自动重派。';
        });
      }
    } finally {
      if (mounted && e == _epoch) setState(() => _busy = false);
    }
  }

  @override
  void dispose() {
    _epoch++;
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final p = _plan, enabled = !_busy && _foreground;
    return SafeArea(
      child: SingleChildScrollView(
        padding: const EdgeInsets.all(20),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            const Text('主生物协调工作伙伴', style: TextStyle(fontSize: 22)),
            const Text('仅回传三个合成字段副本；不是智能审核、真实开户或外部业务。页面不读取主生物邮箱正文。'),
            if (_busy) const LinearProgressIndicator(),
            if (_message != null)
              Text(_message!, key: const Key('handoff-message')),
            OutlinedButton(
              key: const Key('handoff-refresh'),
              onPressed: enabled ? () => _run('list') : null,
              child: const Text('核对交接列表'),
            ),
            if (canPrepareHandoff(_scene) &&
                _plan?['status'] != 'running' &&
                !_history.any(
                  (h) => ['running', 'invalidating'].contains(h['status']),
                ))
              OutlinedButton(
                key: const Key('handoff-prepare'),
                onPressed: enabled && !_unknown ? () => _run('prepare') : null,
                child: const Text('预览当前草稿交接（不授权、不发送）'),
              ),
            if (!canPrepareHandoff(_scene) && !_busy)
              const Text('新交接需要回到非工作主生物，且合成草稿三个字段完整；仍可核对历史。'),
            for (final h in _history.reversed)
              ListTile(
                key: Key('handoff-history-${h['handoffId']}'),
                title: Text('${h['coordinatorId']} → work · ${h['status']}'),
                subtitle: Text(h['handoffId']),
                onTap: enabled ? () => _run('status', h['handoffId']) : null,
              ),
            if (p != null) ...[
              const Divider(),
              Text(
                '原主生物 ${p['coordinatorId']} → 工作生物 work → 原主生物 ${p['coordinatorId']}',
              ),
              Text(
                '任务 ${p['binding']['activityId']} · 版本 ${p['binding']['activityRevision']}',
              ),
              const Text('以下是你原草稿的输入预览，不是工作生物的审核结果：'),
              for (final e in (p['values'] as Map).entries)
                Text('${e.key}: ${e.value}'),
              Text(
                '用途：合成草稿字段回传。单次限额：3 calls / ${p['budget']['bytes']} UTF-8 字节；到期 ${_deadline(p['expiresAt'])}',
              ),
              Text(
                '${_unknown ? '上次已知状态' : '状态'}：${p['status']}',
                key: const Key('handoff-status'),
              ),
              if (['cancelled', 'expired', 'blocked'].contains(p['status']))
                const Text('重新预览不会为相同绑定续期。新的有效草稿版本或情境可准备另一交接。'),
              if (['prepared', 'running'].contains(p['status'])) ...[
                if (p['status'] == 'running')
                  const Text(
                    '这次交接已明确确认，可能已有部分授权；查询不会执行。可继续原ID或取消，不能新建ID绕过未知状态。',
                  ),
                FilledButton(
                  key: const Key('handoff-confirm'),
                  onPressed:
                      enabled && !_unknown && handoffMatchesScene(p, _scene)
                      ? () => _run('confirm')
                      : null,
                  child: Text(
                    p['status'] == 'running'
                        ? '继续这次已确认的交接（同ID）'
                        : '明确授权这份草稿的一次回传',
                  ),
                ),
                OutlinedButton(
                  key: const Key('handoff-cancel'),
                  onPressed: enabled ? () => _run('cancel') : null,
                  child: const Text('取消未交付的交接'),
                ),
              ],
              if (p['status'] == 'delivered') ...[
                const Text(
                  '字段副本已回传到原主生物本机收件箱。不表示用户已查看、审核完成或业务成功。',
                  key: Key('handoff-delivered'),
                ),
                Text(
                  '回执 ${p['receipt']['mailId']}\n来源 ${p['receipt']['sender']}\n接收 ${p['receipt']['recipientId']}',
                ),
              ],
              TextButton(
                key: const Key('handoff-query'),
                onPressed: enabled ? () => _run('status') : null,
                child: const Text('查询这个交接（不重派）'),
              ),
            ],
          ],
        ),
      ),
    );
  }
}
