import 'package:flutter_test/flutter_test.dart';
import 'package:material_ui/material_ui.dart';
import 'package:summon_app/creature_home.dart';
import 'package:summon_app/preview_app.dart';
import 'package:summon_app/scene_experiment.dart';
import 'package:summon_app/temporary_interaction.dart';

import 'preview_session_test.dart' show AuthHost, token;
import 'creature_home_minimal_test.dart' as home;
import 'temporary_interaction_test.dart' as temp;

void main() {
  for (final size in [
    const Size(320, 740),
    const Size(390, 740),
    const Size(320, 360),
  ]) {
    final short = size.height == 360;
    testWidgets(
      'reserved auth region preserves dirty route at size $size and keyboard',
      (t) async {
        t.view.devicePixelRatio = 1;
        t.view.physicalSize = size;
        addTearDown(t.view.resetDevicePixelRatio);
        addTearDown(t.view.resetPhysicalSize);
        addTearDown(t.view.resetViewInsets);
        if (short) t.platformDispatcher.textScaleFactorTestValue = 1.5;
        addTearDown(t.platformDispatcher.clearTextScaleFactorTestValue);
        final host = AuthHost(), controller = CreatureHomeController();
        // One real test host/client; no model or sensor transport.
        final client = host.client();
        await t.pumpWidget(PreviewApp(session: client, controller: controller));
        await home.idle(t);
        expect(find.byKey(const Key('preview-ready')), findsOneWidget);
        expect(find.byKey(const Key('textgen-input')), findsNothing);
        expect(
          Theme.of(t.element(find.byType(CreatureHome)))
              .textTheme
              .bodyMedium!
              .fontFamily,
          'SummonPreviewSC',
        );
        final owner = find
            .byType(CreatureHome, skipOffstage: false)
            .evaluate()
            .single;
        await controller.presentInteraction(host.view['sessionId']);
        await home.idle(t);
        final element = find
            .byType(TemporaryInteractionSheet)
            .evaluate()
            .single;
        final recovery = t
            .widget<TemporaryInteractionSheet>(
              find.byType(TemporaryInteractionSheet),
            )
            .recovery;
        void geometry() {
          expect(
            t.getRect(find.byKey(const Key('preview-auth-region'))).bottom,
            lessThanOrEqualTo(
              t.getRect(find.byType(TemporaryInteractionSheet)).top,
            ),
          );
          expect(
            t.getRect(find.text('临时交互')).top,
            greaterThanOrEqualTo(
              t.getRect(find.byKey(const Key('preview-auth-region'))).bottom,
            ),
          );
          expect(t.takeException(), isNull);
          expect(
            find.byType(CreatureHome, skipOffstage: false).evaluate().single,
            same(owner),
          );
          expect(
            find.byType(TemporaryInteractionSheet).evaluate().single,
            same(element),
          );
        }

        await t.enterText(find.byKey(const Key('interaction-subject')), '😀界');
        await home.idle(t);
        geometry();
        await temp.tap(t, 'preview-options');
        geometry();
        expect(find.byKey(const Key('preview-logout')), findsOneWidget);
        await temp.tap(t, 'preview-options');
        geometry();
        t.view.viewInsets = FakeViewPadding(bottom: short ? 200 : 320);
        await home.idle(t);
        geometry();
        host.authenticated = false;
        await expectLater(
          SceneExperimentApi(client).request('usage'),
          throwsA(anything),
        );
        await home.idle(t);
        geometry();
        expect(find.byKey(const Key('preview-status')), findsOneWidget);
        await temp.tap(t, 'preview-reauth');
        geometry();
        await t.enterText(find.byKey(const Key('preview-invitation')), token);
        await home.idle(t);
        await t.ensureVisible(find.byKey(const Key('preview-auth-cancel')));
        await home.idle(t);
        expect(
          find.byKey(const Key('preview-auth-cancel')).hitTestable(),
          findsOneWidget,
        );
        await temp.tap(t, 'preview-auth-cancel');
        geometry();
        expect(client.access.value, false);
        expect(recovery.values['subject'], '😀界');
        await temp.tap(t, 'preview-reauth');
        await t.enterText(find.byKey(const Key('preview-invitation')), token);
        await home.idle(t);
        final before = host.calls
            .where((r) => r.url.path.startsWith('/scene/'))
            .length;
        await temp.tap(t, 'preview-login-submit');
        geometry();
        expect(client.access.value, true);
        expect(recovery.values['subject'], '😀界');
        expect(
          host.calls.where((r) => r.url.path.startsWith('/scene/')).length,
          before,
        );
        expect(
          host.calls.where((r) => r.url.path.endsWith('interaction-save')),
          isEmpty,
        );
        t.view.viewInsets = const FakeViewPadding();
        await home.idle(t);
        expect(
          t
              .widget<TextField>(find.byKey(const Key('interaction-subject')))
              .readOnly,
          true,
        );
        t.view.viewInsets = const FakeViewPadding();
        await home.idle(t);
        geometry();
        await t.pumpWidget(const SizedBox());
      },
    );
  }
}
