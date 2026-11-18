import 'package:flutter_test/flutter_test.dart';
import 'package:material_ui/material_ui.dart';
import 'package:summon_app/dish_surface.dart';

Map<String, dynamic> fixture({String view = 'details', int zoom = 1000}) => {
  'sessionId': 'meal',
  'revision': 4,
  'context': <String, dynamic>{'creatureId': 'work', 'sceneRevision': 1},
  'focus': <String, dynamic>{
    'schema': 'dish-focus.v1',
    'taskId': 'meal-task',
    'catalogDigest': 'sha256:${'a' * 64}',
    'revision': 4,
    'lastSpeechSequence': 1,
    'dishId': 'soup',
    'speech': {'sequence': 1, 'phase': 'stopped'},
    'view': view,
    'zoomPermille': zoom,
  },
  'presentation': <String, dynamic>{
    'name': '合成汤',
    'description': '仅用于协议演示',
    'imageRef': 'synthetic-soup',
    'synthetic': true,
  },
};
void main() {
  test(
    'strict immutable parser accepts stopped presentations and detached values',
    () {
      final raw = fixture();
      final v = DishView.parse(raw);
      (raw['presentation'] as Map)['name'] = 'changed';
      expect(v.name, '合成汤');
      expect(v.view, 'details');
      final empty = fixture(view: 'none');
      (empty['focus'] as Map).addAll(<String, dynamic>{
        'dishId': null,
        'speech': null,
        'lastSpeechSequence': 0,
      });
      empty['presentation'] = null;
      expect(DishView.parse(empty).dishId, isNull);
    },
  );
  test('rejects untrusted schemas, remote images, inconsistent state and revisions', () {
    final mutations = <void Function(Map<String, dynamic>)>[
      (r) => r['extra'] = true,
      (r) => r['revision'] = 5,
      (r) => r['revision'] = 4.0,
      (r) => (r['context'] as Map)['sceneRevision'] = 0,
      (r) => (r['focus'] as Map)['schema'] = 'other',
      (r) => (r['focus'] as Map)['catalogDigest'] = 'sha256:bad',
      (r) => (r['focus'] as Map)['zoomPermille'] = 1250,
      (r) =>
          (r['focus'] as Map)['speech'] = {'sequence': 2, 'phase': 'stopped'},
      (r) => (r['focus'] as Map)['speech'] = {
        'sequence': 1,
        'phase': 'playback-requested',
      },
      (r) => (r['focus'] as Map)['speech'] = null,
      (r) => (r['focus'] as Map)['dishId'] = null,
      (r) => (r['presentation'] as Map)['imageRef'] =
          'https://example.com/soup.jpg',
      (r) => (r['presentation'] as Map)['imageRef'] = 'unknown-local',
      (r) => (r['presentation'] as Map)['synthetic'] = false,
      (r) => (r['presentation'] as Map)['name'] = '',
      (r) => (r['presentation'] as Map)['description'] = 'bad\ntext',
      (r) => r['presentation'] = null,
    ];
    for (final change in mutations) {
      final r = fixture();
      change(r);
      expect(() => DishView.parse(r), throwsFormatException);
    }
    final noImage = fixture(view: 'image');
    (noImage['presentation'] as Map)['imageRef'] = null;
    expect(() => DishView.parse(noImage), throwsFormatException);
    expect(
      () => DishView.parse(fixture(view: 'image', zoom: 3250)),
      throwsFormatException,
    );
  });
  testWidgets('none has no default controls or text', (tester) async {
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: DishSurface(
            view: DishView.parse(fixture(view: 'none')),
            onCommand: (kind, {direction}) {},
          ),
        ),
      ),
    );
    expect(find.byType(TextButton), findsNothing);
    expect(find.text('合成汤'), findsNothing);
  });
  testWidgets('details render and image request emits only user command', (
    tester,
  ) async {
    final calls = <String>[];
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: DishSurface(
            view: DishView.parse(fixture()),
            onCommand: (kind, {direction}) {
              calls.add(kind);
            },
          ),
        ),
      ),
    );
    expect(find.text('仅用于协议演示'), findsOneWidget);
    await tester.tap(find.text('查看合成插画'));
    expect(calls, ['image']);
    expect(find.byType(Image), findsNothing);
    await tester.tap(find.text('收起'));
    expect(calls, ['image', 'hide']);
  });
  testWidgets(
    'local image zoom remains authoritative and bounds disable commands',
    (tester) async {
      final calls = <String>[];
      Future<void> show(int zoom) => tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: DishSurface(
              view: DishView.parse(fixture(view: 'image', zoom: zoom)),
              onCommand: (kind, {direction}) {
                calls.add('$kind:$direction');
              },
            ),
          ),
        ),
      );
      await show(1000);
      expect(find.byKey(const Key('dish-synthetic-image')), findsOneWidget);
      expect(find.text('缩放 100%'), findsOneWidget);
      expect(
        tester
            .widget<TextButton>(find.byKey(const Key('dish-zoom-out')))
            .onPressed,
        isNull,
      );
      await tester.tap(find.text('放大'));
      await tester.pump();
      expect(calls, ['zoom:in']);
      expect(find.text('缩放 100%'), findsOneWidget);
      await show(3000);
      expect(
        tester
            .widget<TextButton>(find.byKey(const Key('dish-zoom-in')))
            .onPressed,
        isNull,
      );
      await tester.tap(find.text('菜品说明'));
      expect(calls.last, 'details:null');
      expect(find.byType(Image), findsNothing);
    },
  );
  testWidgets('null description and missing illustration are explicit', (
    tester,
  ) async {
    final r = fixture();
    (r['presentation'] as Map).addAll(<String, dynamic>{
      'description': null,
      'imageRef': null,
    });
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: DishSurface(
            view: DishView.parse(r),
            onCommand: (kind, {direction}) {},
          ),
        ),
      ),
    );
    expect(find.text('暂无菜品说明'), findsOneWidget);
    expect(find.text('查看合成插画'), findsNothing);
  });
}
