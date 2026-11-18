import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:material_ui/material_ui.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:summon_app/creature_home.dart';
import 'package:summon_app/dish_confirmation_remote_surface.dart';
import 'package:summon_app/protected_preview_client.dart';
import 'package:summon_app/standin_avatar.dart';

import 'creature_home_minimal_test.dart' show state, response, idle;
import 'dish_confirmation_test.dart' show fixture;
import 'dish_confirmation_remote_test.dart' show dish;

const enabled =
    bool.fromEnvironment('SUMMON_RESTAURANT_DEV') &&
    bool.fromEnvironment('SUMMON_PROTECTED_PREVIEW');
const target = RestaurantDevTarget(
  sessionId: 'meal',
  creatureId: 'companion',
  sceneRevision: 1,
);
Map<String, dynamic> emptyUsage() => {
  'schema': 'real-usage-history.v1',
  'items': [],
  'learningSaturated': false,
  'minUses': 2,
  'sourceTrust': 'host-actions-and-client-presentation-reports',
};
Map<String, dynamic> rejected() => {
  'schema': 'dish-confirmation.v1',
  'state': 'unrecognized',
  'interactionId': null,
  'expiresAt': null,
  'dishName': null,
};
ProtectedPreviewClient protected(http.Client inner) =>
    ProtectedPreviewClient.forTesting(
      origin: Uri.parse('https://preview.example'),
      csrf: 'a' * 43,
      client: inner,
    );
Widget home(
  http.Client client,
  ValueNotifier<bool> access,
  CreatureHomeController controller, {
  RestaurantDevTarget value = target,
}) => MaterialApp(
  home: CreatureHome(
    client: client,
    interactionAccess: access,
    controller: controller,
    restaurantDevTarget: value,
  ),
);
void main() {
  testWidgets(
    'replacing access object retires an already-open confirmation and its old callback',
    (t) async {
      final oldAccess = ValueNotifier(true),
          nextAccess = ValueNotifier(false),
          controller = CreatureHomeController();
      var responds = 0, invalidations = 0;
      final client = protected(
        MockClient((r) async {
          if (r.url.path.endsWith('/usage')) return response(emptyUsage());
          if (r.url.path.endsWith('/state')) return response(state());
          if (r.url.path.endsWith('/dish-read')) return response(dish());
          if (r.url.path.endsWith('/dish-confirmation-read')) {
            return response(fixture());
          }
          if (r.url.path.endsWith('/dish-confirmation-respond')) {
            responds++;
            return response(fixture(state: 'presented'));
          }
          if (r.url.path.endsWith('/dish-confirmation-invalidate')) {
            invalidations++;
          }
          return response(fixture(state: 'expired'));
        }),
      );
      await t.pumpWidget(home(client, oldAccess, controller));
      await idle(t);
      final operation = controller.presentRestaurantConfirmation();
      await idle(t);
      expect(await operation, CreaturePresentationResult.shown);
      expect(find.text('展开说明'), findsOneWidget);
      final staleClick = t
          .widget<TextButton>(find.byKey(const Key('dish-confirmation-show')))
          .onPressed!;
      final capturedAccess = t
          .widget<DishConfirmationRemoteSurface>(
            find.byType(DishConfirmationRemoteSurface),
          )
          .access;
      // Runs before the route-removal callback registered during didUpdateWidget.
      // Old button is still mounted here, but its capability must already be false.
      var checkedBeforeRemoval = false;
      WidgetsBinding.instance.addPostFrameCallback((_) {
        checkedBeforeRemoval = true;
        expect(capturedAccess.value, false);
        staleClick();
      });
      await t.pumpWidget(home(client, nextAccess, controller));
      await idle(t);
      expect(checkedBeforeRemoval, true);
      expect(t.takeException(), isNull);
      expect(oldAccess.value, true);
      expect(find.byType(DishConfirmationRemoteSurface), findsNothing);
      staleClick();
      await idle(t);
      expect(responds, 0);
      expect(invalidations, greaterThanOrEqualTo(1));
      expect(
        await controller.presentRestaurantConfirmation(),
        CreaturePresentationResult.blocked,
      );
      await t.pumpWidget(const SizedBox());
      client.close();
      oldAccess.dispose();
      nextAccess.dispose();
    },
    skip: !enabled,
  );

  testWidgets('failed scene lookup shows only fixed temporary feedback', (
    t,
  ) async {
    final access = ValueNotifier(true), controller = CreatureHomeController();
    final client = protected(
      MockClient(
        (r) async => r.url.path.endsWith('/usage')
            ? response(emptyUsage())
            : http.Response('{"error":"private secret details"}', 503),
      ),
    );
    await t.pumpWidget(home(client, access, controller));
    await idle(t);
    await t.longPress(find.byKey(const Key('restaurant-dev-avatar')));
    await idle(t);
    await t.tap(find.byKey(const Key('restaurant-dev-open')));
    await idle(t);
    expect(find.text('餐厅请求不可用或场景已变化，请重新准备。'), findsOneWidget);
    expect(find.textContaining('private secret'), findsNothing);
    expect(find.byType(DishConfirmationRemoteSurface), findsNothing);
    await t.pumpWidget(const SizedBox());
    client.close();
    access.dispose();
  }, skip: !enabled);

  testWidgets(
    'default compile flags preserve noninteractive avatar and no restaurant endpoint',
    (t) async {
      final access = ValueNotifier(true), controller = CreatureHomeController();
      var calls = 0;
      final client = protected(
        MockClient((r) async {
          calls++;
          expect(r.url.path, '/scene/usage');
          return response(emptyUsage());
        }),
      );
      await t.pumpWidget(home(client, access, controller));
      await idle(t);
      expect(find.byType(StandInAvatar), findsOneWidget);
      expect(find.byKey(const Key('restaurant-dev-avatar')), findsNothing);
      expect(find.byType(GestureDetector), findsNothing);
      expect(find.byType(TextField), findsNothing);
      expect(
        await controller.presentRestaurantConfirmation(),
        CreaturePresentationResult.blocked,
      );
      expect(calls, 1);
      await t.pumpWidget(const SizedBox());
      client.close();
      access.dispose();
    },
    skip: enabled,
  );
  testWidgets('even enabled build rejects unprotected client', (t) async {
    final access = ValueNotifier(true), controller = CreatureHomeController();
    final client = MockClient((r) async => response(emptyUsage()));
    await t.pumpWidget(home(client, access, controller));
    await idle(t);
    expect(find.byKey(const Key('restaurant-dev-avatar')), findsNothing);
    expect(
      await controller.presentRestaurantConfirmation(),
      CreaturePresentationResult.blocked,
    );
    await t.pumpWidget(const SizedBox());
    client.close();
    access.dispose();
  });
  testWidgets(
    'longpress reveals only temporary read option and mounts confirmation not generic command',
    (t) async {
      final access = ValueNotifier(true),
          controller = CreatureHomeController(),
          paths = <String>[];
      final client = protected(
        MockClient((r) async {
          paths.add(r.url.path);
          if (r.url.path.endsWith('/usage')) return response(emptyUsage());
          if (r.url.path.endsWith('/state')) return response(state());
          if (r.url.path.endsWith('/dish-confirmation-invalidate')) {
            return response({...rejected(), 'state': 'expired'});
          }
          return response(rejected());
        }),
      );
      await t.pumpWidget(home(client, access, controller));
      await idle(t);
      expect(find.text('查看宿主已准备的餐厅请求（开发）'), findsNothing);
      await t.longPress(find.byKey(const Key('restaurant-dev-avatar')));
      await idle(t);
      expect(find.text('查看宿主已准备的餐厅请求（开发）'), findsOneWidget);
      expect(paths.where((p) => p != '/scene/usage'), isEmpty);
      await t.tap(find.byKey(const Key('restaurant-dev-open')));
      await idle(t);
      expect(find.byType(DishConfirmationRemoteSurface), findsOneWidget);
      expect(find.text('开发验证 · 合成输入 / 受控播放器 · 不会录音'), findsOneWidget);
      expect(find.byType(TextField), findsNothing);
      expect(
        paths.where(
          (p) =>
              p == '/scene/dish-command' ||
              p == '/scene/sense' ||
              p == '/scene/speak',
        ),
        isEmpty,
      );
      expect(
        await controller.presentRestaurantConfirmation(),
        CreaturePresentationResult.blocked,
      );
      await t.tap(find.text('切换需求 / 收起'));
      await idle(t);
      expect(find.byType(DishConfirmationRemoteSurface), findsNothing);
      expect(find.byType(StandInAvatar), findsOneWidget);
      await t.pumpWidget(const SizedBox());
      client.close();
      access.dispose();
    },
    skip: !enabled,
  );
  for (final change in [
    'revoke',
    'background',
    'dismiss',
    'target',
    'client',
  ]) {
    testWidgets(
      'late restaurant scene after $change is rejected with no confirmation read',
      (t) async {
        final access = ValueNotifier(true),
            controller = CreatureHomeController(),
            pending = Completer<http.Response>();
        var reads = 0;
        final client = protected(
          MockClient((r) async {
            if (r.url.path.endsWith('/usage')) return response(emptyUsage());
            if (r.url.path.endsWith('/state')) return pending.future;
            reads++;
            return response(rejected());
          }),
        );
        await t.pumpWidget(home(client, access, controller));
        await idle(t);
        final operation = controller.presentRestaurantConfirmation();
        await t.pump();
        expect(
          await controller.presentRestaurantConfirmation(),
          CreaturePresentationResult.blocked,
        );
        http.Client? replacement;
        switch (change) {
          case 'revoke':
            access.value = false;
            access.value = true;
            break;
          case 'background':
            t.binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
            t.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
            break;
          case 'dismiss':
            controller.dismiss();
            break;
          case 'target':
            await t.pumpWidget(
              home(
                client,
                access,
                controller,
                value: const RestaurantDevTarget(
                  sessionId: 'other',
                  creatureId: 'companion',
                  sceneRevision: 1,
                ),
              ),
            );
            break;
          case 'client':
            replacement = protected(
              MockClient((r) async => response(emptyUsage())),
            );
            await t.pumpWidget(home(replacement, access, controller));
            break;
        }
        pending.complete(response(state()));
        await idle(t);
        expect(await operation, CreaturePresentationResult.stale);
        expect(reads, 0);
        expect(find.byType(DishConfirmationRemoteSurface), findsNothing);
        await t.pumpWidget(const SizedBox());
        replacement?.close();
        client.close();
        access.dispose();
      },
      skip: !enabled,
    );
  }
  for (final bad in ['unauthenticated', 'scene', 'session']) {
    testWidgets('reject $bad before mounting restaurant', (t) async {
      final access = ValueNotifier(bad != 'unauthenticated'),
          controller = CreatureHomeController();
      var reads = 0;
      final client = protected(
        MockClient((r) async {
          if (r.url.path.endsWith('/usage')) return response(emptyUsage());
          if (r.url.path.endsWith('/state')) {
            return response({
              ...state(),
              'context': {'creatureId': 'companion', 'sceneRevision': 2},
            });
          }
          reads++;
          return response(rejected());
        }),
      );
      await t.pumpWidget(
        home(
          client,
          access,
          controller,
          value: bad == 'session'
              ? const RestaurantDevTarget(
                  sessionId: 'https://evil',
                  creatureId: 'companion',
                  sceneRevision: 1,
                )
              : target,
        ),
      );
      await idle(t);
      final future = controller.presentRestaurantConfirmation();
      await idle(t);
      expect(
        await future,
        bad == 'scene'
            ? CreaturePresentationResult.stale
            : CreaturePresentationResult.blocked,
      );
      expect(reads, 0);
      expect(find.byType(DishConfirmationRemoteSurface), findsNothing);
      await t.pumpWidget(const SizedBox());
      client.close();
      access.dispose();
    }, skip: !enabled);
  }
  testWidgets('background or revoked auth closes temporary menu', (t) async {
    final access = ValueNotifier(true), controller = CreatureHomeController();
    final client = protected(MockClient((r) async => response(emptyUsage())));
    await t.pumpWidget(home(client, access, controller));
    await idle(t);
    await t.longPress(find.byKey(const Key('restaurant-dev-avatar')));
    await idle(t);
    access.value = false;
    await idle(t);
    expect(find.text('查看宿主已准备的餐厅请求（开发）'), findsNothing);
    access.value = true;
    await t.longPress(find.byKey(const Key('restaurant-dev-avatar')));
    await idle(t);
    t.binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
    await idle(t);
    expect(find.text('查看宿主已准备的餐厅请求（开发）'), findsNothing);
    t.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
    await t.pumpWidget(const SizedBox());
    client.close();
    access.dispose();
  }, skip: !enabled);
}
