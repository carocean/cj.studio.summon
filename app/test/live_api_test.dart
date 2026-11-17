import 'dart:convert';
import 'dart:io';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:summon_app/api.dart';

void main() {
  test(
      'Dart client traverses actual Node API and persistent runtime in demo mode',
      () async {
    final dir = await Directory.systemTemp.createTemp('summon-dart-live-');
    final client = http.Client();
    Process? server;
    try {
      const token = 'dart-live-test-token-abcdefghijklmnopqrstuvwxyz';
      server = await Process.start('node', ['src/main.js'],
          workingDirectory: '../server',
          environment: {
            'PORT': '0',
            'APP_TOKEN': token,
            'KERNEL_STORE': '${dir.path}/kernel.json',
            'LLM_MODE': 'demo',
          });
      final output = await server.stdout
          .transform(utf8.decoder)
          .transform(const LineSplitter())
          .firstWhere((s) => s.contains('port='))
          .timeout(const Duration(seconds: 5));
      final port = RegExp(r'port=(\d+)').firstMatch(output)!.group(1)!;
      final api = SummonApi(
          endpoint: 'http://127.0.0.1:$port', token: token, client: client);
      final listing = await api.request('/v1/creatures');
      expect(listing['mode'], 'demo');
      final creature = (listing['creatures'] as List)
          .firstWhere((c) => c['templateId'] == 'companion');
      final session = await api
          .request('/v1/sessions', body: {'creatureId': creature['id']});
      final result = await api.request('/v1/sessions/${session['id']}/calls',
          body: {'message': 'Flutter 客户端真实联调'});
      expect(result['turns'][0]['content'], 'Flutter 客户端真实联调');
      expect(result['turns'][1]['content'], contains('演示模式'));
      final plan = await api.request('/v1/plans',
          body: {'creatureId': creature['id'], 'prompt': '你能做什么'});
      final service = await api.request('/v1/invocations', body: {
        'creatureId': creature['id'],
        'serviceId': plan['serviceId'],
        'arguments': {},
        'context': {
          'zone': 'demo-world',
          'renderers': ['capability-card']
        },
      });
      expect(service['data']['services'], isNotEmpty);
    } finally {
      client.close();
      if (server != null) {
        server.kill(ProcessSignal.sigterm);
        await server.exitCode.timeout(const Duration(seconds: 5));
      }
      await dir.delete(recursive: true);
    }
  }, timeout: const Timeout(Duration(seconds: 15)));
}
