import 'package:material_ui/material_ui.dart';

import 'api.dart';

/// Discovery is separate from conversation: no session creation or implicit call.
class DiscoveryPage extends StatefulWidget {
  const DiscoveryPage({super.key, required this.api});
  final SummonApi api;
  @override
  State<DiscoveryPage> createState() => _DiscoveryPageState();
}

class _DiscoveryPageState extends State<DiscoveryPage> {
  final _prompt = TextEditingController(text: '你能做什么');
  String _zone = 'demo-world';
  String _status = '先发现服务，再选择提供者，最后明确调用。';
  bool _busy = false;
  List<dynamic> _candidates = [], _unavailable = [];
  Map<String, dynamic>? _selected, _result;
  static const _renderers = ['capability-card', 'menu-card', 'receipt-card'];
  static const _supported = [
    'capabilities.describe',
    'menu.read',
    'local.report',
  ];
  Map<String, dynamic> get _context => {'zone': _zone, 'renderers': _renderers};

  void _clear() {
    _candidates = [];
    _unavailable = [];
    _selected = null;
    _result = null;
  }

  void _changed() => setState(() {
    _clear();
    _status = '条件已改变，请重新发现服务。';
  });

  Future<void> _run(Future<void> Function() action) async {
    if (_busy) return;
    setState(() => _busy = true);
    try {
      await action();
    } on ApiFailure catch (e) {
      if (mounted) {
        setState(() {
          _clear();
          _status = e.status == 401
              ? '令牌无效，请返回并重新连接。'
              : '请求未完成：${e.code}。请重新发现，当前没有成功回执。';
        });
      }
    } catch (_) {
      if (mounted) {
        setState(() {
          _clear();
          _status = '连接或响应失败。请重新发现，当前没有成功回执。';
        });
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _discover() async {
    setState(_clear);
    final data = await widget.api.request(
      '/v1/discovery',
      body: {'prompt': _prompt.text, 'context': _context},
    );
    if (!mounted) return;
    setState(() {
      _candidates = data['candidates'] as List;
      _unavailable = data['unavailable'] as List;
      _status = switch (data['status']) {
        'needs_choice' => '多个服务提供者可用，请选择；尚未执行。',
        'proposed' => '找到一个候选，仍需选择并明确调用；尚未执行。',
        'unavailable' => '当前条件下没有可用服务。',
        _ => '暂不理解这个呼唤。演示规则支持“你能做什么”或“菜单”。',
      };
    });
  }

  Future<void> _invoke() async {
    final candidate = _selected;
    if (candidate == null || !_supported.contains(candidate['service']['id'])) {
      return;
    }
    setState(() => _result = null);
    final result = await widget.api.request(
      '/v1/invocations',
      body: {
        'creatureId': candidate['creatureId'],
        'serviceId': candidate['service']['id'],
        'arguments': <String, dynamic>{},
        'context': _context,
      },
    );
    if (!mounted) return;
    if (result['status'] != 'completed') {
      throw const ApiFailure(502, 'incomplete_result');
    }
    setState(() {
      _result = result;
      _status = '收到服务完成回执。没有付款、下单或设备控制。';
    });
  }

  @override
  void dispose() {
    _prompt.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(title: const Text('全局呼唤 · 服务发现')),
    body: SafeArea(
      child: SingleChildScrollView(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            const Text('规则演示，不是 LLM 意图理解。只搜索当前所有者的主体；位置由你模拟选择，不读取定位。'),
            TextField(
              key: const Key('global-prompt'),
              controller: _prompt,
              enabled: !_busy,
              maxLength: 4000,
              onChanged: (_) => _changed(),
              decoration: const InputDecoration(labelText: '呼唤（你能做什么 / 菜单）'),
            ),
            DropdownButton<String>(
              key: const Key('simulation-zone'),
              value: _zone,
              isExpanded: true,
              items: const [
                DropdownMenuItem(value: 'demo-world', child: Text('模拟空间：日常空间')),
                DropdownMenuItem(
                  value: 'demo-restaurant',
                  child: Text('模拟空间：餐馆'),
                ),
              ],
              onChanged: _busy
                  ? null
                  : (value) {
                      _zone = value!;
                      _changed();
                    },
            ),
            FilledButton(
              key: const Key('discover-global'),
              onPressed: _busy ? null : () => _run(_discover),
              child: const Text('发现服务（不执行）'),
            ),
            if (_busy) const LinearProgressIndicator(),
            Text(_status, key: const Key('discovery-status')),
            ..._candidates.map(
              (candidate) => Card(
                child: ListTile(
                  key: Key('candidate-${candidate['creatureId']}'),
                  title: Text(
                    '${candidate['name']} · ${candidate['service']['title']}',
                  ),
                  subtitle: Text(
                    '${candidate['service']['id']} · ${candidate['service']['effect']}',
                  ),
                  selected: _selected?['creatureId'] == candidate['creatureId'],
                  trailing: _selected?['creatureId'] == candidate['creatureId']
                      ? const Icon(Icons.check)
                      : null,
                  onTap: _busy
                      ? null
                      : () => setState(() {
                          _selected = Map<String, dynamic>.from(candidate);
                          _result = null;
                          _status = '已选择 ${candidate['name']}；尚未执行。';
                        }),
                ),
              ),
            ),
            ..._unavailable.map(
              (candidate) => ListTile(
                title: Text('${candidate['name']} · 当前不可用'),
                subtitle: Text(
                  candidate['reason'] == 'outside_simulated_activity_space'
                      ? '不在所选模拟活动空间内'
                      : '当前呈现能力不支持此服务',
                ),
              ),
            ),
            if (_selected != null)
              OutlinedButton(
                key: const Key('invoke-selected'),
                onPressed:
                    _busy || !_supported.contains(_selected!['service']['id'])
                    ? null
                    : () => _run(_invoke),
                child: Text(
                  _supported.contains(_selected!['service']['id'])
                      ? '明确调用所选服务'
                      : '此界面暂不支持该服务输入',
                ),
              ),
            if (_result != null) ...[
              Text(
                '服务回执 · ${_result!['serviceId']}',
                key: const Key('service-receipt'),
              ),
              if (_result!['demo'] == true) const Text('演示数据，不是真实商家或模型结果。'),
              if (_result!['serviceId'] == 'capabilities.describe')
                ...(_result!['data']['services'] as List).map(
                  (s) => ListTile(
                    title: Text(s['title'] as String),
                    subtitle: Text(s['id'] as String),
                  ),
                ),
              if (_result!['serviceId'] == 'menu.read')
                ...(_result!['data']['items'] as List).map(
                  (item) => ListTile(
                    title: Text(item['name'] as String),
                    subtitle: Text(
                      '${_result!['data']['currency']} ${((item['priceMinor'] as num) / 100).toStringAsFixed(2)} · 仅展示',
                    ),
                  ),
                ),
              if (_result!['serviceId'] == 'local.report')
                Text(_result!['data']['notice'] as String),
            ],
          ],
        ),
      ),
    ),
  );
}
