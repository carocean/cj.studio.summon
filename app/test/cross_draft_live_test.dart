import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:material_ui/material_ui.dart';
import 'package:summon_app/creature_home.dart';
import 'package:summon_app/scene_experiment.dart';

class DualClient extends http.BaseClient {
  final int port;
  final inner = http.Client();
  final writes = <String>[];
  DualClient(this.port);
  @override
  Future<http.StreamedResponse> send(http.BaseRequest r) {
    final next = http.Request(r.method, r.url.replace(port: port))
      ..headers.addAll(r.headers)
      ..followRedirects = false;
    if (r is http.Request) next.bodyBytes = r.bodyBytes;
    if (r.method == 'POST' && !r.url.path.endsWith('interaction-read')) {
      writes.add(r.url.path);
    }
    return inner.send(next);
  }

  @override
  void close() => inner.close();
}

void main() {
  testWidgets(
    'real Node latest pointer changes while two local dirty drafts survive explicit resume',
    (t) async {
      final previous = HttpOverrides.current;
      Process? process;
      Directory? dir;
      DualClient? client;
      StreamIterator<String>? lines;
      final controller = CreatureHomeController();
      try {
        await t.runAsync(() async {
          HttpOverrides.global = null;
          dir = await Directory.systemTemp.createTemp('summon-dual-dart-');
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
          expect(
            await lines!.moveNext().timeout(const Duration(seconds: 10)),
            true,
          );
          client = DualClient(jsonDecode(lines!.current)['port']);
        });
        await t.pumpWidget(
          MaterialApp(
            home: CreatureHome(controller: controller, client: client),
          ),
        );
        Future<void> settleDraft() async {
          final end = DateTime.now().add(const Duration(seconds: 10));
          while (find.byType(TextField).evaluate().isEmpty ||
              t.widget<TextField>(find.byType(TextField)).readOnly) {
            if (DateTime.now().isAfter(end)) {
              throw StateError('draft not editable');
            }
            await t.runAsync(
              () => Future<void>.delayed(const Duration(milliseconds: 20)),
            );
            await t.pump(const Duration(milliseconds: 50));
          }
        }

        await t.runAsync(() async {
          expect(
            await controller.presentInteraction('first-draft'),
            CreaturePresentationResult.shown,
          );
        });
        await settleDraft();
        await t.enterText(find.byType(TextField), '第一份本机未提交');
        controller.dismiss();
        await t.pump(const Duration(milliseconds: 100));
        await t.runAsync(() async {
          process!.stdin.writeln('next');
          expect(await lines!.moveNext(), true);
          expect(lines!.current, 'second-created');
          expect(
            (await SceneExperimentApi(client!)
                .interactionCurrent())!['sessionId'],
            'second-draft',
          );
          expect(
            await controller.presentInteraction('second-draft'),
            CreaturePresentationResult.shown,
          );
        });
        await settleDraft();
        await t.enterText(find.byType(TextField), '第二份也未提交');
        controller.dismiss();
        await t.pump(const Duration(milliseconds: 100));
        await t.runAsync(() async {
          expect(
            await controller.resumeInteraction('first-draft'),
            CreaturePresentationResult.shown,
          );
        });
        await settleDraft();
        expect(
          t.widget<TextField>(find.byType(TextField)).controller!.text,
          '第一份本机未提交',
        );
        controller.dismiss();
        await t.pump(const Duration(milliseconds: 100));
        await t.runAsync(() async {
          expect(
            await controller.resumeInteraction('second-draft'),
            CreaturePresentationResult.shown,
          );
        });
        await settleDraft();
        expect(
          t.widget<TextField>(find.byType(TextField)).controller!.text,
          '第二份也未提交',
        );
        expect(client!.writes, isEmpty);
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
