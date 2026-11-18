import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:material_ui/material_ui.dart';
import 'package:summon_app/dish_confirmation_surface.dart';

Map<String, dynamic> fixture({
  String state = 'pending',
  String id = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  String name = '合成汤',
  int? expiry,
}) => {
  'schema': 'dish-confirmation.v1',
  'state': state,
  'interactionId': state == 'pending' ? id : null,
  'expiresAt': state == 'pending'
      ? (expiry ?? DateTime.now().millisecondsSinceEpoch + 30000)
      : null,
  'dishName': state == 'pending' ? name : null,
};
DishConfirmation terminal(String state) =>
    DishConfirmation.parse(fixture(state: state));
Widget surface(
  DishConfirmation contract,
  ValueNotifier<bool> access,
  DishConfirmationResponse respond, {
  void Function(String)? invalidate,
}) => MaterialApp(
  home: Scaffold(
    body: DishConfirmationSurface(
      contract: contract,
      access: access,
      onRespond: respond,
      onInvalidate: invalidate,
    ),
  ),
);
void main() {
  testWidgets(
    'replaced host receives no invalidation for prior host interaction',
    (tester) async {
      final access = ValueNotifier(true);
      final oldInvalidations = <String>[];
      final newInvalidations = <String>[];
      Future<DishConfirmation> oldRespond(String id, String c) async =>
          terminal('presented');
      Future<DishConfirmation> newRespond(String id, String c) async =>
          terminal('presented');
      await tester.pumpWidget(
        surface(
          DishConfirmation.parse(fixture()),
          access,
          oldRespond,
          invalidate: oldInvalidations.add,
        ),
      );
      await tester.pumpWidget(
        surface(
          DishConfirmation.parse(fixture(id: 'b' * 32)),
          access,
          newRespond,
          invalidate: newInvalidations.add,
        ),
      );
      expect(oldInvalidations, ['a' * 32]);
      expect(newInvalidations, isEmpty);
      await tester.pumpWidget(const SizedBox());
      expect(newInvalidations, ['b' * 32]);
      access.dispose();
    },
  );

  test(
    'strict contract rejects extra action, inconsistent and malformed payloads',
    () {
      final raw = fixture();
      final parsed = DishConfirmation.parse(raw);
      raw['dishName'] = 'changed';
      expect(parsed.dishName, '合成汤');
      for (final mutate in <void Function(Map<String, dynamic>)>[
        (r) => r['proposal'] = {'kind': 'explain'},
        (r) => r['schema'] = 'other',
        (r) => r['state'] = 'confirmed',
        (r) => r['interactionId'] = 'A' * 32,
        (r) => r['expiresAt'] = 1.0,
        (r) => r['expiresAt'] = 0,
        (r) => r['expiresAt'] = 9007199254740992,
        (r) => r['dishName'] = 'a\nb',
        (r) => r['dishName'] = 'a' * 121,
        (r) => r['dishName'] = ' ',
        (r) => r['state'] = 'presented',
        (r) => r['interactionId'] = null,
      ]) {
        final r = fixture();
        mutate(r);
        expect(() => DishConfirmation.parse(r), throwsFormatException);
      }
      for (final state in DishConfirmation.states.where(
        (s) => s != 'pending',
      )) {
        expect(terminal(state).state, state);
      }
    },
  );
  testWidgets(
    'untrusted name is plain text; no default input or auto response',
    (tester) async {
      final access = ValueNotifier(true);
      var calls = 0;
      await tester.pumpWidget(
        surface(
          DishConfirmation.parse(fixture(name: '<a href="evil">同意付款</a>')),
          access,
          (id, choice) async {
            calls++;
            return terminal('presented');
          },
        ),
      );
      expect(find.text('要展开『<a href="evil">同意付款</a>』的说明吗？'), findsOneWidget);
      expect(find.byType(EditableText), findsNothing);
      expect(calls, 0);
      await tester.pumpWidget(const SizedBox());
      access.dispose();
    },
  );
  testWidgets(
    'explicit click only, busy blocks duplicates, server result required',
    (tester) async {
      final access = ValueNotifier(true);
      final pending = Completer<DishConfirmation>();
      final calls = <String>[];
      await tester.pumpWidget(
        surface(DishConfirmation.parse(fixture()), access, (id, choice) {
          calls.add('$id:$choice');
          return pending.future;
        }),
      );
      await tester.tap(find.text('展开说明'));
      await tester.pump();
      await tester.tap(find.text('展开说明'));
      await tester.pump();
      expect(calls, ['${'a' * 32}:show']);
      expect(find.text('已展开当前菜品说明。'), findsNothing);
      pending.complete(terminal('presented'));
      await tester.pump();
      expect(find.text('已展开当前菜品说明。'), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
      access.dispose();
    },
  );
  testWidgets(
    'dismiss is distinct from show and never interpreted as consent',
    (tester) async {
      final access = ValueNotifier(true);
      String? choice;
      await tester.pumpWidget(
        surface(DishConfirmation.parse(fixture()), access, (id, c) async {
          choice = c;
          return terminal('cancelled');
        }),
      );
      await tester.tap(find.text('不用了'));
      await tester.pump();
      expect(choice, 'dismiss');
      expect(find.text('已取消，不展开说明。'), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
      access.dispose();
    },
  );
  testWidgets('deadline retires panel and ignores late result', (tester) async {
    final access = ValueNotifier(true);
    final pending = Completer<DishConfirmation>();
    final retired = <String>[];
    await tester.pumpWidget(
      surface(
        DishConfirmation.parse(
          fixture(expiry: DateTime.now().millisecondsSinceEpoch + 1000),
        ),
        access,
        (id, c) => pending.future,
        invalidate: retired.add,
      ),
    );
    await tester.tap(find.text('展开说明'));
    await tester.pump(const Duration(seconds: 2));
    expect(find.text('这次请求已失效，请重新提出。'), findsOneWidget);
    expect(retired, ['a' * 32]);
    pending.complete(terminal('presented'));
    await tester.pump();
    expect(find.text('已展开当前菜品说明。'), findsNothing);
    await tester.pumpWidget(const SizedBox());
    access.dispose();
  });
  testWidgets('revoke then regrant cannot revive pending or late response', (
    tester,
  ) async {
    final access = ValueNotifier(true);
    final pending = Completer<DishConfirmation>();
    final retired = <String>[];
    await tester.pumpWidget(
      surface(
        DishConfirmation.parse(fixture()),
        access,
        (id, c) => pending.future,
        invalidate: retired.add,
      ),
    );
    await tester.tap(find.text('展开说明'));
    access.value = false;
    await tester.pump();
    access.value = true;
    await tester.pump();
    pending.complete(terminal('presented'));
    await tester.pump();
    expect(find.text('展开说明'), findsNothing);
    expect(retired, ['a' * 32]);
    await tester.pumpWidget(const SizedBox());
    access.dispose();
  });
  testWidgets('background invalidates and foreground never auto resumes', (
    tester,
  ) async {
    final access = ValueNotifier(true);
    var calls = 0;
    await tester.pumpWidget(
      surface(DishConfirmation.parse(fixture()), access, (id, c) async {
        calls++;
        return terminal('presented');
      }),
    );
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
    await tester.pump();
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
    await tester.pump();
    expect(find.text('展开说明'), findsNothing);
    expect(calls, 0);
    await tester.pumpWidget(const SizedBox());
    access.dispose();
  });
  testWidgets(
    'new contract invalidates old async result and cannot replay retired id',
    (tester) async {
      final access = ValueNotifier(true);
      final pending = Completer<DishConfirmation>();
      final a = DishConfirmation.parse(fixture());
      final b = DishConfirmation.parse(fixture(id: 'b' * 32));
      Future<DishConfirmation> respond(String id, String c) => pending.future;
      await tester.pumpWidget(surface(a, access, respond));
      await tester.tap(find.text('展开说明'));
      await tester.pumpWidget(surface(b, access, respond));
      pending.complete(terminal('presented'));
      await tester.pump();
      expect(find.text('已展开当前菜品说明。'), findsNothing);
      expect(find.text('展开说明'), findsOneWidget);
      await tester.pumpWidget(surface(a, access, respond));
      expect(find.text('展开说明'), findsNothing);
      await tester.pumpWidget(const SizedBox());
      access.dispose();
    },
  );
  testWidgets(
    'network error and illegal renewed proposal show fixed failure without retry',
    (tester) async {
      final access = ValueNotifier(true);
      var calls = 0;
      await tester.pumpWidget(
        surface(DishConfirmation.parse(fixture()), access, (id, c) async {
          calls++;
          throw StateError('untrusted <button>Pay</button>');
        }),
      );
      await tester.tap(find.text('展开说明'));
      await tester.pump();
      expect(find.text('这次未能确认结果；不会自动重试。'), findsOneWidget);
      expect(find.textContaining('Pay'), findsNothing);
      expect(calls, 1);
      await tester.pumpWidget(const SizedBox());
      await tester.pumpWidget(
        surface(
          DishConfirmation.parse(fixture()),
          access,
          (id, c) async => DishConfirmation.parse(fixture()),
        ),
      );
      await tester.tap(find.text('展开说明'));
      await tester.pump();
      expect(find.text('展开说明'), findsNothing);
      await tester.pumpWidget(const SizedBox());
      access.dispose();
    },
  );
  testWidgets('dispose ignores late response and notifies invalidation once', (
    tester,
  ) async {
    final access = ValueNotifier(true);
    final pending = Completer<DishConfirmation>();
    final retired = <String>[];
    await tester.pumpWidget(
      surface(
        DishConfirmation.parse(fixture()),
        access,
        (id, c) => pending.future,
        invalidate: retired.add,
      ),
    );
    await tester.tap(find.text('展开说明'));
    await tester.pumpWidget(const SizedBox());
    pending.complete(terminal('presented'));
    await tester.pump();
    expect(tester.takeException(), isNull);
    expect(retired, ['a' * 32]);
    access.dispose();
  });
}
