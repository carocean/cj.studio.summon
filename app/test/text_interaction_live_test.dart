import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/services.dart';

import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/io_client.dart';
import 'package:material_ui/material_ui.dart';
import 'package:summon_app/preview_app.dart';
import 'package:summon_app/protected_preview_client.dart';
import 'package:summon_app/scene_experiment.dart';
import 'package:summon_app/temporary_interaction.dart';

import 'preview_session_live_test.dart' show SessionCookieClient;

const requestText = '我现在想那个你给我一个表单，让我做一下笔记';

class AuditedClient extends http.BaseClient {
  AuditedClient(this.inner, this.calls);
  final http.Client inner;
  final List<Map<String, dynamic>> calls;
  @override
  Future<http.StreamedResponse> send(http.BaseRequest r) {
    // No cookies or CSRF captured in evidence. Only scene request content.
    if (r.url.path.startsWith('/scene/')) {
      calls.add({
        'method': r.method,
        'path': r.url.path,
        if (r is http.Request && r.body.isNotEmpty) 'body': jsonDecode(r.body),
      });
    }
    return inner.send(r);
  }

  @override
  void close() => inner.close();
}

void main() {
  final real = Platform.environment['SUMMON_REAL_TEXTGEN'] == '1';
  final keepEvidence =
      real || Platform.environment['SUMMON_TEXTGEN_KEEP_FIXTURE'] == '1';
  testWidgets(
    'explicit text → actual TLS → host planner → validated active renderer (no edit/save)',
    (t) async {
      final previous = HttpOverrides.current,
          boundary = GlobalKey(),
          calls = <Map<String, dynamic>>[];
      Directory? dir;
      Process? node;
      StreamIterator<String>? lines;
      PreviewSessionClient? session;
      try {
        await t.runAsync(() async {
          HttpOverrides.global = null;
          // Optional local test font, never downloaded and never sent to the host.
          // This changes screenshot glyph rendering only, not the model artifact.
          final fontPath = Platform.environment['SUMMON_SCREENSHOT_CJK_FONT'];
          if (fontPath != null) {
            final bytes = await File(fontPath).readAsBytes();
            for (final family in ['Roboto', 'Ahem']) {
              final loader = FontLoader(family)
                ..addFont(Future.value(ByteData.sublistView(bytes)));
              await loader.load();
            }
          }

          final iconPath = Platform.environment['SUMMON_SCREENSHOT_ICON_FONT'];
          if (iconPath != null) {
            final bytes = await File(iconPath).readAsBytes();
            final loader = FontLoader('MaterialIcons')
              ..addFont(Future.value(ByteData.sublistView(bytes)));
            await loader.load();
          }
          dir = await Directory.systemTemp.createTemp(
            real ? 'summon-real-textgen-' : 'summon-fake-textgen-',
          );
          final cert = await Process.run('openssl', [
            'req',
            '-x509',
            '-newkey',
            'rsa:2048',
            '-nodes',
            '-days',
            '1',
            '-keyout',
            '${dir!.path}/key.pem',
            '-out',
            '${dir!.path}/cert.pem',
            '-subj',
            '/CN=127.0.0.1',
            '-addext',
            'subjectAltName=IP:127.0.0.1',
          ]);
          expect(cert.exitCode, 0);
          node = await Process.start('node', [
            'test/fixtures/textgen-preview-http.mjs',
            dir!.path,
          ]);
          unawaited(
            node!.stderr
                .transform(utf8.decoder)
                .join()
                .then(
                  (s) => File('${dir!.path}/host-stderr.txt').writeAsString(s),
                ),
          );
          lines = StreamIterator(
            node!.stdout
                .transform(utf8.decoder)
                .transform(const LineSplitter()),
          );
          expect(
            await lines!.moveNext().timeout(const Duration(seconds: 10)),
            true,
          );
          final origin = jsonDecode(lines!.current)['origin'] as String;
          final trust = SecurityContext(withTrustedRoots: false)
            ..setTrustedCertificates('${dir!.path}/cert.pem');
          final jar = <String, String>{};
          http.Client factory() => AuditedClient(
            SessionCookieClient(
              IOClient(HttpClient(context: trust)),
              origin,
              jar,
            ),
            calls,
          );
          session = PreviewSessionClient.forTesting(
            origin: Uri.parse(origin),
            clientFactory: factory,
          );
          await session!.initialize();
          await session!.login('synthetic-test-invitation-aaaaaaaaaaaaaaaaaaa');
          expect(session!.access.value, true);
        });
        await t.pumpWidget(
          RepaintBoundary(
            key: boundary,
            child: PreviewApp(session: session),
          ),
        );
        Future<void> until(
          bool Function() condition, {
          int seconds = 12,
        }) async {
          final deadline = DateTime.now().add(Duration(seconds: seconds));
          while (!condition()) {
            if (DateTime.now().isAfter(deadline)) {
              throw StateError(
                'UI deadline: ${t.widgetList<Text>(find.byType(Text)).map((w) => w.data).toList()} calls=$calls',
              );
            }
            await t.runAsync(
              () => Future<void>.delayed(const Duration(milliseconds: 25)),
            );
            await t.pump(const Duration(milliseconds: 40));
          }
        }

        Future<void> tap(String key) async {
          final f = find.byKey(Key(key));
          await t.ensureVisible(f);
          await t.tap(f);
          await t.pump(const Duration(milliseconds: 100));
        }

        await until(
          () => find.byKey(const Key('preview-options')).evaluate().isNotEmpty,
        );
        expect(find.byKey(const Key('textgen-input')), findsNothing);
        await tap('preview-options');
        await tap('preview-text-demand');
        await until(
          () => find.byKey(const Key('textgen-input')).evaluate().isNotEmpty,
        );
        await until(
          () => !t
              .widget<TextField>(find.byKey(const Key('textgen-input')))
              .readOnly,
        );
        await t.enterText(find.byKey(const Key('textgen-input')), requestText);
        await t.pump();
        await until(
          () =>
              t
                  .widget<FilledButton>(find.byKey(const Key('textgen-submit')))
                  .onPressed !=
              null,
        );
        await tap('textgen-submit');
        await until(
          () => find.byKey(const Key('textgen-open')).evaluate().isNotEmpty,
          seconds: 65,
        );
        expect(find.byType(TemporaryInteractionSheet), findsNothing);
        await tap('textgen-open');
        await until(
          () => find.byType(TemporaryInteractionSheet).evaluate().isNotEmpty,
        );
        final sheet = t.widget<TemporaryInteractionSheet>(
          find.byType(TemporaryInteractionSheet),
        );
        await until(() => !sheet.recovery.stale);
        final raw = await t.runAsync(
          () =>
              SceneExperimentApi(session!)
                  .request('interaction-read', {'sessionId': sheet.sessionId}),
        );
        expect(raw!['status'], 'open');
        expect(
          raw['expiresAt'],
          greaterThan(DateTime.now().millisecondsSinceEpoch),
        );
        final fields = raw['program']['declaration']['fields'] as List;
        await until(
          () => fields
              .where((f) => f['type'] != 'choice')
              .every(
                (f) => !t
                    .widget<TextField>(
                      find.byKey(ValueKey('interaction-${f['id']}')),
                    )
                    .readOnly,
              ),
        );
        for (final f in fields) {
          expect(find.text(f['label']), findsWidgets);
          if (f['type'] != 'choice') {
            final w = t.widget<TextField>(
              find.byKey(ValueKey('interaction-${f['id']}')),
            );
            expect(w.readOnly, false);
            expect(w.controller!.text, isEmpty);
          }
        }
        expect(
          (raw['draft']['values'] as Map).values.every((v) => v == null),
          true,
        );
        expect(
          calls.where((c) => c['path'] == '/scene/textgen-generate').length,
          1,
        );
        expect(
          calls.where(
            (c) => [
              '/scene/interaction-edit',
              '/scene/interaction-save',
            ].contains(c['path']),
          ),
          isEmpty,
        );
        await until(
          () => find.byType(LinearProgressIndicator).evaluate().isEmpty,
        );
        await t.pumpAndSettle();
        await t.runAsync(() async {
          final rendered =
              await (boundary.currentContext!.findRenderObject()!
                      as RenderRepaintBoundary)
                  .toImage(pixelRatio: 1.5);
          final png = await rendered.toByteData(format: ui.ImageByteFormat.png);
          rendered.dispose();
          await File('${dir!.path}/active-form.png')
              .writeAsBytes(png!.buffer.asUint8List());
          await File('${dir!.path}/report.json').writeAsString(
            jsonEncode({
              'mode': real ? 'real-local-adapter' : 'deterministic-fixture',
              'request': requestText,
              'calls': calls,
              'session': raw,
              'screenshot': 'active-form.png',
              'noEditSave': true,
            }),
          );
        });
        if (keepEvidence) debugPrint('TEXTGEN_EVIDENCE=${dir!.path}');
      } finally {
        if (keepEvidence && dir != null) {
          await t.runAsync(
            () => File('${dir!.path}/request-evidence.json').writeAsString(
              jsonEncode({'request': requestText, 'calls': calls}),
            ),
          );
          debugPrint('TEXTGEN_EVIDENCE=${dir!.path}');
        }
        await t.pumpWidget(const SizedBox());
        await t.runAsync(() async {
          session?.close();
          node?.kill(ProcessSignal.sigterm);
          if (node != null) {
            await node!.exitCode.timeout(const Duration(seconds: 10));
          }
          await lines?.cancel();
          if (dir != null) {
            if (!keepEvidence) {
              await dir!.delete(recursive: true);
            } else {
              await File('${dir!.path}/key.pem').delete();
            }
          }
        });
        HttpOverrides.global = previous;
      }
    },
    timeout: const Timeout(Duration(seconds: 150)),
  );
}
