import 'dart:convert';

import 'choice_form_fixtures.dart';

import 'package:material_ui/material_ui.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:summon_app/creature_market.dart';

Map<String, dynamic> receipt() => {
  'receiptId': 'r1',
  'requestId': 'q1',
  'providerId': 'demo-maps',
  'productId': marketProduct,
  'instanceId': 'maps-one',
  'serviceId': 'synthetic.route.v1',
  'serviceVersion': 1,
  'input': {'from': 'A', 'to': 'C'},
  'result': {
    'path': ['A', 'B', 'C'],
    'hops': 2,
  },
  'source': 'deterministic-synthetic-route',
};
Map<String, dynamic> state() {
  final r = receipt();
  return {
    'mode': 'deterministic-synthetic',
    'activeCreatureId': 'maps-one',
    'primaryCreatureId': 'companion',
    'creatures': [
      {'id': 'maps-one', 'kind': 'business', 'body': 'owl', 'tone': 'precise'},
    ],
    'presentation': {
      'schema': 'creature-scene.v1',
      'source': 'deterministic-policy',
      'creatureId': 'maps-one',
      'body': 'owl',
      'tone': 'precise',
      'surface': 'synthetic-route',
    },
    'route': {
      'visible': true,
      'replayed': false,
      'receipt': r,
      'render': {
        'schema': 'synthetic-route.v1',
        for (final k in [
          'receiptId',
          'providerId',
          'productId',
          'instanceId',
          'source',
        ])
          k: r[k],
        'nodes': ['A', 'B', 'C'],
        'hops': 2,
      },
    },
    'market': {
      'catalog': [
        {
          'productId': marketProduct,
          'providerId': 'demo-maps',
          'serviceId': 'synthetic.route.v1',
          'serviceVersion': 1,
          'mode': 'synthetic-only',
          'network': false,
          'paid': false,
        },
      ],
      'subscriptions': [],
      'receipts': [],
    },
  };
}

void main() {
  testWidgets('replayed receipt explicitly says no new service invocation', (
    t,
  ) async {
    final s = state();
    s['route']['replayed'] = true;
    await t.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: SyntheticRouteCard(
            route: trustedRoute(s)!,
            onVisibility: (_) {},
          ),
        ),
      ),
    );
    expect(find.text('历史回执重放，未再次调用服务'), findsOneWidget);
    s['route'].remove('replayed');
    expect(trustedRoute(s), isNull);
    s['route']['replayed'] = 'true';
    expect(trustedRoute(s), isNull);
  });
  for (final outcome in ['failed', 'pending', 'cancelled', 'cancel-error']) {
    testWidgets(
      'unknown route recovery $outcome is explicit and never redispatches',
      (t) async {
        final s = state();
        s['route'] = null;
        s['market']['subscriptions'] = [
          {
            'productId': marketProduct,
            'instanceId': 'maps-one',
            'status': 'active',
            'routeGranted': true,
            'revision': 2,
            'generation': 0,
          },
        ];
        String? requestId;
        var attempts = 0, cancels = 0;
        final client = MockClient((req) async {
          final action = req.url.path.split('/').last;
          if (action == 'form-route') {
            requestId = jsonDecode(req.body)['requestId'];
            attempts++;
            throw Exception('response lost');
          }
          if (action == 'market-cancel') {
            cancels++;
            expect(jsonDecode(req.body)['requestId'], requestId);
            if (outcome == 'cancel-error') {
              throw Exception('cancel response lost');
            }
            s['market']['requests'] = [
              {'requestId': requestId, 'status': 'cancelled'},
            ];
          }
          if (action == 'state' &&
              requestId != null &&
              ['failed', 'pending'].contains(outcome)) {
            s['market']['requests'] = [
              {'requestId': requestId, 'status': outcome},
            ];
          }
          attachChoiceFixtures(s);
          return http.Response(jsonEncode(s), 200);
        });
        await t.pumpWidget(
          MaterialApp(
            home: Scaffold(body: CreatureMarketSheet(client: client)),
          ),
        );
        await t.pumpAndSettle();
        Future<void> click(Finder f) async {
          await t.ensureVisible(f);
          await t.tap(f);
          await t.pumpAndSettle();
        }

        final route = find.byKey(const Key('market-route'));
        await click(route);
        expect(t.widget<FilledButton>(route).onPressed, isNull);
        if (['failed', 'pending'].contains(outcome)) {
          await click(find.text('刷新并核对回执'));
        } else {
          await click(find.byKey(const Key('market-cancel')));
          expect(cancels, 1);
        }
        final statusText = t
            .widget<Text>(find.byKey(const Key('market-request-status')))
            .data!;
        expect(
          statusText,
          contains(
            {
              'failed': '已失败',
              'pending': '服务器仍处理中',
              'cancelled': '已取消',
              'cancel-error': '结果未知',
            }[outcome]!,
          ),
        );
        expect(attempts, 1);
        expect(
          t.widget<FilledButton>(route).onPressed,
          ['failed', 'cancelled'].contains(outcome) ? isNotNull : isNull,
        );
        expect(find.byKey(const Key('synthetic-route-path')), findsNothing);
      },
    );
  }

  test('receipt render identity path and declaration must all match', () {
    expect(trustedRoute(state()), isNotNull);
    for (final mutate in <void Function(Map<String, dynamic>)>[
      (s) => s['route']['render']['receiptId'] = 'wrong',
      (s) => s['route']['render']['nodes'] = ['A', 'C'],
      (s) => s['route']['receipt']['result']['path'] = ['A', 'C'],
      (s) => s['activeCreatureId'] = 'companion',
      (s) => s['presentation']['surface'] = 'synthetic-account',
      (s) => s['route']['receipt']['providerId'] = 'foreign',
      (s) => s['creatures'][0]['kind'] = 'pet',
    ]) {
      final s = state();
      mutate(s);
      expect(trustedRoute(s), isNull);
    }
  });
  testWidgets(
    'subscribe then explicit grant then provider route; hide and restore preserves receipt',
    (t) async {
      final s = state();
      s['route'] = null;
      final calls = <String>[];
      final client = MockClient((req) async {
        final action = req.url.path.split('/').last;
        calls.add(action);
        final body = req.method == 'POST' ? jsonDecode(req.body) : null;
        if (req.method == 'POST') {
          expect(req.headers['X-Summon-Lab'], 'synthetic');
        }
        if (action == 'market-subscribe') {
          s['market']['subscriptions'] = [
            {
              'productId': marketProduct,
              'instanceId': 'maps-one',
              'status': 'active',
              'routeGranted': false,
              'revision': 1,
              'generation': 0,
            },
          ];
        }
        if (action == 'market-grant') {
          expect(body['expectedRevision'], 1);
          s['market']['subscriptions'][0]['routeGranted'] = true;
          s['market']['subscriptions'][0]['revision'] = 2;
        }
        if (action == 'form-route') {
          expect(body['binding']['instanceId'], 'maps-one');
          final route = state()['route'];
          route['receipt']['requestId'] = body['requestId'];
          s['route'] = route;
          s['market']['receipts'] = [route['receipt']];
          s['market']['requests'] = [
            {'requestId': body['requestId'], 'status': 'completed'},
          ];
        }
        if (action == 'route-visible') {
          expect(body['receiptId'], 'r1');
          s['route']['visible'] = body['visible'];
          s['presentation']['surface'] = body['visible']
              ? 'synthetic-route'
              : 'route-summary';
        }
        attachChoiceFixtures(s);
        return http.Response(jsonEncode(s), 200);
      });
      await t.pumpWidget(
        MaterialApp(
          home: Scaffold(body: CreatureMarketSheet(client: client)),
        ),
      );
      await t.pumpAndSettle();
      Future<void> click(String key) async {
        final f = find.byKey(Key(key));
        await t.ensureVisible(f);
        await t.tap(f);
        await t.pumpAndSettle();
      }

      await click('market-subscribe');
      expect(
        t.widget<FilledButton>(find.byKey(const Key('market-route'))).onPressed,
        isNull,
      );
      expect(calls.where((v) => v == 'form-route'), isEmpty);
      await click('market-grant');
      await click('market-route');
      expect(find.text('A → B → C'), findsOneWidget);
      expect(s['primaryCreatureId'], 'companion');
      await click('route-visibility');
      expect(find.text('A → B → C'), findsNothing);
      await click('route-visibility');
      expect(find.text('A → B → C'), findsOneWidget);
      expect(calls.where((v) => v == 'form-route').length, 1);
    },
  );
  testWidgets('network uncertainty never retries or invents a route', (
    t,
  ) async {
    final s = state();
    s['route'] = null;
    s['market']['subscriptions'] = [
      {
        'productId': marketProduct,
        'instanceId': 'maps-one',
        'status': 'active',
        'routeGranted': true,
        'revision': 2,
        'generation': 0,
      },
    ];
    var attempts = 0;
    final client = MockClient((req) async {
      if (req.url.path.endsWith('form-route')) {
        attempts++;
        throw Exception('offline');
      }
      attachChoiceFixtures(s);
      return http.Response(jsonEncode(s), 200);
    });
    await t.pumpWidget(
      MaterialApp(
        home: Scaffold(body: CreatureMarketSheet(client: client)),
      ),
    );
    await t.pumpAndSettle();
    final button = find.byKey(const Key('market-route'));
    await t.ensureVisible(button);
    await t.tap(button);
    await t.pumpAndSettle();
    expect(attempts, 1);
    expect(find.byKey(const Key('synthetic-route-path')), findsNothing);
    expect(t.widget<FilledButton>(button).onPressed, isNull);
    await t.ensureVisible(find.text('刷新并核对回执'));
    await t.tap(find.text('刷新并核对回执'));
    await t.pumpAndSettle();
    expect(attempts, 1);
  });
}
