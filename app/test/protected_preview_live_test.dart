import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/io_client.dart';
import 'package:summon_app/api.dart';
import 'package:summon_app/protected_preview_client.dart';
import 'package:summon_app/scene_experiment.dart';

// Emulates browser-owned same-origin cookies/Origin in this native TLS test.
// The production preview factory never accepts this testing transport.
class TestCookieClient extends http.BaseClient {
  TestCookieClient(this.inner, this.origin, this.cookie);
  final http.Client inner;
  final String origin, cookie;
  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) {
    expect(request.url.origin, origin);
    expect(request.followRedirects, false);
    expect(request, isA<http.AbortableRequest>());
    request.headers.addAll({'Origin': origin, 'Cookie': cookie});
    return inner.send(request); // Keep AbortableRequest identity intact.
  }

  @override
  void close() => inner.close();
}

void main() {
  test(
    'actual Dart → trusted TLS gate → Node read/edit/save/query and logout',
    () async {
      final dir = await Directory.systemTemp.createTemp('summon-preview-tls-');
      Process? node;
      IOClient? native;
      ProtectedPreviewClient? protected;
      StreamIterator<String>? lines;
      try {
        final cert = await Process.run('openssl', [
          'req',
          '-x509',
          '-newkey',
          'rsa:2048',
          '-nodes',
          '-days',
          '1',
          '-keyout',
          '${dir.path}/key.pem',
          '-out',
          '${dir.path}/cert.pem',
          '-subj',
          '/CN=127.0.0.1',
          '-addext',
          'subjectAltName=IP:127.0.0.1',
        ]);
        expect(cert.exitCode, 0, reason: cert.stderr.toString());
        node = await Process.start('node', [
          'test/fixtures/preview-http.mjs',
          dir.path,
        ]);
        unawaited(node.stderr.drain<void>());
        lines = StreamIterator(
          node.stdout.transform(utf8.decoder).transform(const LineSplitter()),
        );
        expect(
          await lines.moveNext().timeout(const Duration(seconds: 10)),
          true,
        );
        final origin = jsonDecode(lines.current)['origin'] as String;
        // Explicit temporary trust anchor, no badCertificateCallback or global TLS change.
        final trust = SecurityContext(withTrustedRoots: false)
          ..setTrustedCertificates('${dir.path}/cert.pem');
        native = IOClient(HttpClient(context: trust));
        final login = await native.post(
          Uri.parse('$origin/preview/login'),
          headers: {'Origin': origin, 'Content-Type': 'application/json'},
          body: jsonEncode({
            'invitation': 'synthetic-test-invitation-aaaaaaaaaaaaaaaaaaa',
          }),
        );
        expect(login.statusCode, 200);
        final csrf = jsonDecode(login.body)['csrf'] as String;
        final cookie = login.headers['set-cookie']!.split(';').first;
        protected = ProtectedPreviewClient.forTesting(
          origin: Uri.parse(origin),
          csrf: csrf,
          client: TestCookieClient(native, origin, cookie),
        );
        final api = SceneExperimentApi(protected);
        final pointer = await api.interactionCurrent();
        expect(pointer!['sessionId'], 'tls-draft');
        expect((await api.request('usage'))['items'], isEmpty);
        final view = await api.request('interaction-read', {
          'sessionId': 'tls-draft',
        });
        final edit = await api.request('interaction-edit', {
          'commandId': 'tls-edit',
          'sessionId': 'tls-draft',
          'expectedRevision': view['revision'],
          'changes': {'contents': '真实TLS传输\n😀本地测试'},
        });
        final save = await api.request('interaction-save', {
          'commandId': 'tls-save',
          'sessionId': 'tls-draft',
          'expectedRevision': edit['ack']['revision'],
          'confirmation': 'save-local-draft',
        });
        final query = await api.request('interaction-query', {
          'commandId': 'tls-save',
        });
        expect(query['ack'], save['ack']);
        final saved = await api.request('interaction-saved', {
          'noteId': save['ack']['noteId'],
        });
        expect(saved['draft']['values']['contents'], '真实TLS传输\n😀本地测试');
        final logout = await native.post(
          Uri.parse('$origin/preview/logout'),
          headers: {
            'Origin': origin,
            'Cookie': cookie,
            'Content-Type': 'application/json',
            'X-Preview-CSRF': csrf,
          },
          body: '{}',
        );
        expect(logout.statusCode, 200);
        await expectLater(
          api.request('interaction-query', {'commandId': 'tls-save'}),
          throwsA(isA<ApiFailure>().having((e) => e.status, 'status', 401)),
        );
      } finally {
        protected?.close();
        native?.close();
        node?.kill(ProcessSignal.sigterm);
        if (node != null) {
          await node.exitCode.timeout(const Duration(seconds: 10));
        }
        await lines?.cancel();
        await dir.delete(recursive: true);
      }
    },
  );
}
