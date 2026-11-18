import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:material_ui/material_ui.dart';
import 'package:summon_app/creature_home.dart';
import 'package:summon_app/scene_experiment.dart';
import 'package:summon_app/temporary_interaction.dart';

import 'cross_draft_live_test.dart' show DualClient;
import 'perception_test.dart' show FakeCapture;

void main() {
  testWidgets(
    'real HTTP explicit return reports twice; reads alone never seed frequent row',
    (t) async {
      final previous = HttpOverrides.current,
          controller = CreatureHomeController();
      Process? process;
      Directory? dir;
      DualClient? client;
      StreamIterator<String>? lines;
      try {
        await t.runAsync(() async {
          HttpOverrides.global = null;
          dir = await Directory.systemTemp.createTemp('summon-usage-dart-');
          process = await Process.start('node', [
            'test/fixtures/interaction-two-http.mjs',
            dir!.path,
          ]);
          unawaited(process!.stderr.drain<void>());
          lines = StreamIterator(
            process!.stdout
                .transform(utf8.decoder)
                .transform(const LineSplitter()),
          );
          expect(await lines!.moveNext(), true);
          client = DualClient(jsonDecode(lines!.current)['port']);
        });
        await t.pumpWidget(
          MaterialApp(
            home: CreatureHome(
              controller: controller,
              client: client,
              senseCaptureFactory: () => FakeCapture(),
            ),
          ),
        );
        Future<void> until(bool Function() done) async {
          final end = DateTime.now().add(const Duration(seconds: 10));
          while (!done()) {
            if (DateTime.now().isAfter(end)) throw StateError('timed out');
            await t.runAsync(
              () => Future<void>.delayed(const Duration(milliseconds: 20)),
            );
            await t.pump(const Duration(milliseconds: 40));
          }
        }

        Future<void> waitEditable() => until(
          () =>
              find.byType(TextField).evaluate().isNotEmpty &&
              !t.widget<TextField>(find.byType(TextField)).readOnly,
        );
        final api = SceneExperimentApi(client!);
        await t.runAsync(() async {
          expect((await api.request('usage'))['items'], isEmpty);
          expect(
            await controller.presentInteraction('first-draft'),
            CreaturePresentationResult.shown,
          );
        });
        await waitEditable();
        await t.runAsync(() async {
          expect((await api.request('usage'))['items'], isEmpty);
        });
        for (var round = 1; round <= 2; round++) {
          await t.runAsync(() async {
            expect(
              await controller.pauseInteractionForHearing('first-draft'),
              CreaturePresentationResult.shown,
            );
          });
          await until(
            () => find
                .byKey(const Key('hearing-return-draft'))
                .evaluate()
                .isNotEmpty,
          );
          final back = find.byKey(const Key('hearing-return-draft'));
          await t.ensureVisible(back);
          await t.runAsync(() async {
            await t.tap(back);
            await Future<void>.delayed(const Duration(milliseconds: 20));
          });
          await waitEditable();
          await until(
            () =>
                client!.writes
                    .where((p) => p.endsWith('usage-presented'))
                    .length ==
                round,
          );
          await t.runAsync(
            () => Future<void>.delayed(const Duration(milliseconds: 100)),
          );
          await t.pump(const Duration(milliseconds: 40));
        }
        expect(find.byType(TemporaryInteractionSheet), findsOneWidget);
        final history = await t.runAsync(() => api.request('usage'));
        expect(history!['items'].length, 1);
        expect(history['items'][0]['useCount'], 2);
        expect(history['items'][0]['targetId'], 'first-draft');
        controller.dismiss();
        await t.pump(const Duration(milliseconds: 100));
        await t.runAsync(controller.refreshUsage);
        await t.pump(const Duration(milliseconds: 100));
        expect(
          find.byKey(
            const ValueKey('frequent-interaction-session-first-draft'),
          ),
          findsOneWidget,
        );
        expect(
          client!.writes.where(
            (p) =>
                p.endsWith('interaction-save') ||
                p.endsWith('interaction-edit'),
          ),
          isEmpty,
        );
      } finally {
        await t.pumpWidget(const SizedBox());
        await t.runAsync(() async {
          client?.close();
          process?.kill(ProcessSignal.sigterm);
          if (process != null) {
            await process!.exitCode.timeout(const Duration(seconds: 10));
          }
          await lines?.cancel();
          await dir?.delete(recursive: true);
        });
        HttpOverrides.global = previous;
      }
    },
  );
}
