import 'dart:async';
import 'dart:convert';

import 'package:material_ui/material_ui.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:summon_app/api.dart';
import 'package:summon_app/discovery.dart';

http.Response response(Object data, [int code = 200]) => http.Response(
  jsonEncode(data),
  code,
  headers: {'content-type': 'application/json; charset=utf-8'},
);
Map<String, dynamic> candidate(String id) => {
  'creatureId': id,
  'name': '主体$id',
  'service': {
    'id': 'capabilities.describe',
    'title': '说明能力',
    'effect': 'read-only',
  },
};
Map<String, dynamic> found() => {
  'status': 'needs_choice',
  'executed': false,
  'candidates': [candidate('a'), candidate('b')],
  'unavailable': [],
};
Future<void> launch(WidgetTester tester, http.Client client) =>
    tester.pumpWidget(
      MaterialApp(
        home: DiscoveryPage(
          api: SummonApi(
            endpoint: 'http://127.0.0.1:8080',
            token: 'test-token',
            client: client,
          ),
        ),
      ),
    );
Future<void> tap(WidgetTester tester, String key) async {
  final finder = find.byKey(Key(key));
  await tester.ensureVisible(finder);
  await tester.tap(finder);
  await tester.pumpAndSettle();
}

void main() {
  testWidgets(
    'discover and candidate selection never execute; only explicit selected call produces receipt',
    (tester) async {
      final paths = <String>[];
      final client = MockClient((r) async {
        paths.add(r.url.path);
        if (r.url.path == '/v1/discovery') return response(found());
        expect(r.url.path, '/v1/invocations');
        expect(jsonDecode(r.body)['creatureId'], 'b');
        return response({
          'status': 'completed',
          'serviceId': 'capabilities.describe',
          'demo': false,
          'data': {
            'services': [
              {'id': 'local.report', 'title': '本地回执'},
            ],
          },
        });
      });
      await launch(tester, client);
      await tap(tester, 'discover-global');
      expect(paths, ['/v1/discovery']);
      expect(find.byKey(const Key('invoke-selected')), findsNothing);
      await tap(tester, 'candidate-a');
      await tap(tester, 'candidate-b');
      expect(paths.length, 1);
      expect(find.byKey(const Key('service-receipt')), findsNothing);
      await tap(tester, 'invoke-selected');
      expect(paths, ['/v1/discovery', '/v1/invocations']);
      expect(find.text('本地回执'), findsOneWidget);
      expect(paths.any((p) => p.contains('sessions')), isFalse);
    },
  );
  testWidgets(
    'changed prompt invalidates candidates; failed rediscovery cannot reuse old selection',
    (tester) async {
      int requests = 0;
      final client = MockClient(
        (r) async => ++requests == 1
            ? response(found())
            : response({'error': 'unavailable'}, 503),
      );
      await launch(tester, client);
      await tap(tester, 'discover-global');
      await tap(tester, 'candidate-a');
      await tester.enterText(find.byKey(const Key('global-prompt')), '菜单');
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('candidate-a')), findsNothing);
      expect(find.byKey(const Key('invoke-selected')), findsNothing);
      await tap(tester, 'discover-global');
      expect(find.textContaining('当前没有成功回执'), findsOneWidget);
      expect(find.byKey(const Key('service-receipt')), findsNothing);
    },
  );
  testWidgets(
    'revoked stale candidate reports failure and requires rediscovery',
    (tester) async {
      final client = MockClient(
        (r) async => r.url.path == '/v1/discovery'
            ? response(found())
            : response({'error': 'outside_service_boundary'}, 403),
      );
      await launch(tester, client);
      await tap(tester, 'discover-global');
      await tap(tester, 'candidate-a');
      await tap(tester, 'invoke-selected');
      expect(find.textContaining('outside_service_boundary'), findsOneWidget);
      expect(find.byKey(const Key('invoke-selected')), findsNothing);
      expect(find.byKey(const Key('service-receipt')), findsNothing);
    },
  );
  testWidgets(
    'unavailable and unrecognized calls are explanatory and never actionable',
    (tester) async {
      int requests = 0;
      final client = MockClient(
        (r) async => response(
          ++requests == 1
              ? {
                  'status': 'unavailable',
                  'candidates': [],
                  'unavailable': [
                    {
                      ...candidate('a'),
                      'reason': 'outside_simulated_activity_space',
                    },
                  ],
                }
              : {
                  'status': 'needs_clarification',
                  'candidates': [],
                  'unavailable': [],
                },
        ),
      );
      await launch(tester, client);
      await tap(tester, 'discover-global');
      expect(find.text('不在所选模拟活动空间内'), findsOneWidget);
      expect(find.byKey(const Key('invoke-selected')), findsNothing);
      await tap(tester, 'discover-global');
      expect(find.textContaining('暂不理解'), findsOneWidget);
      expect(find.text('不在所选模拟活动空间内'), findsNothing);
    },
  );
  testWidgets(
    'pending discovery suppresses repeat and tolerates leaving page',
    (tester) async {
      final pending = Completer<http.Response>();
      int requests = 0;
      await launch(
        tester,
        MockClient((_) {
          requests++;
          return pending.future;
        }),
      );
      await tester.tap(find.byKey(const Key('discover-global')));
      await tester.pump();
      await tester.tap(find.byKey(const Key('discover-global')));
      await tester.pump();
      expect(requests, 1);
      await tester.pumpWidget(const SizedBox());
      pending.complete(response(found()));
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull);
    },
  );
  testWidgets(
    'small viewport supports simulated zone choice and menu presentation',
    (tester) async {
      tester.view.physicalSize = const Size(320, 568);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final client = MockClient((r) async {
        expect(jsonDecode(r.body)['context']['zone'], 'demo-restaurant');
        if (r.url.path == '/v1/discovery') {
          return response({
            'status': 'proposed',
            'unavailable': [],
            'candidates': [
              {
                'creatureId': 'r',
                'name': '餐馆',
                'service': {
                  'id': 'menu.read',
                  'title': '菜单',
                  'effect': 'read-only',
                },
              },
            ],
          });
        }
        return response({
          'status': 'completed',
          'serviceId': 'menu.read',
          'demo': true,
          'data': {
            'currency': 'USD',
            'items': [
              {'name': '演示茶饮', 'priceMinor': 300},
            ],
          },
        });
      });
      await launch(tester, client);
      await tester.tap(find.byKey(const Key('simulation-zone')));
      await tester.pumpAndSettle();
      await tester.tap(find.text('模拟空间：餐馆').last);
      await tester.pumpAndSettle();
      await tap(tester, 'discover-global');
      expect(find.byKey(const Key('invoke-selected')), findsNothing);
      await tap(tester, 'candidate-r');
      await tap(tester, 'invoke-selected');
      expect(find.text('USD 3.00 · 仅展示'), findsOneWidget);
      expect(tester.takeException(), isNull);
    },
  );
}
