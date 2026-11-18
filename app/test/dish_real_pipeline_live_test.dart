import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/io_client.dart';
import 'package:material_ui/material_ui.dart';
import 'package:summon_app/dish_confirmation_remote_surface.dart';
import 'package:summon_app/dish_contract.dart';
import 'package:summon_app/protected_preview_client.dart';
import 'package:summon_app/scene_experiment.dart';

import 'preview_session_live_test.dart' show SessionCookieClient;

// The fixture may own a local model server; no transcript is substituted. The opt-in
// fixture performs real offline TTS/ASR/LLM; its player remains controlled.
const _metadataKeys = [
  'caseId',
  'fixtureFatal',
  'modelProcessExit',
  'modelHealth',
  'modelServerMode',
  'utterance',
  'synthetic',
  'asr',
  'model',
  'player',
  'resultState',
  'transcript',
  'timings',
  'proposalKind',
  'modelError',
  'ttsEngine',
  'ttsModel',
  'asrEngine',
  'asrModel',
  'modelLabel',
  'microphone',
  'physicalPlayback',
];

const _cases = [
  {'id': 'question', 'utterance': '这是什么菜？', 'expected': 'pending'},
  {'id': 'explain', 'utterance': '解释一下这道菜。', 'expected': 'pending'},
  {'id': 'negation', 'utterance': '不要介绍这道菜。', 'expected': 'unrecognized'},
];

class _AuditClient extends http.BaseClient {
  _AuditClient(this.inner, this.calls);
  final http.Client inner;
  final List<String> calls;
  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) {
    // Paths only: never log cookies, CSRF tokens, invitations or response bodies.
    if (request.url.path.startsWith('/scene/dish-')) {
      calls.add(request.url.path);
    }
    return inner.send(request);
  }

  @override
  void close() => inner.close();
}

void main() {
  for (final sample in _cases) {
    testWidgets(
      'real speech pipeline ${sample['id']}: strict expected ${sample['expected']}',
      (tester) async {
        final wall = Stopwatch()..start();
        final previousOverrides = HttpOverrides.current;
        final calls = <String>[];
        Directory? directory;
        Process? node;
        StreamIterator<String>? lines;
        PreviewSessionClient? session;
        Map<String, dynamic>? ready;
        int? bodyVisibleMs, feedbackVisibleMs;
        String outcome = 'failed';
        String? failureType;
        bool negativeUiSafe = false;
        Object? setupError;
        StackTrace? setupStack;
        try {
          await tester.runAsync(() async {
            try {
              HttpOverrides.global = null;
              directory = await Directory.systemTemp.createTemp(
                'summon-real-ui-',
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
              expect(
                cert.exitCode,
                0,
                reason: 'temporary local certificate generation failed',
              );
              node = await Process.start('node', [
                'test/fixtures/dish-real-pipeline-http.mjs',
                directory!.path,
                sample['id']!,
              ]);
              // Drain stderr to avoid blocking; ready/error JSON and process status
              // carry evidence. Do not print arbitrary subprocess diagnostics.
              unawaited(node!.stderr.drain<void>());
              lines = StreamIterator(
                node!.stdout
                    .transform(utf8.decoder)
                    .transform(const LineSplitter()),
              );
              expect(
                await lines!.moveNext().timeout(const Duration(seconds: 180)),
                true,
                reason: 'fixture exited before ready JSON',
              );
              final raw = jsonDecode(lines!.current);
              expect(raw, isA<Map<String, dynamic>>());
              ready = raw as Map<String, dynamic>;
              stdout.writeln(
                jsonEncode({
                  'evidence': 'real-pipeline-ready-before-assertions',
                  'fixture': {
                    for (final key in _metadataKeys)
                      if (ready!.containsKey(key)) key: ready![key],
                  },
                }),
              );
              expect(ready!['caseId'], sample['id']);
              expect(ready!['synthetic'], true);
              expect(ready!['asr'], 'real-vosk');
              expect(ready!['model'], 'real-local-llm');
              expect(ready!['player'], 'controlled-fixture');
              expect(ready!['transcript'], isA<String>());
              expect((ready!['transcript'] as String).trim(), isNotEmpty);
              final timings = ready!['timings'];
              expect(timings, isA<Map<String, dynamic>>());
              for (final key in ['ttsMs', 'ingestMs', 'totalToReadyMs']) {
                expect(timings[key], isA<num>());
                expect((timings[key] as num).isFinite, true);
                expect(timings[key], greaterThanOrEqualTo(0));
              }
              expect(ready!['microphone'], false);
              expect(ready!['physicalPlayback'], false);
              final origin = ready!['origin'] as String;
              final trust = SecurityContext(withTrustedRoots: false)
                ..setTrustedCertificates('${directory!.path}/cert.pem');
              final jar = <String, String>{};
              http.Client factory() => _AuditClient(
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
            } catch (error, stack) {
              setupError = error;
              setupStack = stack;
            }
          });
          if (setupError != null) {
            Error.throwWithStackTrace(setupError!, setupStack!);
          }
          // Surface the original setup error in the test zone, not a secondary
          // setup-incomplete error after runAsync has already consumed it.
          if (session == null || ready == null) {
            throw StateError('real_pipeline_setup_incomplete');
          }
          // Never click a pending proposal for a negative case with a wrong state.
          expect(
            ready!['resultState'],
            sample['expected'],
            reason: 'real pipeline must meet the frozen expectation; no transcript repair',
          );
          final api = SceneExperimentApi(session!);
          final before = DishView.parse(
            await tester.runAsync(
              () =>
                  api.request('dish-read', {'sessionId': ready!['sessionId']}),
            ),
          );
          expect(before.view, 'none');
          await tester.pumpWidget(
            MaterialApp(
              home: DishConfirmationRemoteSurface(
                api: api,
                sessionId: ready!['sessionId'] as String,
                onSwitchRequest: () {},
                access: session!.access,
              ),
            ),
          );
          Future<void> until(bool Function() condition) async {
            final deadline = Stopwatch()..start();
            while (!condition()) {
              if (deadline.elapsed > const Duration(seconds: 15)) {
                throw StateError('real_pipeline_ui_deadline');
              }
              await tester.runAsync(
                () => Future<void>.delayed(const Duration(milliseconds: 25)),
              );
              await tester.pump(const Duration(milliseconds: 40));
            }
          }

          Future<Map<String, dynamic>> fetch(
            String action,
            Map<String, dynamic> body,
          ) async {
            Map<String, dynamic>? value;
            Object? error;
            unawaited(
              api
                  .request(action, body)
                  .then(
                    (r) {
                      value = r;
                    },
                    onError: (Object e) {
                      error = e;
                    },
                  ),
            );
            await until(() => value != null || error != null);
            if (error != null) throw error!;
            return value!;
          }

          if (sample['expected'] == 'pending') {
            await until(() => find.text('展开说明').evaluate().isNotEmpty);
            expect(
              calls.where((p) => p == '/scene/dish-confirmation-respond'),
              isEmpty,
            );
            expect(
              find.byKey(const Key('confirmed-dish-description')),
              findsNothing,
            );
            await tester.tap(find.text('展开说明'));
            await until(
              () => find
                  .byKey(const Key('confirmed-dish-description'))
                  .evaluate()
                  .isNotEmpty,
            );
            bodyVisibleMs = wall.elapsedMilliseconds;
            final after = DishView.parse(
              await fetch('dish-read', {'sessionId': ready!['sessionId']}),
            );
            expect(after.view, 'details');
            expect(after.dishId, before.dishId);
            expect(after.taskId, before.taskId);
            expect(after.catalogDigest, before.catalogDigest);
            expect(after.dishId, ready!['dishId']);
            expect(after.taskId, ready!['taskId']);
            expect(after.description, isNotNull);
            final shown = tester.widget<Text>(
              find.byKey(const Key('confirmed-dish-description')),
            );
            expect(shown.data, after.description);
            expect(after.revision, before.revision + 1);
            expect(
              calls.where((p) => p == '/scene/dish-confirmation-respond'),
              hasLength(1),
            );
          } else {
            await until(() => find.text('这次没听明白，请重新提出。').evaluate().isNotEmpty);
            feedbackVisibleMs = wall.elapsedMilliseconds;
            expect(find.text('展开说明'), findsNothing);
            expect(
              find.byKey(const Key('confirmed-dish-description')),
              findsNothing,
            );
            expect(
              calls.where((p) => p == '/scene/dish-confirmation-respond'),
              isEmpty,
            );
            final after = DishView.parse(
              await fetch('dish-read', {'sessionId': ready!['sessionId']}),
            );
            expect(after.view, 'none');
            expect(after.revision, before.revision);
            negativeUiSafe = true;
          }
          expect(find.byType(EditableText), findsNothing);
          expect(calls.where((p) => p == '/scene/dish-command'), isEmpty);
          if (sample['id'] == 'negation') {
            expect(
              ready!['proposalKind'],
              'none',
              reason:
                  'safe non-action is not proof of correct negation semantics',
            );
          }
          outcome = 'passed';
        } catch (error) {
          failureType = error.runtimeType.toString();
          rethrow;
        } finally {
          await tester.pumpWidget(const SizedBox.shrink());
          try {
            await tester.runAsync(() async {
              session?.close();
              node?.kill(ProcessSignal.sigterm);
              if (node != null) {
                try {
                  await node!.exitCode.timeout(const Duration(seconds: 10));
                } on TimeoutException {
                  node!.kill(ProcessSignal.sigkill);
                  await node!.exitCode.timeout(const Duration(seconds: 5));
                }
              }
              await lines?.cancel();
              if (directory != null) await directory!.delete(recursive: true);
            });
          } finally {
            HttpOverrides.global = previousOverrides;
            wall.stop();
            // Only whitelisted fixture metadata. No auth material or raw stderr.
            stdout.writeln(
              jsonEncode({
                'evidence': 'real-tts-asr-llm-tls-flutter',
                'caseId': sample['id'],
                'utterance': sample['utterance'],
                'expectedState': sample['expected'],
                'outcome': outcome,
                'failureType': failureType,
                'negativeUiSafe': negativeUiSafe,
                'wallTotalMs': wall.elapsedMilliseconds,
                'bodyVisibleMs': bodyVisibleMs,
                'feedbackVisibleMs': feedbackVisibleMs,
                'fixture': {
                  for (final key in _metadataKeys)
                    if (ready?.containsKey(key) ?? false) key: ready![key],
                },
              }),
            );
          }
        }
      },
      skip: Platform.environment['DISH_REAL_UI'] != '1',
      timeout: const Timeout(Duration(seconds: 240)),
    );
  }
}
