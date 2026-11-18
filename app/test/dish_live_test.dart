import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/io_client.dart';
import 'package:material_ui/material_ui.dart';
import 'package:summon_app/dish_remote_surface.dart';
import 'package:summon_app/dish_surface.dart';
import 'package:summon_app/protected_preview_client.dart';
import 'package:summon_app/scene_experiment.dart';

import 'preview_session_live_test.dart' show SessionCookieClient;

class _DishAuditClient extends http.BaseClient {
  _DishAuditClient(this.inner, this.calls);
  final http.Client inner;
  final List<Map<String, dynamic>> calls;
  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) {
    // Only synthetic scene inputs; never record login, cookies or CSRF tokens.
    if (request.url.path.startsWith('/scene/dish-')) {
      calls.add({
        'path': request.url.path,
        if (request is http.Request) 'body': jsonDecode(request.body),
      });
    }
    return inner.send(request);
  }

  @override
  void close() => inner.close();
}

void main() {
  testWidgets(
    'synthetic dish: Flutter → temporary TLS → SceneLab SQLite → Flutter',
    (tester) async {
      final previousOverrides = HttpOverrides.current;
      final calls = <Map<String, dynamic>>[];
      Directory? directory;
      Process? node;
      StreamIterator<String>? lines;
      PreviewSessionClient? session;
      late Map<String, dynamic> ready;
      var hostErrors = '';
      try {
        await tester.runAsync(() async {
          HttpOverrides.global = null;
          directory = await Directory.systemTemp.createTemp(
            'summon-dish-live-',
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
            '${directory!.path}/key.pem',
            '-out',
            '${directory!.path}/cert.pem',
            '-subj',
            '/CN=127.0.0.1',
            '-addext',
            'subjectAltName=IP:127.0.0.1',
          ]);
          expect(cert.exitCode, 0, reason: cert.stderr.toString());
          node = await Process.start('node', [
            'test/fixtures/dish-preview-http.mjs',
            directory!.path,
          ]);
          unawaited(
            node!.stderr.transform(utf8.decoder).join().then((text) {
              hostErrors = text;
            }),
          );
          lines = StreamIterator(
            node!.stdout
                .transform(utf8.decoder)
                .transform(const LineSplitter()),
          );
          expect(
            await lines!.moveNext().timeout(const Duration(seconds: 15)),
            true,
            reason: hostErrors,
          );
          ready = jsonDecode(lines!.current) as Map<String, dynamic>;
          expect(ready['synthetic'], true);
          if (Platform.environment['DISH_REAL_ASR'] == '1') {
            final evidence = ready['hearingEvidence'] as Map<String, dynamic>;
            expect(
              evidence['source'],
              'synthetic-user-speech-real-offline-asr',
            );
            expect(evidence['understanding'], 'finite-whole-utterance-rules');
            expect(evidence['llmUsed'], false);
            expect(evidence['transcript'], isNotEmpty);
          }

          final origin = ready['origin'] as String;
          // Trust only this temporary local certificate, not arbitrary bad TLS.
          final trust = SecurityContext(withTrustedRoots: false)
            ..setTrustedCertificates('${directory!.path}/cert.pem');
          final jar = <String, String>{};
          http.Client factory() => _DishAuditClient(
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
          await session!.login(
            'synthetic-dish-invitation-aaaaaaaaaaaaaaaaaaaaa',
          );
          expect(session!.access.value, true);
        });
        final api = SceneExperimentApi(session!);
        final context = ready['context'] as Map<String, dynamic>;
        await tester.pumpWidget(
          MaterialApp(
            home: DishRemoteSurface(
              api: api,
              sessionId: ready['sessionId'] as String,
              creatureId: context['creatureId'] as String,
              sceneRevision: context['sceneRevision'] as int,
              access: session!.access,
            ),
          ),
        );
        Future<void> until(bool Function() condition) async {
          final deadline = DateTime.now().add(const Duration(seconds: 15));
          while (!condition()) {
            if (DateTime.now().isAfter(deadline)) {
              throw StateError(
                'dish UI deadline: ${tester.widgetList<Text>(find.byType(Text)).map((w) => w.data).toList()}; host=$hostErrors',
              );
            }
            await tester.runAsync(
              () => Future<void>.delayed(const Duration(milliseconds: 25)),
            );
            await tester.pump(const Duration(milliseconds: 40));
          }
        }

        bool idle() =>
            find.byKey(const Key('dish-remote-busy')).evaluate().isEmpty;
        await until(
          () => find.text('仅用于合成链路验收的菜品说明').evaluate().isNotEmpty && idle(),
        );
        DishView rendered() =>
            tester.widget<DishSurface>(find.byType(DishSurface)).view;
        final initial = rendered();
        expect(initial.sessionId, ready['sessionId']);
        expect(initial.dishId, ready['dishId']);
        expect(initial.taskId, ready['taskId']);
        expect(initial.revision, ready['revision']);
        expect(initial.view, 'details');
        expect(initial.speechPhase, 'stopped');
        expect(find.text('仅合成数据，无麦克风或真实语音播放。'), findsOneWidget);
        await tester.ensureVisible(find.text('查看合成插画'));
        await tester.tap(find.text('查看合成插画'));
        await until(
          () =>
              find
                  .byKey(const Key('dish-synthetic-image'))
                  .evaluate()
                  .isNotEmpty &&
              idle(),
        );
        expect(rendered().view, 'image');
        expect(rendered().revision, initial.revision + 1);
        await tester.ensureVisible(find.byKey(const Key('dish-zoom-in')));
        await tester.tap(find.byKey(const Key('dish-zoom-in')));
        await until(() => find.text('缩放 125%').evaluate().isNotEmpty && idle());
        final zoomed = rendered();
        expect(zoomed.sessionId, initial.sessionId);
        expect(zoomed.dishId, initial.dishId);
        expect(zoomed.taskId, initial.taskId);
        expect(zoomed.catalogDigest, initial.catalogDigest);
        expect(zoomed.revision, initial.revision + 2);
        expect(zoomed.zoomPermille, 1250);
        expect(zoomed.imageRef, 'synthetic-soup');
        expect(find.byType(Image), findsNothing);
        Map<String, dynamic>? persisted;
        Object? readError;
        unawaited(
          api
              .request('dish-read', {'sessionId': initial.sessionId})
              .then(
                (value) {
                  persisted = value;
                },
                onError: (Object error) {
                  readError = error;
                },
              ),
        );
        await until(() => persisted != null || readError != null);
        expect(readError, isNull);
        final reread = DishView.parse(persisted);
        expect(reread.revision, zoomed.revision);
        expect(reread.zoomPermille, 1250);
        expect(reread.dishId, initial.dishId);
        expect(reread.taskId, initial.taskId);
        final commands = calls
            .where((c) => c['path'] == '/scene/dish-command')
            .map((c) => c['body'] as Map<String, dynamic>)
            .toList();
        expect(commands, [
          {
            'sessionId': initial.sessionId,
            'command': {'kind': 'image', 'expectedRevision': initial.revision},
          },
          {
            'sessionId': initial.sessionId,
            'command': {
              'kind': 'zoom',
              'expectedRevision': initial.revision + 1,
              'direction': 'in',
            },
          },
        ]);
        // Exactly two presentation commands: no client stop confirmation/audio.
        expect(
          await tester.runAsync(
            () => File('${directory!.path}/core.sqlite').exists(),
          ),
          true,
        );
      } finally {
        await tester.pumpWidget(const SizedBox.shrink());
        try {
          await tester.runAsync(() async {
            session?.close();
            node?.kill(ProcessSignal.sigterm);
            if (node != null) {
              await node!.exitCode.timeout(const Duration(seconds: 10));
            }
            await lines?.cancel();
            if (directory != null) await directory!.delete(recursive: true);
          });
        } finally {
          HttpOverrides.global = previousOverrides;
        }
      }
    },
    timeout: const Timeout(Duration(seconds: 90)),
  );
}
