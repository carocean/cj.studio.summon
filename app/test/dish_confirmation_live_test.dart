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
    'controlled proposal: explicit Flutter click → real protected TLS → same dish SQLite',
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
            'test/fixtures/dish-confirmation-http.mjs',
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
          expect(ready['asr'], 'controlled-fixture');
          expect(ready['model'], 'controlled-fixture');

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
        final before = DishView.parse(
          await tester.runAsync(
            () => api.request('dish-read', {'sessionId': ready['sessionId']}),
          ),
        );
        expect(before.view, 'none');
        await tester.pumpWidget(
          MaterialApp(
            home: DishConfirmationRemoteSurface(
              api: api,
              sessionId: ready['sessionId'] as String,
              onSwitchRequest: () {},
              access: session!.access,
            ),
          ),
        );
        Future<void> until(bool Function() condition) async {
          final deadline = DateTime.now().add(const Duration(seconds: 15));
          while (!condition()) {
            if (DateTime.now().isAfter(deadline)) {
              throw StateError('confirmation deadline: $hostErrors');
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

        await until(() => find.text('要展开『合成汤』的说明吗？').evaluate().isNotEmpty);
        expect(find.byType(EditableText), findsNothing);
        expect(
          calls.where((c) => c['path'] == '/scene/dish-confirmation-respond'),
          isEmpty,
        );
        final stillPending = DishView.parse(
          await fetch('dish-read', {'sessionId': ready['sessionId']}),
        );
        expect(stillPending.view, 'none');
        await tester.tap(find.text('展开说明'));
        await until(() => find.text('已展开当前菜品说明。').evaluate().isNotEmpty);
        expect(find.text('显式确认后同一道菜的合成说明'), findsOneWidget);
        final after = DishView.parse(
          await fetch('dish-read', {'sessionId': ready['sessionId']}),
        );
        expect(after.view, 'details');
        expect(after.dishId, before.dishId);
        expect(after.taskId, before.taskId);
        expect(after.catalogDigest, before.catalogDigest);
        expect(after.description, '显式确认后同一道菜的合成说明');
        final actions = calls
            .where((c) => c['path'] == '/scene/dish-confirmation-respond')
            .toList();
        expect(actions, hasLength(1));
        final input = actions.single['body'] as Map<String, dynamic>;
        expect(input.keys.toSet(), {'interactionId', 'choice'});
        expect(input['choice'], 'show');
        final replay = await fetch('dish-confirmation-respond', input);
        expect(replay['state'], 'expired');
        expect(calls.where((c) => c['path'] == '/scene/dish-command'), isEmpty);
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
