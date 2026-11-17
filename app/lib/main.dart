import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;

void main() => runApp(const MaterialApp(home: SummonHome()));

class SummonHome extends StatefulWidget {
  const SummonHome({super.key});
  @override
  State<SummonHome> createState() => _SummonHomeState();
}

class _SummonHomeState extends State<SummonHome> {
  final _base = TextEditingController(text: 'http://127.0.0.1:8080');
  final _token = TextEditingController();
  final _input = TextEditingController();
  final _client = http.Client();
  List<dynamic> _creatures = [], _turns = [];
  String? _session;
  Map<String, dynamic>? _creature, _serviceResult;
  String _status = '未连接。仅本地原型，不提供定位或现实动作。';
  bool _busy = false;

  Future<Map<String, dynamic>> _request(String path, {Map<String, dynamic>? body}) async {
    final uri = Uri.parse('${_base.text.trim()}$path');
    final headers = {'Authorization': 'Bearer ${_token.text}', 'Content-Type': 'application/json'};
    final response = await (body == null
        ? _client.get(uri, headers: headers)
        : _client.post(uri, headers: headers, body: jsonEncode(body)))
        .timeout(const Duration(seconds: 25));
    if (response.statusCode >= 400) throw Exception('请求失败 (${response.statusCode})');
    return jsonDecode(utf8.decode(response.bodyBytes)) as Map<String, dynamic>;
  }

  Future<void> _run(Future<void> Function() action) async {
    if (_busy) return;
    setState(() => _busy = true);
    try { await action(); }
    catch (_) { if (mounted) setState(() => _status = '连接或调用失败，请检查服务与令牌后重试。'); }
    finally { if (mounted) setState(() => _busy = false); }
  }

  @override
  void dispose() { _base.dispose(); _token.dispose(); _input.dispose(); _client.close(); super.dispose(); }

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(title: const Text('Summon · 唤起')),
    body: Padding(padding: const EdgeInsets.all(16), child: Column(children: [
      TextField(controller: _base, enabled: !_busy, decoration: const InputDecoration(labelText: '本地服务地址')),
      TextField(controller: _token, enabled: !_busy, obscureText: true, decoration: const InputDecoration(labelText: '开发访问令牌（不是 LLM 密钥）')),
      FilledButton(onPressed: _busy ? null : () => _run(() async {
        final data = await _request('/v1/creatures');
        if (!mounted) return;
        setState(() { _creatures = data['creatures'] as List; _session = null; _creature = null; _serviceResult = null; _turns = []; _status = '模式：${data['mode']}'; });
      }), child: const Text('连接')),
      Text(_status),
      Wrap(spacing: 8, children: _creatures.map((c) => OutlinedButton(
        onPressed: _busy ? null : () => _run(() async {
          final s = await _request('/v1/sessions', body: {'creatureId': c['id']});
          if (!mounted) return;
          setState(() { _session = s['id'] as String; _creature = Map<String, dynamic>.from(c); _serviceResult = null; _turns = []; _status = '已唤起 ${c['name']} · 空间为模拟'; });
        }), child: Text(c['name'] as String))).toList()),
      if (_creature != null) FilledButton(onPressed: _busy ? null : () => _run(() async {
        final plan = await _request('/v1/plans', body: {'creatureId': _creature!['id'], 'prompt': '你能做什么'});
        if (plan['status'] != 'proposed') return;
        final result = await _request('/v1/invocations', body: {
          'creatureId': _creature!['id'], 'serviceId': plan['serviceId'], 'arguments': plan['arguments'],
          'context': {'zone': _creature!['aibm']['activitySpace']['zones'][0], 'renderers': ['capability-card']}
        });
        if (mounted) setState(() => _serviceResult = result);
      }), child: const Text('呼叫：你能做什么')),
      if (_serviceResult != null) SizedBox(height: 140, child: SingleChildScrollView(child: Card(child: Padding(
        padding: const EdgeInsets.all(12), child: Text(const JsonEncoder.withIndent('  ').convert(_serviceResult!['data'])))))),
      Expanded(child: ListView.builder(itemCount: _turns.length, itemBuilder: (context, i) => ListTile(
        title: Text(_turns[i]['content'] as String), subtitle: Text(_turns[i]['role'] as String)))),
      if (_busy) const LinearProgressIndicator(),
      Row(children: [Expanded(child: TextField(controller: _input, enabled: !_busy && _session != null,
        decoration: const InputDecoration(hintText: '与这个主体交流'), maxLength: 4000)),
        IconButton(icon: const Icon(Icons.send), onPressed: _busy || _session == null || !(_creature?['aibm']['serviceAbilities'] as List? ?? []).contains('conversation') ? null : () => _run(() async {
          if (_input.text.trim().isEmpty) return;
          final data = await _request('/v1/sessions/$_session/calls', body: {'message': _input.text});
          if (!mounted) return;
          setState(() { _turns = data['turns'] as List; _input.clear(); });
        }))]),
    ])),
  );
}
