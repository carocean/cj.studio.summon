import 'dart:async';
import 'dart:convert';

import 'package:material_ui/material_ui.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:summon_app/creature_workbench.dart';
import 'package:summon_app/scene_experiment.dart';
import 'package:summon_app/scene_text_entry.dart';

import 'scene_experiment_test.dart' show Lab;

const frame = {'creatureId': 'companion', 'sceneRevision': 1};
Map<String, dynamic> declaration() => {
  'schema': 'scene-text-entry.v1',
  'context': frame,
  'maxLength': 200,
  'source': 'deterministic-policy',
};
Map<String, dynamic> state() => {
  ...Lab().state,
  'context': frame,
  'textEntry': declaration(),
};
http.Response response(Object value) => http.Response(
  jsonEncode(value),
  200,
  headers: {'content-type': 'application/json; charset=utf-8'},
);
Future<void> settle(WidgetTester t) async {
  for (var i = 0; i < 6; i++) {
    await t.pump(const Duration(milliseconds: 80));
  }
}

Future<void> tap(WidgetTester t, String key) async {
  await t.pump();
  final f = find.byKey(Key(key));
  await t.ensureVisible(f);
  await t.tap(f);
  await settle(t);
}

void main() {
  test(
    'text declaration is context-bound and closed, never inferred from UI text',
    () {
      expect(trustedTextEntry(state()), frame);
      for (final invalid in [
        null,
        {...declaration(), 'maxLength': 201},
        {...declaration(), 'source': 'model'},
        {...declaration(), 'extra': true},
        {
          ...declaration(),
          'context': {'creatureId': 'work', 'sceneRevision': 1},
        },
        {
          ...declaration(),
          'context': {'creatureId': 'companion', 'sceneRevision': 2},
        },
      ]) {
        expect(trustedTextEntry({...state(), 'textEntry': invalid}), null);
      }
    },
  );
  testWidgets(
    'home has no default text field; request creates it; submit has explicit direct-input semantics',
    (t) async {
      var current = {...state()}..remove('textEntry');
      final writes = <Map<String, dynamic>>[];
      final client = MockClient((r) async {
        if (r.method == 'POST') {
          final b = Map<String, dynamic>.from(jsonDecode(r.body));
          writes.add(b);
          if (r.url.path.endsWith('/text-entry')) {
            current = {...current, 'textEntry': declaration()};
          } else if (r.url.path.endsWith('/text-request')) {
            current = {...current}..remove('textEntry');
          }
        }
        return response(current);
      });
      await t.pumpWidget(MaterialApp(home: CreatureWorkbench(client: client)));
      await settle(t);
      expect(find.byType(TextField), findsNothing);
      await tap(t, 'creature-text');
      expect(find.byType(TextField), findsOneWidget);
      await t.enterText(find.byKey(const Key('scene-text-input')), '开始工作');
      await tap(t, 'scene-text-submit');
      expect(writes.last, {
        'context': frame,
        'text': '开始工作',
        'confirmation': 'apply-direct-text-scene',
      });
      expect(find.byType(TextField), findsNothing);
    },
  );
  testWidgets(
    'duplicate submit blocked; background clears draft and ignores late response',
    (t) async {
      final pending = Completer<http.Response>();
      var calls = 0, changes = 0;
      final api = SceneExperimentApi(
        MockClient((r) {
          calls++;
          return pending.future;
        }),
      );
      await t.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: SceneTextEntry(
              api: api,
              frame: frame,
              onState: (_) {
                changes++;
              },
            ),
          ),
        ),
      );
      await t.enterText(find.byKey(const Key('scene-text-input')), '模拟开户');
      await tap(t, 'scene-text-submit');
      await tap(t, 'scene-text-submit');
      expect(calls, 1);
      t.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
      await t.pump();
      expect(t.widget<TextField>(find.byType(TextField)).controller!.text, '');
      pending.complete(response(state()));
      await settle(t);
      expect(changes, 0);
      t.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      await settle(t);
      expect(find.byKey(const Key('scene-text-refresh')), findsOneWidget);
    },
  );
  testWidgets('close clears raw input and context replacement discards draft', (
    t,
  ) async {
    Map<String, dynamic>? sent;
    final api = SceneExperimentApi(
      MockClient((r) async {
        sent = Map<String, dynamic>.from(jsonDecode(r.body));
        return response(state());
      }),
    );
    Widget ui(Map<String, dynamic> f) => MaterialApp(
      home: Scaffold(
        body: SceneTextEntry(api: api, frame: f, onState: (_) {}),
      ),
    );
    await t.pumpWidget(ui(frame));
    await t.enterText(find.byType(TextField), '开始工作');
    await t.pumpWidget(ui({'creatureId': 'work', 'sceneRevision': 2}));
    expect(t.widget<TextField>(find.byType(TextField)).controller!.text, '');
    await t.enterText(find.byType(TextField), '回到伙伴');
    await tap(t, 'scene-text-close');
    expect(sent, {
      'context': {'creatureId': 'work', 'sceneRevision': 2},
      'visible': false,
    });
    expect(t.widget<TextField>(find.byType(TextField)).controller!.text, '');
  });
  testWidgets(
    'unsupported finite command remains editable without an automatic retry',
    (t) async {
      var calls = 0;
      final api = SceneExperimentApi(
        MockClient((r) async {
          calls++;
          return http.Response('{"error":"unsupported_text_request"}', 400);
        }),
      );
      await t.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: SceneTextEntry(api: api, frame: frame, onState: (_) {}),
          ),
        ),
      );
      await t.enterText(find.byType(TextField), '不要开始工作');
      await tap(t, 'scene-text-submit');
      expect(calls, 1);
      expect(find.byKey(const Key('scene-text-refresh')), findsNothing);
      expect(t.widget<TextField>(find.byType(TextField)).enabled, true);
      expect(find.textContaining('这句话不在有限口令内'), findsOneWidget);
    },
  );
  testWidgets('newer home navigation wins over a late text response', (
    t,
  ) async {
    final pending = Completer<http.Response>();
    var current = state();
    final client = MockClient((r) async {
      if (r.url.path.endsWith('/text-request')) return pending.future;
      if (r.url.path.endsWith('/perceive')) {
        current = {
          ...current,
          'activeCreatureId': 'work',
          'context': {'creatureId': 'work', 'sceneRevision': 2},
        }..remove('textEntry');
      }
      return response(current);
    });
    await t.pumpWidget(MaterialApp(home: CreatureWorkbench(client: client)));
    await settle(t);
    await t.enterText(find.byType(TextField), '开始工作');
    await tap(t, 'scene-text-submit');
    await tap(t, 'creature-demo');
    expect(find.byType(TextField), findsNothing);
    pending.complete(response(state()));
    await settle(t);
    expect(find.text('小谨'), findsOneWidget);
    expect(find.byType(TextField), findsNothing);
  });
}
