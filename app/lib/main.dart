import 'package:material_ui/material_ui.dart';
import 'package:http/http.dart' as http;

import 'api.dart';

void main() => runApp(
  MaterialApp(
    theme: ThemeData(
      colorScheme: ColorScheme.fromSeed(seedColor: const Color(0xff385C58)),
      useMaterial3: true,
    ),
    home: const SummonHome(),
  ),
);

class SummonHome extends StatefulWidget {
  const SummonHome({super.key, this.client});
  final http.Client? client;
  @override
  State<SummonHome> createState() => _SummonHomeState();
}

class _SummonHomeState extends State<SummonHome> {
  final _base = TextEditingController(text: 'http://127.0.0.1:8080');
  final _token = TextEditingController();
  final _input = TextEditingController();
  final _scroll = ScrollController();
  final Map<String, String> _drafts = {};
  String? _draftEndpoint, _draftToken;
  late final http.Client _client;
  SummonApi? _api;
  List<dynamic> _creatures = [], _turns = [], _services = [];
  String? _session;
  Map<String, dynamic>? _creature;
  String _status = '连接自己的开发服务，唤起一个主体。';
  String _mode = '未连接';
  bool _busy = false;
  bool get _canTalk => (_creature?['aibm']['serviceAbilities'] as List? ?? [])
      .contains('conversation');

  @override
  void initState() {
    super.initState();
    _client = widget.client ?? http.Client();
  }

  void _saveDraft() {
    if (_creature != null) _drafts[_creature!['id'] as String] = _input.text;
  }

  void _scrollToLatest() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted && _scroll.hasClients) {
        _scroll.animateTo(
          _scroll.position.maxScrollExtent,
          duration: const Duration(milliseconds: 250),
          curve: Curves.easeOut,
        );
      }
    });
  }

  void _reset() {
    _saveDraft();
    _input.clear();
    _api = null;
    _session = null;
    _creature = null;
    _creatures = [];
    _services = [];
    _turns = [];
    _mode = '未连接';
  }

  Future<void> _run(Future<void> Function() action) async {
    if (_busy) return;
    setState(() => _busy = true);
    try {
      await action();
    } on ApiFailure catch (e) {
      if (mounted) {
        setState(
          () => _status = e.status == 401
              ? '令牌无效，请断开后重新连接。'
              : '请求未完成：${e.code}。请检查状态后重试。',
        );
      }
    } catch (_) {
      if (mounted) setState(() => _status = '连接或调用失败，输入已保留，请检查服务后重试。');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _connect() async {
    setState(_reset);
    final api = SummonApi(
      endpoint: _base.text,
      token: _token.text,
      client: _client,
    );
    if (_draftEndpoint != api.endpoint.toString() || _draftToken != api.token) {
      _drafts.clear();
    }
    _draftEndpoint = api.endpoint.toString();
    _draftToken = api.token;
    final data = await api.request('/v1/creatures');
    if (!mounted) return;
    setState(() {
      _api = api;
      _creatures = data['creatures'] as List;
      _mode = data['mode'] as String;
      _status = '选择主体。服务能力由运行内核决定。';
    });
  }

  Future<void> _select(dynamic creature) async {
    if (_creature?['id'] == creature['id']) return;
    _saveDraft();
    // The authenticated backend, not a client cache, selects the saved session.
    final s = await _api!.request(
      '/v1/sessions/resume',
      body: {'creatureId': creature['id']},
    );
    if (!mounted) return;
    setState(() {
      _session = s['id'] as String;
      _creature = Map<String, dynamic>.from(creature);
      _services = [];
      _turns = s['turns'] as List? ?? [];
      _input.text = _drafts[creature['id']] ?? '';
      _status = '已恢复 ${creature['name']} 的会话';
    });
  }

  Future<void> _describe() async {
    final plan = await _api!.request(
      '/v1/plans',
      body: {'creatureId': _creature!['id'], 'prompt': '你能做什么'},
    );
    if (plan['status'] != 'proposed') {
      if (mounted) setState(() => _status = '该主体未提供能力自述服务。');
      return;
    }
    final result = await _api!.request(
      '/v1/invocations',
      body: {
        'creatureId': _creature!['id'],
        'serviceId': plan['serviceId'],
        'arguments': plan['arguments'],
        'context': {
          'zone': _creature!['aibm']['activitySpace']['zones'][0],
          'renderers': ['capability-card'],
        },
      },
    );
    if (mounted) {
      setState(() {
        _services = result['data']['services'] as List;
        _status = '已读取当前注册能力';
      });
    }
  }

  Future<void> _send() async {
    if (_input.text.trim().isEmpty) return;
    final data = await _api!.request(
      '/v1/sessions/$_session/calls',
      body: {'message': _input.text},
    );
    if (!mounted) return;
    setState(() {
      _turns = data['turns'] as List;
      _input.clear();
      _drafts.remove(_creature!['id']);
      _status = '本次交流已保存';
    });
    _scrollToLatest();
  }

  @override
  void dispose() {
    _base.dispose();
    _token.dispose();
    _input.dispose();
    _scroll.dispose();
    if (widget.client == null) _client.close();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(
      title: const Text('Summon · 唤起'),
      actions: [
        if (_api != null)
          TextButton(
            onPressed: _busy
                ? null
                : () => setState(() {
                    _reset();
                    _status = '已断开，服务端主体与任务仍可持续运行。';
                  }),
            child: const Text('断开'),
          ),
      ],
    ),
    body: SafeArea(
      child: Column(
        children: [
          if (_busy) const LinearProgressIndicator(),
          Expanded(
            child: SingleChildScrollView(
              controller: _scroll,
              padding: const EdgeInsets.all(16),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Text(
                    '主体与服务运行空间',
                    style: Theme.of(context).textTheme.headlineSmall,
                  ),
                  const SizedBox(height: 8),
                  Text(
                    _mode == 'demo' ? '演示模式 · 未连接真实 LLM' : '运行模式：$_mode',
                    key: const Key('mode'),
                  ),
                  const Text('位置为模拟。没有真实广播、支付或设备控制。'),
                  if (_api == null) ...[
                    TextField(
                      key: const Key('endpoint'),
                      controller: _base,
                      enabled: !_busy,
                      decoration: const InputDecoration(labelText: '服务地址'),
                    ),
                    TextField(
                      key: const Key('token'),
                      controller: _token,
                      enabled: !_busy,
                      obscureText: true,
                      decoration: const InputDecoration(
                        labelText: '开发访问令牌（不是 LLM 密钥）',
                      ),
                    ),
                    FilledButton(
                      onPressed: _busy ? null : () => _run(_connect),
                      child: const Text('连接'),
                    ),
                  ],
                  const SizedBox(height: 12),
                  Text(_status, key: const Key('status')),
                  const SizedBox(height: 12),
                  Wrap(
                    spacing: 8,
                    runSpacing: 8,
                    children: _creatures
                        .map(
                          (c) => ChoiceChip(
                            label: Text(c['name'] as String),
                            selected: _creature?['id'] == c['id'],
                            onSelected: _busy
                                ? null
                                : (_) => _run(() => _select(c)),
                          ),
                        )
                        .toList(),
                  ),
                  if (_creature != null) ...[
                    const SizedBox(height: 12),
                    OutlinedButton(
                      onPressed: _busy ? null : () => _run(_describe),
                      child: const Text('呼叫：你能做什么'),
                    ),
                    ..._services.map(
                      (s) => Card(
                        child: ListTile(
                          title: Text(s['title'] as String),
                          subtitle: Text('${s['id']} · ${s['effect']}'),
                        ),
                      ),
                    ),
                    if (!_canTalk)
                      const Padding(
                        padding: EdgeInsets.all(12),
                        child: Text('该主体未挂载对话能力，不能发送自由聊天。'),
                      ),
                  ],
                  ..._turns.map(
                    (t) => Card(
                      child: ListTile(
                        title: Text(t['content'] as String),
                        subtitle: Text(
                          t['role'] == 'user'
                              ? '你'
                              : _creature?['name'] as String? ?? '主体',
                        ),
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 8, 8, 8),
            child: Row(
              children: [
                Expanded(
                  child: TextField(
                    key: const Key('message'),
                    controller: _input,
                    enabled: !_busy && _session != null && _canTalk,
                    decoration: const InputDecoration(
                      hintText: '与这个主体交流',
                      border: OutlineInputBorder(),
                    ),
                    maxLength: 4000,
                  ),
                ),
                IconButton(
                  key: const Key('send'),
                  tooltip: '发送',
                  icon: const Icon(Icons.send),
                  onPressed: _busy || _session == null || !_canTalk
                      ? null
                      : () => _run(_send),
                ),
              ],
            ),
          ),
        ],
      ),
    ),
  );
}
