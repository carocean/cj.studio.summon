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
class SessionCookieClient extends http.BaseClient {
  SessionCookieClient(this.inner, this.origin, this.jar);
  final http.Client inner;
  final String origin;
  final Map<String, String> jar;
  @override
  Future<http.StreamedResponse> send(http.BaseRequest r) async {
    expect(r.url.origin, origin);
    expect(r.followRedirects, false);
    r.headers['Origin'] = origin;
    if (jar['cookie'] != null) r.headers['Cookie'] = jar['cookie']!;
    final response = await inner.send(r);
    if (response.headers['set-cookie'] != null) {
      jar['cookie'] = response.headers['set-cookie']!.split(';').first;
    }
    return response;
  }

  @override
  void close() => inner.close();
}

void main() {
  test('actual TLS session initialization, shared-cookie CSRF replacement and explicit recovery', () async {
    final dir = await Directory.systemTemp.createTemp('summon-preview-tls-');
    Process? node;
    IOClient? native;
    PreviewSessionClient? protected;
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
      expect(await lines.moveNext().timeout(const Duration(seconds: 10)), true);
      final origin = jsonDecode(lines.current)['origin'] as String;
      // Explicit temporary trust anchor, no badCertificateCallback or global TLS change.
      final trust = SecurityContext(withTrustedRoots: false)
        ..setTrustedCertificates('${dir.path}/cert.pem');
      final jar = <String, String>{};
      http.Client factory() => SessionCookieClient(
        IOClient(HttpClient(context: trust)),
        origin,
        jar,
      );
      protected = PreviewSessionClient.forTesting(
        origin: Uri.parse(origin),
        clientFactory: factory,
      );
      await protected.initialize();
      expect(protected.access.value, false);
      await protected.login('synthetic-test-invitation-aaaaaaaaaaaaaaaaaaa');
      expect(protected.access.value, true);
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
      // Emulate a second browser page replacing the shared cookie, not an old-CSRF retry.
      native = IOClient(HttpClient(context: trust));
      final newLogin = await native.post(
        Uri.parse('$origin/preview/login'),
        headers: {'Origin': origin, 'Content-Type': 'application/json'},
        body: jsonEncode({
          'invitation': 'synthetic-test-invitation-aaaaaaaaaaaaaaaaaaa',
        }),
      );
      expect(newLogin.statusCode, 200);
      jar['cookie'] = newLogin.headers['set-cookie']!.split(';').first;
      await expectLater(
        api.request('interaction-query', {'commandId': 'tls-save'}),
        throwsA(isA<ApiFailure>().having((e) => e.status, 'status', 403)),
      );
      expect(protected.access.value, false);
      await protected.checkSession();
      expect(protected.access.value, true);
      expect(
        (await api.request('interaction-query', {
          'commandId': 'tls-save',
        }))['ack'],
        save['ack'],
      );
      await protected.logout();
      expect(protected.access.value, false);
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
  });
}
