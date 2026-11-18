import 'dart:convert';
import 'dart:math';

import 'package:material_ui/material_ui.dart';

import 'api.dart';
import 'tasks.dart';

/// Small management surface: no model calls, arbitrary code or outside services.
class SubjectsPage extends StatefulWidget {
  const SubjectsPage({super.key, required this.api});
  final SummonApi api;
  @override
  State<SubjectsPage> createState() => _SubjectsPageState();
}

class _SubjectsPageState extends State<SubjectsPage> {
  final _name = TextEditingController(), _personality = TextEditingController();
  List<dynamic> _subjects = [];
  String? _selectedId, _createRequestId, _createSignature;
  String _space = 'fixed-simulation', _status = '正在读取持久主体…';
  bool _busy = false, _fresh = false;
  Map<String, dynamic>? get _selected {
    for (final s in _subjects) {
      if (s['id'] == _selectedId) return Map<String, dynamic>.from(s);
    }
    return null;
  }

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) _run(_refresh);
    });
  }

  Future<void> _refresh() async {
    final data = await widget.api.request('/v1/kernel/state');
    if (!mounted) return;
    setState(() {
      _subjects = data['subjects'] as List;
      if (!_subjects.any((s) => s['id'] == _selectedId)) {
        _selectedId = _subjects.isEmpty
            ? null
            : _subjects.first['id'] as String;
      }
      _fresh = true;
      _status = '已读取当前持久状态。此页面不会调用模型或外部服务。';
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
          _status =
              '请求未完成${e is ApiFailure ? '：${e.code}' : ''}。请先刷新核对，勿直接重建或重复操作。';
        });
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _create() async {
    if (!_fresh || _name.text.trim().isEmpty) return;
    final signature = jsonEncode([
      _name.text.trim(),
      _personality.text.trim(),
      _space,
    ]);
    if (_createSignature != signature || _createRequestId == null) {
      final random = Random.secure();
      _createRequestId = List.generate(
        16,
        (_) => random.nextInt(256).toRadixString(16).padLeft(2, '0'),
      ).join();
      _createSignature = signature;
    }
    final result = await widget.api.request(
      '/v1/kernel/subjects',
      body: {
        'requestId': _createRequestId,
        'name': _name.text.trim(),
        'personality': _personality.text.trim(),
        'activitySpace': _space,
      },
    );
    if (!mounted) return;
    _selectedId = result['id'] as String;
    // Do not repeat a write if its following read fails.
    await _refresh();
    if (mounted) {
      setState(() {
        _name.clear();
        _personality.clear();
        _createRequestId = null;
        _createSignature = null;
        _status = result['replayed'] == true
            ? '已确认此前的创建请求。当前状态以刷新结果为准。'
            : '主体已创建，尚未挂载任何服务。';
      });
    }
  }

  Future<void> _mount(String serviceId, bool enabled) async {
    final subject = _selected;
    if (!_fresh || subject == null || subject['status'] == 'retired') return;
    if (!enabled) {
      final confirmed = await showDialog<bool>(
        context: context,
        builder: (context) => AlertDialog(
          title: const Text('撤销服务？'),
          content: const Text('撤销后相关未完成任务会被取消；重新挂载不会恢复这些任务。'),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(context, false),
              child: const Text('保留'),
            ),
            TextButton(
              onPressed: () => Navigator.pop(context, true),
              child: const Text('撤销'),
            ),
          ],
        ),
      );
      if (!mounted || confirmed != true) return;
    }
    await widget.api.request(
      '/v1/kernel/mounts',
      body: {
        'subjectId': subject['id'],
        'serviceId': serviceId,
        'enabled': enabled,
      },
    );
    if (!mounted) return;
    await _refresh();
  }

  Future<void> _transition() async {
    final subject = _selected;
    if (!_fresh ||
        subject == null ||
        !['active', 'paused'].contains(subject['status'])) {
      return;
    }
    await widget.api.request(
      '/v1/kernel/transitions',
      body: {
        'subjectId': subject['id'],
        'status': subject['status'] == 'active' ? 'paused' : 'active',
      },
    );
    if (mounted) await _refresh();
  }

  @override
  void dispose() {
    _name.dispose();
    _personality.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final subject = _selected;
    final services = subject?['aibm']['serviceAbilities'] as List? ?? [];
    final writable = !_busy && _fresh;
    return Scaffold(
      appBar: AppBar(title: const Text('主体与服务装配')),
      body: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const Text('主体可跨会话持续存在。活动空间为模拟，不代表定位或真实跟随。只开放能力自述与本地回执的装配。'),
              if (_busy) const LinearProgressIndicator(),
              Text(_status, key: const Key('subjects-status')),
              TextButton(
                key: const Key('refresh-subjects'),
                onPressed: _busy ? null : () => _run(_refresh),
                child: const Text('刷新核对状态'),
              ),
              TextField(
                key: const Key('subject-name'),
                controller: _name,
                enabled: writable,
                maxLength: 200,
                onChanged: (_) => setState(() {}),
                decoration: const InputDecoration(labelText: '主体名称'),
              ),
              TextField(
                key: const Key('subject-personality'),
                controller: _personality,
                enabled: writable,
                maxLength: 1000,
                decoration: const InputDecoration(labelText: '个性描述（可选，不是执行授权）'),
              ),
              DropdownButton<String>(
                value: _space,
                isExpanded: true,
                items: const [
                  DropdownMenuItem(
                    value: 'fixed-simulation',
                    child: Text('固定主体（模拟）'),
                  ),
                  DropdownMenuItem(
                    value: 'follow-owner-simulation',
                    child: Text('跟随所有者（模拟）'),
                  ),
                ],
                onChanged: writable ? (v) => setState(() => _space = v!) : null,
              ),
              FilledButton(
                key: const Key('create-subject'),
                onPressed: writable && _name.text.trim().isNotEmpty
                    ? () => _run(_create)
                    : null,
                child: const Text('创建持久主体（无服务）'),
              ),
              const Divider(),
              if (_subjects.isNotEmpty)
                DropdownButton<String>(
                  key: const Key('choose-subject'),
                  value: _selectedId,
                  isExpanded: true,
                  items: _subjects
                      .map(
                        (s) => DropdownMenuItem<String>(
                          value: s['id'] as String,
                          child: Text(
                            '${s['name']} · ${s['status']}',
                            overflow: TextOverflow.ellipsis,
                          ),
                        ),
                      )
                      .toList(),
                  onChanged: _busy
                      ? null
                      : (v) => setState(() => _selectedId = v),
                ),
              if (subject != null) ...[
                Text('当前主体：${subject['name']}'),
                Text(
                  '状态：${subject['status']} · 挂载：${services.isEmpty ? '无' : services.join('、')}',
                ),
                const Text('暂停会使主体退出服务发现并停止调度；恢复后继续既有任务，不补发错过的周期。'),
                if (subject['status'] != 'retired')
                  OutlinedButton(
                    key: const Key('toggle-lifecycle'),
                    onPressed: writable ? () => _run(_transition) : null,
                    child: Text(
                      subject['status'] == 'active' ? '暂停主体' : '恢复主体',
                    ),
                  ),
                for (final entry in const {
                  'capabilities.describe': '说明自身能力（只读）',
                  'local.report': '本地回执（不广播、不控制设备）',
                }.entries)
                  SwitchListTile(
                    key: Key('mount-${entry.key}'),
                    title: Text(entry.value),
                    value: services.contains(entry.key),
                    onChanged: writable && subject['status'] != 'retired'
                        ? (v) => _run(() => _mount(entry.key, v))
                        : null,
                  ),
                if (subject['status'] == 'active' &&
                    services.contains('local.report'))
                  OutlinedButton(
                    key: const Key('manage-tasks'),
                    onPressed: writable
                        ? () async {
                            await Navigator.of(context).push(
                              MaterialPageRoute<void>(
                                builder: (_) => TasksPage(
                                  api: widget.api,
                                  subjectId: subject['id'] as String,
                                  subjectName: subject['name'] as String,
                                ),
                              ),
                            );
                            if (mounted) await _run(_refresh);
                          }
                        : null,
                    child: const Text('持续任务与回执'),
                  ),
                const Text('本页不提供永久退役、任意代码、付费模型或外部服务装配。挂载不等于执行。'),
              ],
            ],
          ),
        ),
      ),
    );
  }
}
