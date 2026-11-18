import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:summon_app/scene_experiment.dart';
import 'package:summon_app/api.dart';
import 'package:summon_app/creature_market.dart';
import 'package:summon_app/choice_form.dart';
import 'package:summon_app/focus_sheet.dart';
import 'package:summon_app/scene_text_entry.dart';

void main() {
  test(
    'real Dart HTTP client traverses synthetic Node scene service',
    () async {
      final dir = await Directory.systemTemp.createTemp('summon-scene-http-');
      final client = http.Client();
      Process? server;
      try {
        server = await Process.start(
          'node',
          ['src/scene-server.js'],
          workingDirectory: '../runtime',
          environment: {'SUMMON_SCENE_DATA': dir.path},
        );
        final errors = <String>[];
        server.stderr.transform(utf8.decoder).listen(errors.add);
        await server.stdout
            .transform(utf8.decoder)
            .transform(const LineSplitter())
            .firstWhere((line) => line.startsWith('Synthetic scene lab:'))
            .timeout(
              const Duration(seconds: 10),
              onTimeout: () => throw StateError('Node startup failed: $errors'),
            );
        final api = SceneExperimentApi(client);
        var state = await api.request('state');
        expect(state['activity'], isNull);
        expect(state.containsKey('textEntry'), false);
        state = await api.request('text-entry', {
          'context': state['context'],
          'visible': true,
        });
        expect(trustedTextEntry(state), isNotNull);
        final inputFrame = state['context'];
        await expectLater(
          api.request('text-request', {
            'context': inputFrame,
            'text': '不要开始工作',
            'confirmation': 'apply-direct-text-scene',
          }),
          throwsA(
            isA<ApiFailure>().having(
              (e) => e.code,
              'code',
              'unsupported_text_request',
            ),
          ),
        );
        state = await api.request('text-request', {
          'context': inputFrame,
          'text': '开始工作',
          'confirmation': 'apply-direct-text-scene',
        });
        expect(state['activeCreatureId'], 'work');
        expect(state.containsKey('textEntry'), false);
        await expectLater(
          api.request('text-request', {
            'context': inputFrame,
            'text': '模拟开户',
            'confirmation': 'apply-direct-text-scene',
          }),
          throwsA(isA<ApiFailure>()),
        );
        state = await api.request('text-entry', {
          'context': state['context'],
          'visible': true,
        });
        state = await api.request('text-request', {
          'context': state['context'],
          'text': '回到伙伴',
          'confirmation': 'apply-direct-text-scene',
        });
        expect(state['activeCreatureId'], 'companion');
        state = await api.request('text-entry', {
          'context': state['context'],
          'visible': true,
        });
        state = await api.request('text-entry', {
          'context': state['context'],
          'visible': false,
        });
        expect(trustedTextEntry(state), isNull);

        state = await api.request('creature-create', {
          'id': 'pet-dart-fixture',
          'name': '测试伙伴',
          'kind': 'pet',
          'personality': '只用于本机HTTP测试',
          'body': 'owl',
          'tone': 'playful',
        });
        Map pet() => (state['creatures'] as List).firstWhere(
          (c) => c['id'] == 'pet-dart-fixture',
        ) as Map;
        expect(pet()['senses'], {'hearing': false, 'vision': false});
        state = await api.request('creature-primary', {
          'creatureId': 'pet-dart-fixture',
          'expectedRevision': state['registryRevision'],
        });
        expect(state['activeCreatureId'], 'companion');
        expect(state['primaryCreatureId'], 'pet-dart-fixture');
        state = await api.request('creature-select', {
          'creatureId': 'pet-dart-fixture',
        });
        expect(state['activeCreatureId'], 'pet-dart-fixture');
        state = await api.request('creature-sense', {
          'creatureId': 'pet-dart-fixture',
          'modality': 'hearing',
          'enabled': true,
          'expectedRevision': state['registryRevision'],
        });
        expect(pet()['senses']['hearing'], true);
        expect(pet()['senses']['vision'], false);
        state = await api.request('creature-sense', {
          'creatureId': 'pet-dart-fixture',
          'modality': 'hearing',
          'enabled': false,
          'expectedRevision': state['registryRevision'],
        });
        state = await api.request('creature-select', {
          'creatureId': 'companion',
        });

        state = await api.request('perceive', {
          'modality': 'hearing',
          'signal': 'account-request',
        });
        state = await api.request('form-update', {
          'formId': state['choiceForms']['account']['formId'],
          'binding': state['choiceForms']['account']['binding'],
          'values': {
            'customerAlias': 'demo-a',
            'accountType': 'daily',
            'contactPreference': 'none',
          },
        });
        final revision = state['activity']['revision'];
        await api.request('hide', {'activityId': state['activity']['id']});
        state = await api.request('submit', {
          'activityId': state['activity']['id'],
          'expectedRevision': revision,
        });
        expect(state['activity']['status'], 'completed');
        state = await api.request('state');
        expect(state['activity']['sceneVisible'], isFalse);
        expect(state['activity']['receipt']['mode'], 'simulation-only');
        final firstId = state['activity']['id'];
        state = await api.request('new', {
          'previousActivityId': state['activity']['id'],
        });
        expect(state['activity']['id'], isNot(firstId));
        await expectLater(
          api.request('submit', {
            'activityId': firstId,
            'expectedRevision': state['activity']['revision'],
          }),
          throwsA(
            isA<ApiFailure>().having(
              (e) => e.code,
              'code',
              'activity_conflict',
            ),
          ),
        );
        expect((await api.request('state'))['activity']['status'], 'draft');

        expect(state['activity']['status'], 'draft');
        expect(
          (state['activity']['form']['fields'] as List).every(
            (f) => f['value'] == null,
          ),
          isTrue,
        );
        state = await api.request('cancel', {
          'activityId': state['activity']['id'],
        });
        expect(state['activity']['status'], 'cancelled');
        final cancelledId = state['activity']['id'];
        state = await api.request('new', {
          'previousActivityId': state['activity']['id'],
        });
        expect(state['activity']['id'], isNot(cancelledId));
        expect(state['activity']['status'], 'draft');
        final primary = state['primaryCreatureId'];
        state = await api.request('market-subscribe', {
          'productId': marketProduct,
        });
        final sub = state['market']['subscriptions'][0];
        expect(sub['routeGranted'], false);
        expect(
          (state['creatures'] as List).firstWhere(
            (c) => c['id'] == sub['instanceId'],
          )['senses'],
          {'hearing': false, 'vision': false},
        );
        state = await api.request('market-grant', {
          'productId': marketProduct,
          'enabled': true,
          'expectedRevision': sub['revision'],
        });
        state = await api.request('form-route', {
          'formId': state['choiceForms']['route']['formId'],
          'binding': state['choiceForms']['route']['binding'],
          'values': {'from': 'A', 'to': 'C'},
          'requestId': 'dart-live-route',
        });
        expect(trustedRoute(state), isNotNull);
        expect(state['primaryCreatureId'], primary);
        final receiptId = state['route']['receipt']['receiptId'];
        state = await api.request('route-visible', {
          'receiptId': receiptId,
          'visible': false,
        });
        expect(trustedRoute(state)?['visible'], false);
        state = await api.request('state');
        expect(state['route']['receipt']['receiptId'], receiptId);
        state = await api.request('route-visible', {
          'receiptId': receiptId,
          'visible': true,
        });
        expect(trustedRoute(state)?['visible'], true);
        state = await api.request('market-cancel', {
          'requestId': 'dart-cancel-unknown',
        });
        expect(
          (state['market']['requests'] as List).singleWhere(
            (r) => r['requestId'] == 'dart-cancel-unknown',
          )['status'],
          'cancelled',
        );
        await expectLater(
          api.request('market-route', {
            'productId': marketProduct,
            'instanceId': sub['instanceId'],
            'from': 'A',
            'to': 'C',
            'requestId': 'dart-cancel-unknown',
          }),
          throwsA(isA<ApiFailure>()),
        );
        state = await api.request('state');
        expect(state['route']['receipt']['receiptId'], receiptId);
        state = await api.request('creature-select', {
          'creatureId': state['primaryCreatureId'],
        });
        expect(state['focus']['grant']['enabled'], false);
        state = await api.request('focus-grant', {
          'creatureId': state['primaryCreatureId'],
          'enabled': true,
          'expectedRevision': state['focus']['grant']['revision'],
        });
        final focusForm = state['choiceForms']['focus'];
        expect(
          validatedChoiceForm(focusForm, state, 'synthetic-focus.v1'),
          isNotNull,
        );
        state = await api.request('form-focus', {
          'formId': focusForm['formId'],
          'binding': focusForm['binding'],
          'values': {'topic': 'study', 'duration': '5', 'pace': 'gentle'},
          'requestId': 'dart-focus-example',
        });
        expect(validatedFocusPlan(state['focus']['activePlan']), isNotNull);
        expect(state['focus']['activePlan']['receipt']['fact'], 'plan_saved');
        final focusStatus = await api.request('focus-status', {
          'requestId': 'dart-focus-example',
        });
        expect(focusStatus['status'], 'completed');
        state = await api.request('focus-cancel', {
          'requestId': 'dart-focus-example',
        });
        expect(state['focus']['activePlan'], isNull);
        expect(
          (await api.request('focus-status', {
            'requestId': 'dart-focus-example',
          }))['plan']['status'],
          'cancelled',
        );
      } finally {
        client.close();
        server?.kill();
        if (server != null) await server.exitCode;
        await dir.delete(recursive: true);
      }
    },
    skip: Platform.environment['SUMMON_SCENE_LIVE'] != '1',
  );
}
