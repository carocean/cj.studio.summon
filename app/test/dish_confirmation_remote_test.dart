import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:material_ui/material_ui.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:summon_app/dish_confirmation_remote_surface.dart';
import 'package:summon_app/protected_preview_client.dart';
import 'package:summon_app/scene_experiment.dart';

import 'dish_confirmation_test.dart' show fixture;

http.Response answer(Map<String, dynamic> body, [int status = 200]) =>
    http.Response(
      jsonEncode(body),
      status,
      headers: {'content-type': 'application/json'},
    );
Map<String, dynamic> dish({bool details = false}) => {
  'sessionId': 'meal',
  'revision': details ? 5 : 4,
  'context': {'creatureId': 'companion', 'sceneRevision': 1},
  'focus': {
    'schema': 'dish-focus.v1',
    'taskId': 'meal-task',
    'catalogDigest': 'sha256:${'a' * 64}',
    'revision': details ? 5 : 4,
    'lastSpeechSequence': 1,
    'dishId': 'soup',
    'speech': {'sequence': 1, 'phase': 'stopped'},
    'view': details ? 'details' : 'none',
    'zoomPermille': 1000,
  },
  'presentation': {
    'name': '合成汤',
    'description': '同菜已核验说明',
    'imageRef': 'synthetic-soup',
    'synthetic': true,
  },
};
void noSwitch() {}
Widget mounted(
  SceneExperimentApi api,
  ValueNotifier<bool> access, {
  String sessionId = 'meal',
  VoidCallback onSwitch = noSwitch,
}) => MaterialApp(
  home: DishConfirmationRemoteSurface(
    api: api,
    access: access,
    sessionId: sessionId,
    onSwitchRequest: onSwitch,
  ),
);
void main() {
  testWidgets(
    'initially unavailable access closes without read or auto regrant',
    (t) async {
      final access = ValueNotifier(false), calls = <String>[];
      final client = MockClient((r) async {
        calls.add(r.url.path);
        return answer(fixture(state: 'expired'));
      });
      await t.pumpWidget(mounted(SceneExperimentApi(client), access));
      await t.pumpAndSettle();
      access.value = true;
      await t.pumpAndSettle();
      expect(calls, ['/scene/dish-confirmation-invalidate']);
      expect(find.text('展开说明'), findsNothing);
      await t.pumpWidget(const SizedBox());
      await t.pumpAndSettle();
      client.close();
      access.dispose();
    },
  );
  testWidgets(
    'protected explicit click renders verified same dish; close does not claim rollback',
    (t) async {
      final access = ValueNotifier(true), calls = <Map<String, dynamic>>[];
      var confirmed = false, switches = 0;
      final client = ProtectedPreviewClient.forTesting(
        origin: Uri.parse('https://preview.example'),
        csrf: 'a' * 43,
        client: MockClient((r) async {
          expect(r.url.origin, 'https://preview.example');
          expect(
            r.headers['X-Preview-CSRF'] ?? r.headers['x-preview-csrf'],
            'a' * 43,
          );
          expect(r.method, 'POST');
          calls.add({'path': r.url.path, 'body': jsonDecode(r.body)});
          if (r.url.path.endsWith('/dish-read')) {
            return answer(dish(details: confirmed));
          }
          if (r.url.path.endsWith('-read')) return answer(fixture());
          if (r.url.path.endsWith('-respond')) {
            confirmed = true;
            return answer(fixture(state: 'presented'));
          }
          return answer(fixture(state: 'expired'));
        }),
      );
      final api = SceneExperimentApi(client);
      void switchRequest() {
        switches++;
      }

      await t.pumpWidget(mounted(api, access, onSwitch: switchRequest));
      await t.pumpAndSettle();
      expect(calls, hasLength(2));
      expect(find.text('同菜已核验说明'), findsNothing);
      await t.pumpWidget(mounted(api, access, onSwitch: switchRequest));
      await t.pumpAndSettle();
      expect(calls, hasLength(2));
      await t.tap(find.text('展开说明'));
      await t.pumpAndSettle();
      expect(find.text('同菜已核验说明'), findsOneWidget);
      expect(find.text('已展开当前菜品说明。'), findsOneWidget);
      expect(find.byType(EditableText), findsNothing);
      expect(calls[2]['body'], {'interactionId': 'a' * 32, 'choice': 'show'});
      expect(calls[3]['body'], {'sessionId': 'meal'});
      expect(calls.where((r) => r['path'] == '/scene/dish-command'), isEmpty);
      await t.tap(find.text('切换需求 / 收起'));
      await t.pumpAndSettle();
      expect(switches, 1);
      expect(confirmed, true);
      expect(find.text('同菜已核验说明'), findsNothing);
      expect(find.text('本机界面已关闭；已提交的结果不会因此撤销。'), findsOneWidget);
      await t.pumpWidget(const SizedBox());
      await t.pumpAndSettle();
      client.close();
      access.dispose();
    },
  );
  for (final variation in [
    'session',
    'task',
    'dish',
    'catalog',
    'creature',
    'scene',
    'sequence',
    'name',
    'revision',
    'view',
    'description',
    'read-failure',
  ]) {
    testWidgets('reject details with changed $variation binding', (t) async {
      final access = ValueNotifier(true);
      var confirmed = false;
      final client = MockClient((r) async {
        if (r.url.path.endsWith('/dish-read')) {
          if (confirmed && variation == 'read-failure') {
            return answer({'error': 'failed'}, 500);
          }
          final v = dish(details: confirmed);
          if (confirmed) {
            switch (variation) {
              case 'session':
                v['sessionId'] = 'another';
                break;
              case 'task':
                (v['focus'] as Map)['taskId'] = 'another';
                break;
              case 'dish':
                (v['focus'] as Map)['dishId'] = 'another';
                break;
              case 'catalog':
                (v['focus'] as Map)['catalogDigest'] = 'sha256:${'b' * 64}';
                break;
              case 'creature':
                (v['context'] as Map)['creatureId'] = 'work';
                break;
              case 'scene':
                (v['context'] as Map)['sceneRevision'] = 2;
                break;
              case 'sequence':
                (v['focus'] as Map)['lastSpeechSequence'] = 2;
                ((v['focus'] as Map)['speech'] as Map)['sequence'] = 2;
                break;
              case 'name':
                (v['presentation'] as Map)['name'] = '另一道';
                break;
              case 'revision':
                v['revision'] = 6;
                (v['focus'] as Map)['revision'] = 6;
                break;
              case 'view':
                (v['focus'] as Map)['view'] = 'none';
                break;
              case 'description':
                (v['presentation'] as Map)['description'] = '未绑定内容';
                break;
            }
          }
          return answer(v);
        }
        if (r.url.path.endsWith('-read')) return answer(fixture());
        if (r.url.path.endsWith('-respond')) {
          confirmed = true;
          return answer(fixture(state: 'presented'));
        }
        return answer(fixture(state: 'expired'));
      });
      await t.pumpWidget(mounted(SceneExperimentApi(client), access));
      await t.pumpAndSettle();
      await t.tap(find.text('展开说明'));
      await t.pumpAndSettle();
      expect(find.text('同菜已核验说明'), findsNothing);
      expect(find.text('未绑定内容'), findsNothing);
      expect(find.text('已展开当前菜品说明。'), findsNothing);
      await t.pumpWidget(const SizedBox());
      await t.pumpAndSettle();
      client.close();
      access.dispose();
    });
  }
  for (final invalid in [
    'name',
    'not-stopped',
    'already-details',
    'wrong-session',
  ]) {
    testWidgets('reject initial pending binding $invalid', (t) async {
      final access = ValueNotifier(true);
      var responds = 0;
      final client = MockClient((r) async {
        if (r.url.path.endsWith('/dish-read')) {
          final v = dish(details: invalid == 'already-details');
          if (invalid == 'name') (v['presentation'] as Map)['name'] = '错菜';
          if (invalid == 'not-stopped') {
            ((v['focus'] as Map)['speech'] as Map)['phase'] = 'stop-required';
          }
          if (invalid == 'wrong-session') v['sessionId'] = 'another';
          return answer(v);
        }
        if (r.url.path.endsWith('-read')) return answer(fixture());
        if (r.url.path.endsWith('-respond')) responds++;
        return answer(fixture(state: 'expired'));
      });
      await t.pumpWidget(mounted(SceneExperimentApi(client), access));
      await t.pumpAndSettle();
      expect(find.text('展开说明'), findsNothing);
      expect(find.text('同菜已核验说明'), findsNothing);
      expect(responds, 0);
      await t.pumpWidget(const SizedBox());
      await t.pumpAndSettle();
      client.close();
      access.dispose();
    });
  }
  for (final change in [
    'revoke',
    'switch',
    'session',
    'api',
    'dispose',
    'background',
  ]) {
    testWidgets('late details after $change never leak', (t) async {
      final access = ValueNotifier(true), late = Completer<http.Response>();
      var confirmed = false;
      final client = MockClient((r) async {
        if (r.url.path.endsWith('/dish-read')) {
          return confirmed ? late.future : answer(dish());
        }
        if (r.url.path.endsWith('-read')) return answer(fixture());
        if (r.url.path.endsWith('-respond')) {
          confirmed = true;
          return answer(fixture(state: 'presented'));
        }
        return answer(fixture(state: 'expired'));
      });
      final api = SceneExperimentApi(client);
      await t.pumpWidget(mounted(api, access));
      await t.pumpAndSettle();
      await t.tap(find.text('展开说明'));
      await t.pumpAndSettle();
      switch (change) {
        case 'revoke':
          access.value = false;
          break;
        case 'switch':
          await t.tap(find.text('切换需求 / 收起'));
          break;
        case 'session':
          await t.pumpWidget(mounted(api, access, sessionId: 'other'));
          break;
        case 'api':
          await t.pumpWidget(mounted(SceneExperimentApi(client), access));
          break;
        case 'dispose':
          await t.pumpWidget(const SizedBox());
          break;
        case 'background':
          t.binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
          break;
      }
      await t.pumpAndSettle();
      late.complete(answer(dish(details: true)));
      await t.pumpAndSettle();
      access.value = true;
      t.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      await t.pumpAndSettle();
      expect(find.text('同菜已核验说明'), findsNothing);
      expect(find.text('已展开当前菜品说明。'), findsNothing);
      await t.pumpWidget(const SizedBox());
      await t.pumpAndSettle();
      client.close();
      access.dispose();
    });
  }
  testWidgets('failed invalidation is explicit and no auto retry', (t) async {
    final access = ValueNotifier(true);
    var invalidations = 0;
    final client = MockClient((r) async {
      if (r.url.path.endsWith('/dish-read')) return answer(dish());
      if (r.url.path.endsWith('-read')) return answer(fixture());
      invalidations++;
      return answer({'error': 'failed'}, 503);
    });
    await t.pumpWidget(mounted(SceneExperimentApi(client), access));
    await t.pumpAndSettle();
    access.value = false;
    await t.pumpAndSettle();
    access.value = true;
    await t.pumpAndSettle();
    expect(find.text('本机确认已关闭；尚未确认服务器撤销，不会重试。'), findsOneWidget);
    expect(invalidations, 1);
    await t.pumpWidget(const SizedBox());
    await t.pumpAndSettle();
    client.close();
    access.dispose();
  });
}
