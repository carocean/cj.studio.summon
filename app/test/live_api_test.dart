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
        Future<SummonApi> startServer() async {
          server = await Process.start(
            'node',
            ['src/main.js'],
            workingDirectory: '../server',
            environment: {
              'PORT': '0',
              'APP_TOKEN': token,
              'KERNEL_STORE': '${dir.path}/kernel.json',
              'LLM_MODE': 'demo',
            },
          );
          final output = await server!.stdout
              .transform(utf8.decoder)
              .transform(const LineSplitter())
              .firstWhere((s) => s.contains('port='))
              .timeout(const Duration(seconds: 5));
          final port = RegExp(r'port=(\d+)').firstMatch(output)!.group(1)!;
          return SummonApi(
            endpoint: 'http://127.0.0.1:$port',
            token: token,
            client: client,
          );
        }

        var api = await startServer();
        final listing = await api.request('/v1/creatures');
        expect(listing['mode'], 'demo');
        final creature = (listing['creatures'] as List).firstWhere(
          (c) => c['templateId'] == 'companion',
        );
        final session = await api.request(
          '/v1/sessions',
          body: {'creatureId': creature['id']},
        );
        final result = await api.request(
          '/v1/sessions/${session['id']}/calls',
          body: {'message': 'Flutter 客户端真实联调'},
        );
        expect(result['turns'][0]['content'], 'Flutter 客户端真实联调');
        expect(result['turns'][1]['content'], contains('演示模式'));
        final createdSubject = await api.request(
          '/v1/kernel/subjects',
          body: {
            'requestId': 'dart-create-persistent',
            'name': 'Flutter 创建的持久主体',
            'personality': '简洁',
            'activitySpace': 'fixed-simulation',
          },
        );
        expect(createdSubject['aibm']['serviceAbilities'], isEmpty);
        await api.request(
          '/v1/kernel/mounts',
          body: {
            'subjectId': createdSubject['id'],
            'serviceId': 'local.report',
            'enabled': true,
          },
        );
        final taskRequest = {
          'subjectId': createdSubject['id'],
          'serviceId': 'local.report',
          'requestId': 'dart-delayed-task',
          'trigger': {'kind': 'timer', 'delayMs': 60000},
          'payload': {'purpose': 'local task only'},
        };
        final delayedTask = await api.request(
          '/v1/kernel/tasks',
          body: taskRequest,
        );
        await api.request(
          '/v1/kernel/transitions',
          body: {'subjectId': createdSubject['id'], 'status': 'paused'},
        );
        server!.kill(ProcessSignal.sigterm);
        await server!.exitCode.timeout(const Duration(seconds: 5));
        api = await startServer();
        final replayedCreate = await api.request(
          '/v1/kernel/subjects',
          body: {
            'requestId': 'dart-create-persistent',
            'name': 'Flutter 创建的持久主体',
            'personality': '简洁',
            'activitySpace': 'fixed-simulation',
          },
        );
        expect(replayedCreate['id'], createdSubject['id']);
        expect(replayedCreate['replayed'], true);
        final taskReplay = await api.request(
          '/v1/kernel/tasks',
          body: taskRequest,
        );
        expect(taskReplay['id'], delayedTask['id']);
        expect(taskReplay['dueAt'], delayedTask['dueAt']);
        await api.request(
          '/v1/kernel/cancellations',
          body: {'taskId': delayedTask['id']},
        );
        final managementState = await api.request('/v1/kernel/state');
        final persistedSubject = (managementState['subjects'] as List)
            .firstWhere((s) => s['id'] == createdSubject['id']);
        expect(persistedSubject['status'], 'paused');
        expect(persistedSubject['aibm']['serviceAbilities'], ['local.report']);
        await api.request(
          '/v1/kernel/transitions',
          body: {'subjectId': createdSubject['id'], 'status': 'active'},
        );
        final localReceipt = await api.request(
          '/v1/invocations',
          body: {
            'creatureId': createdSubject['id'],
            'serviceId': 'local.report',
            'context': {
              'zone': 'demo-world',
              'renderers': ['receipt-card'],
            },
          },
        );
        expect(localReceipt['status'], 'completed');
        expect(localReceipt['effect'], 'local-only');
        await api.request(
          '/v1/kernel/mounts',
          body: {
            'subjectId': createdSubject['id'],
            'serviceId': 'device.preview',
            'enabled': true,
          },
        );
        final deviceRequest = {
          'creatureId': createdSubject['id'],
          'serviceId': 'device.preview',
          'context': {
            'zone': 'demo-world',
            'renderers': ['receipt-card'],
          },
        };
        await expectLater(
          api.request('/v1/invocations', body: deviceRequest),
          throwsA(
            isA<ApiFailure>().having(
              (e) => e.code,
              'code',
              'connector_unavailable',
            ),
          ),
        );
        await api.request(
          '/v1/kernel/connectors',
          body: {
            'subjectId': createdSubject['id'],
            'status': 'connected',
            'leaseMs': 30000,
          },
        );
        final preview = await api.request(
          '/v1/invocations',
          body: deviceRequest,
        );
        expect(preview['data']['deviceActionExecuted'], false);
        expect(preview['data']['simulation'], true);
        await api.request(
          '/v1/kernel/connectors',
          body: {'subjectId': createdSubject['id'], 'status': 'disconnected'},
        );
        await expectLater(
          api.request('/v1/invocations', body: deviceRequest),
          throwsA(
            isA<ApiFailure>().having(
              (e) => e.code,
              'code',
              'connector_unavailable',
            ),
          ),
        );
        final restored = await api.request(
          '/v1/sessions/resume',
          body: {'creatureId': creature['id']},
        );
        expect(restored['id'], session['id']);
        expect(restored['turns'], result['turns']);
        final repeated = await api.request(
          '/v1/sessions/resume',
          body: {'creatureId': creature['id']},
        );
        expect(repeated['id'], session['id']);
        final nextSession = await api.request(
          '/v1/sessions',
          body: {'creatureId': creature['id']},
        );
        final histories = await api.request(
          '/v1/creatures/${creature['id']}/sessions',
        );
        expect((histories['sessions'] as List).map((s) => s['id']).toList(), [
          nextSession['id'],
          session['id'],
        ]);
        final oldHistory = await api.request('/v1/sessions/${session['id']}');
        expect(oldHistory['turns'], result['turns']);
        final discovery = await api.request(
          '/v1/discovery',
          body: {
            'prompt': '你能做什么',
            'context': {
              'zone': 'demo-world',
              'renderers': ['capability-card'],
            },
          },
        );
        expect(discovery['status'], 'needs_choice');
        expect(discovery['executed'], false);
        expect(
          (discovery['candidates'] as List).any(
            (c) => c['creatureId'] == creature['id'],
          ),
          isTrue,
        );
        final selected = (discovery['candidates'] as List).first;
        final invocation = {
          'creatureId': selected['creatureId'],
          'serviceId': selected['service']['id'],
          'arguments': <String, dynamic>{},
          'context': {
            'zone': 'demo-world',
            'renderers': ['capability-card'],
          },
        };
        final receipt = await api.request('/v1/invocations', body: invocation);
        expect(receipt['status'], 'completed');
        expect(receipt['data']['name'], selected['name']);
        await api.request(
          '/v1/kernel/mounts',
          body: {
            'subjectId': selected['creatureId'],
            'serviceId': selected['service']['id'],
            'enabled': false,
          },
        );
        await expectLater(
          api.request('/v1/invocations', body: invocation),
          throwsA(
            isA<ApiFailure>().having(
              (e) => e.code,
              'code',
              'outside_service_boundary',
            ),
          ),
        );
        await api.request(
          '/v1/kernel/mounts',
          body: {
            'subjectId': selected['creatureId'],
            'serviceId': selected['service']['id'],
            'enabled': true,
          },
        );
        final plan = await api.request(
          '/v1/plans',
          body: {'creatureId': creature['id'], 'prompt': '你能做什么'},
        );
        final service = await api.request(
          '/v1/invocations',
          body: {
            'creatureId': creature['id'],
            'serviceId': plan['serviceId'],
            'arguments': {},
            'context': {
              'zone': 'demo-world',
              'renderers': ['capability-card'],
            },
          },
        );
        expect(service['data']['services'], isNotEmpty);
      } finally {
        client.close();
        if (server != null) {
          server!.kill(ProcessSignal.sigterm);
          await server!.exitCode.timeout(const Duration(seconds: 5));
        }
        await dir.delete(recursive: true);
      }
    },
    timeout: const Timeout(Duration(seconds: 15)),
  );
}
