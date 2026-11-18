import 'dart:convert';
import 'dart:math';

import 'package:material_ui/material_ui.dart';

import 'api.dart';

class TasksPage extends StatefulWidget {
  const TasksPage({
    super.key,
    required this.api,
    required this.subjectId,
    required this.subjectName,
  });
  final SummonApi api;
  final String subjectId, subjectName;
  @override
  State<TasksPage> createState() => _TasksPageState();
}

class _TasksPageState extends State<TasksPage> {
  final _delay = TextEditingController(text: '60'),
      _purpose = TextEditingController();
  String _kind = 'timer', _status = '正在读取任务与回执…';
  String? _requestId, _signature;
  bool _busy = false,
      _fresh = false,
      _canSchedule = false,
      _hasConnector = false;
  List<dynamic> _tasks = [], _results = [];
  int? get _seconds => int.tryParse(_delay.text);
  bool get _validDelay =>
      _seconds != null && _seconds! >= 1 && _seconds! <= 86400;
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) _run(_refresh);
    });
  }

  Future<void> _refresh() async {
    final state = await widget.api.request('/v1/kernel/state');
    if (!mounted) return;
    final subjects = (state['subjects'] as List).where(
      (s) => s['id'] == widget.subjectId,
    );
    final subject = subjects.isEmpty ? null : subjects.first;
    setState(() {
      _canSchedule =
          subject != null &&
          subject['status'] == 'active' &&
          (subject['aibm']['serviceAbilities'] as List).contains(
            'local.report',
          );
      _hasConnector = (state['connectors'] as List? ?? []).any(
        (c) => c['subjectId'] == widget.subjectId,
      );
      _tasks = (state['tasks'] as List)
          .where((t) => t['subjectId'] == widget.subjectId)
          .toList();
      _results = (state['results'] as List)
          .where((r) => r['subjectId'] == widget.subjectId)
          .toList()
          .reversed
          .toList();
      _fresh = true;
      _status = '状态已刷新。回执只是本地任务结果，不是已投递通知。';
    });
  }

  Future<void> _run(Future<void> Function() action) async {
    if (_busy) return;
    setState(() => _busy = true);
    try {
      await action();
    } catch (e) {
      if (mounted) {
        setState(() {
          _fresh = false;
          _status = '请求未完成${e is ApiFailure ? '：${e.code}' : ''}。请先刷新核对，再重试。';
        });
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _schedule() async {
    if (!_fresh || !_canSchedule || (_kind == 'timer' && !_validDelay)) return;
    final trigger = _kind == 'timer'
        ? <String, dynamic>{'kind': 'timer', 'delayMs': _seconds! * 1000}
        : <String, dynamic>{'kind': 'event', 'type': 'connector.lost'};
    final signature = jsonEncode([
      widget.subjectId,
      trigger,
      _purpose.text.trim(),
    ]);
    if (signature != _signature || _requestId == null) {
      final random = Random.secure();
      _requestId = List.generate(
        16,
        (_) => random.nextInt(256).toRadixString(16).padLeft(2, '0'),
      ).join();
      _signature = signature;
    }
    final result = await widget.api.request(
      '/v1/kernel/tasks',
      body: {
        'subjectId': widget.subjectId,
        'serviceId': 'local.report',
        'trigger': trigger,
        'payload': {'purpose': _purpose.text.trim()},
        'requestId': _requestId,
      },
    );
    if (!mounted) return;
    await _refresh();
    if (mounted) {
      setState(() {
        _purpose.clear();
        _requestId = null;
        _signature = null;
        _status = result['replayed'] == true
            ? '已确认此前安排；以下为刷新后的当前状态。'
            : '任务已安排。离开页面后仍由服务进程调度，停止服务进程则不会运行。';
      });
    }
  }

  Future<void> _cancel(String taskId) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('取消待执行任务？'),
        content: const Text('取消后不再执行；已有回执保留。任务可能已经完成，最终以服务端刷新状态为准。'),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('保留任务'),
          ),
          TextButton(
            onPressed: () => Navigator.pop(context, true),
            child: const Text('确认取消'),
          ),
        ],
      ),
    );
    if (!mounted || confirmed != true) return;
    await widget.api.request(
      '/v1/kernel/cancellations',
      body: {'taskId': taskId},
    );
    if (mounted) await _refresh();
  }

  String _timing(Map<dynamic, dynamic> task) {
    final trigger = task['trigger'] as Map;
    if (trigger['kind'] == 'timer') {
      final interval = trigger['intervalMs'];
      final kind = interval is num ? '周期定时：每 ${interval / 1000} 秒' : '一次性定时';
      return '$kind\n${task['dueAt'] == null ? '当前无待执行时间' : '下一次 UTC：${_deadline(task['dueAt'])}'}';
    }
    final kind = trigger['repeat'] == true ? '重复事件等待' : '一次事件等待';
    return '$kind：${trigger['type']}\n${task['dueAt'] == null ? '等待新事件' : '已排队 UTC：${_deadline(task['dueAt'])}'}';
  }

  String _deadline(dynamic value) {
    if (value is! int) return '未知时间';
    try {
      return DateTime.fromMillisecondsSinceEpoch(
        value,
        isUtc: true,
      ).toIso8601String();
    } on ArgumentError {
      return '$value（超出时间显示范围）';
    }
  }

  @override
  void dispose() {
    _delay.dispose();
    _purpose.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(title: const Text('持续任务与回执')),
    body: SafeArea(
      child: SingleChildScrollView(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(widget.subjectName),
            const Text(
              '仅运行 local.report：不广播、不发消息、不控制设备、不调用付费模型。本页仅新建一次性任务；已有周期任务按下方周期显示。后台依赖服务进程存活。',
            ),
            if (_busy) const LinearProgressIndicator(),
            Text(_status, key: const Key('tasks-status')),
            TextButton(
              key: const Key('refresh-tasks'),
              onPressed: _busy ? null : () => _run(_refresh),
              child: const Text('刷新任务与回执'),
            ),
            if (!_canSchedule && _fresh) const Text('主体不活跃或未挂载本地回执，不能安排新任务。'),
            DropdownButton<String>(
              key: const Key('task-trigger'),
              value: _kind,
              isExpanded: true,
              items: const [
                DropdownMenuItem(value: 'timer', child: Text('一次性延时（服务端计时）')),
                DropdownMenuItem(value: 'event', child: Text('等待一次模拟连接失联')),
              ],
              onChanged: _busy || !_fresh
                  ? null
                  : (value) => setState(() => _kind = value!),
            ),
            if (_kind == 'timer')
              TextField(
                key: const Key('task-delay'),
                controller: _delay,
                enabled: !_busy && _fresh,
                keyboardType: TextInputType.number,
                onChanged: (_) => setState(() {}),
                decoration: const InputDecoration(labelText: '延时秒数（1–86400）'),
              ),
            if (_kind == 'event')
              Text(
                _hasConnector
                    ? '只等待安排后观察到的失联；当前已失联不会自动回放旧事件。'
                    : '还没有模拟连接报告，任务可能一直等待。不会自动连接设备或制造失联事件。',
              ),
            TextField(
              key: const Key('task-purpose'),
              controller: _purpose,
              enabled: !_busy && _fresh,
              maxLength: 1000,
              decoration: const InputDecoration(labelText: '回执说明（可选）'),
            ),
            FilledButton(
              key: const Key('schedule-task'),
              onPressed:
                  _busy ||
                      !_fresh ||
                      !_canSchedule ||
                      (_kind == 'timer' && !_validDelay)
                  ? null
                  : () => _run(_schedule),
              child: const Text('明确安排一次本地任务'),
            ),
            const Divider(),
            const Text('已安排的任务'),
            ..._tasks.map(
              (t) => Card(
                child: ListTile(
                  title: Text('${t['status']} · ${t['serviceId']}'),
                  subtitle: Text('任务 ${t['id']}\n${_timing(t as Map)}'),
                  trailing: ['completed', 'cancelled'].contains(t['status'])
                      ? null
                      : IconButton(
                          key: Key('cancel-${t['id']}'),
                          tooltip: '取消任务',
                          icon: const Icon(Icons.cancel_outlined),
                          onPressed: _busy || !_fresh
                              ? null
                              : () => _run(() => _cancel(t['id'] as String)),
                        ),
                ),
              ),
            ),
            const Text('本地回执（最近在前）'),
            ..._results.map(
              (r) => Card(
                child: ListTile(
                  key: Key('result-${r['id']}'),
                  title: Text(r['notice'] as String),
                  subtitle: Text(
                    '任务 ${r['taskId']}\n${r['payload']['purpose'] ?? ''}',
                  ),
                ),
              ),
            ),
          ],
        ),
      ),
    ),
  );
}
