import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:material_ui/material_ui.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:summon_app/dish_remote_surface.dart';
import 'package:summon_app/protected_preview_client.dart';
import 'package:summon_app/scene_experiment.dart';

Map<String, dynamic> view(int revision, {String mode = 'details'}) => {
  'sessionId': 'meal',
  'revision': revision,
  'context': {'creatureId': 'work', 'sceneRevision': 1},
  'focus': {
    'schema': 'dish-focus.v1',
    'taskId': 'meal-task',
    'catalogDigest': 'sha256:${'a' * 64}',
    'revision': revision,
    'lastSpeechSequence': 1,
    'dishId': 'soup',
    'speech': {'sequence': 1, 'phase': 'stopped'},
    'view': mode,
    'zoomPermille': mode == 'image' && revision > 5 ? 1250 : 1000,
  },
  'presentation': {
    'name': '合成汤',
    'description': '合成说明',
    'imageRef': 'synthetic-soup',
    'synthetic': true,
  },
};
http.Response response(Map<String, dynamic> v) => http.Response(
  jsonEncode(v),
  200,
  headers: {'content-type': 'application/json'},
);
void main() {
  testWidgets(
    'protected client renders same-dish explanation then image and zoom without stop authority',
    (t) async {
      final access = ValueNotifier(true), requests = <Map<String, dynamic>>[];
      var revision = 4;
      final client = ProtectedPreviewClient.forTesting(
        origin: Uri.parse('https://preview.example'),
        csrf: 'a' * 43,
        client: MockClient((r) async {
          expect(r.url.origin, 'https://preview.example');
          expect(
            r.headers['X-Preview-CSRF'] ?? r.headers['x-preview-csrf'],
            'a' * 43,
          );
          final input = jsonDecode(r.body) as Map<String, dynamic>;
          requests.add(input);
          if (r.url.path.endsWith('dish-read')) return response(view(revision));
          final cmd = input['command'] as Map;
          expect(cmd['expectedRevision'], revision);
          expect(['image', 'zoom'], contains(cmd['kind']));
          revision++;
          return response(view(revision, mode: 'image'));
        }),
      );
      await t.pumpWidget(
        MaterialApp(
          home: DishRemoteSurface(
            api: SceneExperimentApi(client),
            sessionId: 'meal',
            creatureId: 'work',
            sceneRevision: 1,
            access: access,
          ),
        ),
      );
      await t.pumpAndSettle();
      expect(find.text('合成说明'), findsOneWidget);
      await t.tap(find.text('查看合成插画'));
      await t.pumpAndSettle();
      expect(find.byKey(const Key('dish-synthetic-image')), findsOneWidget);
      await t.tap(find.byKey(const Key('dish-zoom-in')));
      await t.pumpAndSettle();
      expect(revision, 6);
      expect(requests.length, 3);
      access.value = false;
      await t.pumpAndSettle();
      expect(find.byKey(const Key('dish-synthetic-image')), findsNothing);
      client.close();
      access.dispose();
    },
  );
  testWidgets('late response after access revocation cannot restore display', (
    t,
  ) async {
    final access = ValueNotifier(true), pending = Completer<http.Response>();
    final client = MockClient((_) => pending.future);
    await t.pumpWidget(
      MaterialApp(
        home: DishRemoteSurface(
          api: SceneExperimentApi(client),
          sessionId: 'meal',
          creatureId: 'work',
          sceneRevision: 1,
          access: access,
        ),
      ),
    );
    await t.pump();
    access.value = false;
    await t.pump();
    pending.complete(response(view(4)));
    await t.pumpAndSettle();
    expect(find.text('合成说明'), findsNothing);
    expect(find.byKey(const Key('dish-remote-error')), findsOneWidget);
    client.close();
    access.dispose();
  });
  testWidgets(
    'wrong context and malformed responses fail closed without retries',
    (t) async {
      final access = ValueNotifier(true);
      var calls = 0;
      final client = MockClient((_) async {
        calls++;
        final v = view(4);
        v['context'] = {'creatureId': 'other', 'sceneRevision': 1};
        return response(v);
      });
      await t.pumpWidget(
        MaterialApp(
          home: DishRemoteSurface(
            api: SceneExperimentApi(client),
            sessionId: 'meal',
            creatureId: 'work',
            sceneRevision: 1,
            access: access,
          ),
        ),
      );
      await t.pumpAndSettle();
      expect(find.text('合成说明'), findsNothing);
      expect(calls, 1);
      expect(find.byKey(const Key('dish-remote-error')), findsOneWidget);
      client.close();
      access.dispose();
    },
  );
}
