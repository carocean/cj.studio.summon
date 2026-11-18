import 'dart:convert';

import 'choice_form_fixtures.dart';

import 'package:material_ui/material_ui.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:summon_app/scene_experiment.dart';

class Lab {
  int writes = 0;
  bool fail = false;
  String failureCode = 'revision_conflict';
  Map<String, dynamic> state = {
    'mode': 'deterministic-synthetic',
    'context': {'creatureId': 'companion', 'sceneRevision': 3},
    'creatures': <Map<String, dynamic>>[
      {
        'id': 'companion',
        'name': '小伴',
        'personality': '好奇的日常伙伴',
        'kind': 'companion',
        'body': 'sprout',
        'tone': 'playful',
        'senses': {'hearing': true, 'vision': true},
        'generation': 0,
      },
      {
        'id': 'work',
        'name': '小谨',
        'personality': '严谨的工作伙伴',
        'kind': 'business',
        'body': 'owl',
        'tone': 'precise',
        'senses': {'hearing': true, 'vision': true},
        'generation': 0,
      },
    ],
    'primaryCreatureId': 'companion',
    'registryRevision': 0,
    'activeCreatureId': 'companion',
    'activity': null,
  };
  late final client = MockClient((request) async {
    expect(request.url.host, '127.0.0.1');
    expect(request.url.port, 8091);
    expect(request.headers.containsKey('Authorization'), isFalse);
    final action = request.url.path.split('/').last;
    if (action == 'sense-capabilities') {
      return http.Response(
        jsonEncode({
          'context': {
            'creatureId': state['activeCreatureId'],
            'sceneRevision': 3,
          },
          'capabilities': {
            'hearing': {'available': true},
            'vision': {'available': true},
          },
        }),
        200,
        headers: {'content-type': 'application/json; charset=utf-8'},
      );
    }

    if (request.method == 'POST') {
      writes++;
      expect(request.headers['X-Summon-Lab'], 'synthetic');
      if (fail) return http.Response(jsonEncode({'error': failureCode}), 409);
      final body = jsonDecode(request.body);
      if (['update', 'submit', 'hide', 'show', 'cancel'].contains(action)) {
        expect(body['activityId'], state['activity']['id']);
      }
      if (action == 'new') {
        expect(body['previousActivityId'], state['activity']?['id']);
      }
      switch (action) {
        case 'creature-create':
          expect(body.keys.toSet(), {
            'id',
            'name',
            'kind',
            'personality',
            'body',
            'tone',
          });
          (state['creatures'] as List).add(<String, dynamic>{
            ...body,
            'senses': {'hearing': false, 'vision': false},
            'generation': 0,
          });
          state['registryRevision']++;
        case 'usage-select':
          final changed = state['activeCreatureId'] != body['creatureId'];
          state['activeCreatureId'] = body['creatureId'];
          state['context'] = {
            'creatureId': body['creatureId'],
            'sceneRevision':
                body['context']['sceneRevision'] + (changed ? 1 : 0),
          };
          return http.Response(
            jsonEncode({
              'replayed': false,
              'receiptStored': true,
              'ack': {
                'fact': 'creature_selection_confirmed',
                'creatureId': body['creatureId'],
                'changed': changed,
                'context': state['context'],
                'usage': {
                  'recorded': changed,
                  'reason': changed ? 'recorded' : 'same-target',
                  'useCount': changed ? 1 : null,
                },
              },
            }),
            200,
            headers: {'content-type': 'application/json'},
          );
        case 'creature-select':
          state['activeCreatureId'] = body['creatureId'];
        case 'creature-primary':
          expect(body['expectedRevision'], state['registryRevision']);
          state['primaryCreatureId'] = body['creatureId'];
          state['registryRevision']++;
        case 'creature-sense':
          expect(body['expectedRevision'], state['registryRevision']);
          final creature = (state['creatures'] as List).firstWhere(
            (c) => c['id'] == body['creatureId'],
          );
          creature['senses'][body['modality']] = body['enabled'];
          creature['generation']++;
          state['registryRevision']++;

        case 'perceive':
          state['activeCreatureId'] = body['signal'] == 'personal-context'
              ? 'companion'
              : 'work';
          if (body['signal'] == 'account-request') {
            state['activity'] = {
              'id': 't1',
              'status': 'draft',
              'sceneVisible': true,
              'revision': 1,
              'receipt': null,
              'form': {
                'schema': 'synthetic-account.v1',
                'fields': [
                  {
                    'id': 'customerAlias',
                    'label': '客户代号',
                    'type': 'choice',
                    'options': ['demo-a', 'demo-b'],
                    'value': null,
                  },
                  {
                    'id': 'accountType',
                    'label': '类型',
                    'type': 'choice',
                    'options': ['daily', 'savings'],
                    'value': null,
                  },
                  {
                    'id': 'contactPreference',
                    'label': '联系',
                    'type': 'choice',
                    'options': ['none', 'demo-email'],
                    'value': null,
                  },
                ],
              },
            };
          }
        case 'cancel':
          state['activity']['status'] = 'cancelled';
        case 'new':
          state['activity']['status'] = 'draft';
          state['activity']['id'] = 't2';
          state['activity']['receipt'] = null;
          for (final f in state['activity']['form']['fields']) {
            f['value'] = null;
          }
        case 'hide':
          state['activity']['sceneVisible'] = false;
        case 'show':
          state['activity']['sceneVisible'] = true;
        case 'update':
        case 'form-update':
          expect(
            action == 'form-update'
                ? body['binding']['activityRevision']
                : body['expectedRevision'],
            state['activity']['revision'],
          );
          for (final f in state['activity']['form']['fields']) {
            f['value'] = body['values'][f['id']];
          }
          state['activity']['revision']++;
        case 'submit':
          state['activity']['status'] = 'completed';
          state['activity']['receipt'] = {'synthetic': true};
      }
    }
    if (!state.containsKey('presentation') ||
        state['_automaticPresentation'] == true) {
      state['_automaticPresentation'] = true;
      final work = state['activeCreatureId'] == 'work';
      final task = state['activity'];
      state['presentation'] = {
        'schema': 'creature-scene.v1',
        'context': work ? 'work' : 'personal',
        'creatureId': state['activeCreatureId'],
        'body': work ? 'owl' : 'sprout',
        'tone': work ? 'precise' : 'playful',
        'surface': task == null
            ? 'none'
            : work && task['sceneVisible'] == true
            ? 'synthetic-account'
            : 'task-summary',
        'activityId': task?['id'],
        'activityRevision': task?['revision'],
        'source': 'deterministic-policy',
      };
    }
    attachChoiceFixtures(state);
    return http.Response(
      jsonEncode(state),
      200,
      headers: {'content-type': 'application/json; charset=utf-8'},
    );
  });
}

Future<void> tap(WidgetTester t, String key) async {
  final f = find.byKey(Key(key));
  await t.ensureVisible(f);
  await t.tap(f);
  await t.pumpAndSettle();
}

void main() {
  test('API rejects arbitrary routes and is pinned to loopback', () async {
    final lab = Lab();
    final api = SceneExperimentApi(lab.client);
    expect((await api.request('state'))['mode'], 'deterministic-synthetic');
    await expectLater(api.request('https://evil.test'), throwsException);
  });
  testWidgets(
    'demand creates bounded form; hide/reopen retains task; saved form submits',
    (t) async {
      final lab = Lab();
      await t.pumpWidget(
        MaterialApp(home: SceneExperiment(client: lab.client)),
      );
      await t.pumpAndSettle();
      expect(find.byType(TextField), findsNothing);
      expect(find.text('当前生物：小伴'), findsOneWidget);
      await tap(t, 'scene-work-context-vision');
      expect(find.text('当前生物：小谨'), findsOneWidget);
      await tap(t, 'scene-account-request-hearing');
      expect(
        t.widget<FilledButton>(find.byKey(const Key('scene-save'))).onPressed,
        isNull,
      );
      for (final pair in [
        ('customerAlias', 'demo-a'),
        ('accountType', 'daily'),
        ('contactPreference', 'none'),
      ]) {
        final f = find.byKey(Key('scene-field-${pair.$1}-t1-1'));
        await t.ensureVisible(f);
        await t.tap(f);
        await t.pumpAndSettle();
        await t.tap(find.text(pair.$2).last);
        await t.pumpAndSettle();
      }
      expect(
        t.widget<FilledButton>(find.byKey(const Key('scene-submit'))).onPressed,
        isNull,
      );
      await tap(t, 'scene-save');
      await tap(t, 'scene-personal-context-vision');
      expect(find.byType(DropdownButtonFormField<String>), findsNothing);
      expect(find.byKey(const Key('scene-submit')), findsNothing);
      expect(lab.state['activity']['form']['fields'][0]['value'], 'demo-a');
      await tap(t, 'scene-work-context-hearing');

      await tap(t, 'scene-visibility');
      expect(find.text('视图已隐藏，任务仍保留在内核。'), findsOneWidget);
      await t.pumpWidget(const SizedBox());
      await t.pumpWidget(
        MaterialApp(home: SceneExperiment(client: lab.client)),
      );
      await t.pumpAndSettle();
      expect(find.text('视图已隐藏，任务仍保留在内核。'), findsOneWidget);
      await tap(t, 'scene-visibility');
      await tap(t, 'scene-submit');
      expect(find.byKey(const Key('scene-receipt')), findsOneWidget);
      expect(find.byKey(const Key('scene-submit')), findsNothing);
    },
  );
  testWidgets('mutation error is explicit and refresh recovers', (t) async {
    final lab = Lab()..fail = true;
    await t.pumpWidget(MaterialApp(home: SceneExperiment(client: lab.client)));
    await t.pumpAndSettle();
    await tap(t, 'scene-work-context-vision');
    expect(find.textContaining('revision_conflict'), findsOneWidget);
    lab.fail = false;
    await tap(t, 'scene-refresh');
    expect(find.byKey(const Key('scene-error')), findsNothing);
  });
  testWidgets(
    'cancel then new clears form; uncertain only exposes reconciliation',
    (t) async {
      final lab = Lab();
      await t.pumpWidget(
        MaterialApp(home: SceneExperiment(client: lab.client)),
      );
      await t.pumpAndSettle();
      await tap(t, 'scene-account-request-hearing');
      await tap(t, 'scene-cancel');
      expect(find.text('任务已取消，历史保留。可新建空白任务。'), findsOneWidget);
      await tap(t, 'scene-new');
      expect(
        find.byKey(const Key('scene-field-customerAlias-t2-1')),
        findsOneWidget,
      );
      expect(
        t.widget<FilledButton>(find.byKey(const Key('scene-save'))).onPressed,
        isNull,
      );
      lab.state['activity']['status'] = 'submitting';
      await tap(t, 'scene-refresh');
      expect(find.byKey(const Key('scene-cancel')), findsOneWidget);
      expect(find.byKey(const Key('scene-reconcile')), findsOneWidget);
      lab.state['activity']['status'] = 'uncertain';
      await tap(t, 'scene-refresh');
      expect(find.byKey(const Key('scene-reconcile')), findsOneWidget);
      expect(find.byKey(const Key('scene-new')), findsNothing);
      expect(find.byKey(const Key('scene-cancel')), findsNothing);
    },
  );
  testWidgets('activity conflict refreshes state without replaying mutation', (
    t,
  ) async {
    final lab = Lab()
      ..fail = true
      ..failureCode = 'activity_conflict';
    await t.pumpWidget(MaterialApp(home: SceneExperiment(client: lab.client)));
    await t.pumpAndSettle();
    await tap(t, 'scene-work-context-vision');
    expect(find.textContaining('activity_conflict'), findsOneWidget);
    expect(lab.writes, 1);
    expect(
      t
          .widget<OutlinedButton>(
            find.byKey(const Key('scene-work-context-vision')),
          )
          .onPressed,
      isNull,
    );
  });
}
