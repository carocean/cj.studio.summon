import 'dart:async';

import 'package:http/http.dart' as http;
import 'package:material_ui/material_ui.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/testing.dart';
import 'package:summon_app/creature_workbench.dart';

import 'scene_experiment_test.dart' show Lab;

Future<void> settle(WidgetTester t) async {
  for (var i = 0; i < 8; i++) {
    await t.pump(const Duration(milliseconds: 80));
  }
}

Future<void> click(WidgetTester t, String key) async {
  final f = find.byKey(Key(key));
  await t.ensureVisible(f);
  await t.tap(f);
  await settle(t);
}

void main() {
  testWidgets(
    'living visible creature animates, reacts, and navigates to perception without text box',
    (t) async {
      await t.pumpWidget(
        MaterialApp(home: CreatureWorkbench(client: Lab().client)),
      );
      await settle(t);
      expect(find.text('小伴'), findsOneWidget);
      expect(find.byType(TextField), findsNothing);
      CreaturePainter painter() => t
          .widgetList<CustomPaint>(find.byType(CustomPaint))
          .map((w) => w.painter)
          .whereType<CreaturePainter>()
          .first;
      final initial = painter().phase;
      await t.pump(const Duration(milliseconds: 300));
      expect(painter().phase, isNot(initial));
      await click(t, 'creature-touch');
      expect(find.text('我在这里。'), findsOneWidget);
      await click(t, 'creature-hear');
      expect(find.text('小伴 · 听觉'), findsOneWidget);
      expect(find.text('当前绑定：小伴（companion）'), findsOneWidget);
      await t.pageBack();
      await settle(t);
      expect(find.text('小伴'), findsOneWidget);
      await click(t, 'creature-demo');
      await click(t, 'creature-see');
      expect(find.text('小谨 · 视觉'), findsOneWidget);
      expect(find.text('当前绑定：小谨（work）'), findsOneWidget);
    },
  );
  testWidgets('offline never simulates successful context change', (t) async {
    await t.pumpWidget(
      MaterialApp(
        home: CreatureWorkbench(
          client: MockClient((_) => throw StateError('offline')),
        ),
      ),
    );
    await settle(t);
    expect(find.byKey(const Key('creature-offline')), findsOneWidget);
    await click(t, 'creature-demo');
    expect(find.text('生物预览'), findsOneWidget);
    expect(find.text('小谨'), findsNothing);
  });
  testWidgets(
    'synthetic context creates bounded workbench, hiding retains task and personal scene hides fields',
    (t) async {
      final lab = Lab();
      await t.pumpWidget(
        MaterialApp(home: CreatureWorkbench(client: lab.client)),
      );
      await settle(t);
      await click(t, 'creature-demo');
      expect(find.text('小谨'), findsOneWidget);
      await click(t, 'creature-request-form');
      expect(find.byType(DropdownButtonFormField<String>), findsNWidgets(3));
      await click(t, 'scene-visibility');
      expect(lab.state['activity']['sceneVisible'], isFalse);
      expect(find.byType(DropdownButtonFormField<String>), findsNothing);
      await click(t, 'creature-demo');
      expect(find.text('小伴'), findsOneWidget);
      expect(find.byType(DropdownButtonFormField<String>), findsNothing);
      expect(lab.state['activity']['id'], 't1');
      await click(t, 'creature-demo');
      await click(t, 'scene-visibility');
      expect(find.byType(DropdownButtonFormField<String>), findsNWidgets(3));
      expect(find.text('模拟视觉：看见工作情境'), findsNothing);
    },
  );
  for (final attack in [
    'unknown-body',
    'wrong-task',
    'personal-work',
    'wrong-revision',
    'missing-declaration',
    'missing-revision',
  ]) {
    testWidgets('untrusted presentation cannot expose fields: $attack', (
      t,
    ) async {
      final lab = Lab();
      lab.state['activeCreatureId'] = attack == 'personal-work'
          ? 'companion'
          : 'work';
      lab.state['activity'] = {
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
              'type': 'choice',
              'label': '不得展示',
              'options': ['demo-a'],
              'value': null,
            },
          ],
        },
      };
      lab.state['presentation'] = {
        'schema': 'creature-scene.v1',
        'context': 'work',
        'creatureId': 'work',
        'body': attack == 'unknown-body' ? 'https://untrusted.test' : 'owl',
        'tone': 'precise',
        'surface': 'synthetic-account',
        'activityId': attack == 'wrong-task' ? 'other' : 't1',
        if (attack != 'missing-revision')
          'activityRevision': attack == 'wrong-revision' ? 8 : 1,
        'source': 'deterministic-policy',
      };
      if (attack == 'missing-declaration') lab.state['presentation'] = null;
      await t.pumpWidget(
        MaterialApp(home: CreatureWorkbench(client: lab.client)),
      );
      await settle(t);
      expect(find.byType(DropdownButtonFormField<String>), findsNothing);
      expect(find.text('不得展示'), findsNothing);
    });
  }
  testWidgets(
    'late workbench response cannot restore work after personal switch',
    (t) async {
      final lab = Lab();
      final pending = Completer<http.Response>();
      http.Response? oldWorkResponse;
      final client = MockClient((request) async {
        final response = request.method == 'GET'
            ? await lab.client.get(request.url, headers: request.headers)
            : await lab.client.post(
                request.url,
                headers: request.headers,
                body: request.body,
              );
        if (request.url.path.endsWith('/hide')) {
          oldWorkResponse = response;
          return pending.future;
        }
        return response;
      });
      await t.pumpWidget(MaterialApp(home: CreatureWorkbench(client: client)));
      await settle(t);
      await click(t, 'creature-demo');
      await click(t, 'creature-request-form');
      await click(t, 'scene-visibility');
      expect(oldWorkResponse, isNotNull);
      await click(t, 'creature-demo');
      expect(find.text('小伴'), findsOneWidget);
      pending.complete(oldWorkResponse!);
      await settle(t);
      expect(find.text('小伴'), findsOneWidget);
      expect(find.text('小谨'), findsNothing);
      expect(find.byType(DropdownButtonFormField<String>), findsNothing);
    },
  );
}
