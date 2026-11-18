import 'package:material_ui/material_ui.dart';

import 'api.dart';

class SessionsPage extends StatefulWidget {
  const SessionsPage({super.key, required this.api, required this.creatureId});
  final SummonApi api;
  final String creatureId;
  @override
  State<SessionsPage> createState() => _SessionsPageState();
}

class _SessionsPageState extends State<SessionsPage> {
  List<dynamic> _sessions = [];
  int _maxTurns = 50;
  bool _busy = false, _fresh = false;
  String _status = '正在读取历史会话…';
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) _run(_refresh);
    });
  }

  Future<void> _refresh() async {
    final data = await widget.api.request(
      '/v1/creatures/${widget.creatureId}/sessions',
    );
    if (mounted) {
      setState(() {
        _sessions = data['sessions'] as List;
        _maxTurns = data['maxTurns'] as int;
        _fresh = true;
        _status = '选择历史会话查看，或明确创建新会话。旧记录不会删除。';
      });
    }
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
              '请求未完成${e is ApiFailure ? '：${e.code}' : ''}。请刷新核对后再操作，避免重复新建。';
        });
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _open(String? id) async {
    if (!_fresh) return;
    final session = id == null
        ? await widget.api.request(
            '/v1/sessions',
            body: {'creatureId': widget.creatureId},
          )
        : await widget.api.request('/v1/sessions/$id');
    if (session['creatureId'] != widget.creatureId) {
      throw const ApiFailure(403, 'session_creature_mismatch');
    }
    if (mounted) Navigator.of(context).pop(session);
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(title: const Text('会话与历史')),
    body: SafeArea(
      child: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          Text(_status),
          Text('每个会话最多 $_maxTurns 回合；新会话不继承旧对话上下文，也不会绕过总会话容量。'),
          if (_busy) const LinearProgressIndicator(),
          TextButton(
            key: const Key('refresh-sessions'),
            onPressed: _busy ? null : () => _run(_refresh),
            child: const Text('刷新历史'),
          ),
          FilledButton(
            key: const Key('new-session'),
            onPressed: _busy || !_fresh ? null : () => _run(() => _open(null)),
            child: const Text('新建会话（保留旧记录）'),
          ),
          ..._sessions.map(
            (s) => ListTile(
              key: Key('history-${s['id']}'),
              title: Text('会话 ${s['id']}'),
              subtitle: Text(
                '${s['turnCount']} 回合${(s['turnCount'] as num) >= _maxTurns ? ' · 已满，可查看' : ''}',
              ),
              onTap: _busy || !_fresh
                  ? null
                  : () => _run(() => _open(s['id'] as String)),
            ),
          ),
        ],
      ),
    ),
  );
}
