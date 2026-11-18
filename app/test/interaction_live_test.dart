import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:summon_app/scene_experiment.dart';
import 'package:summon_app/interaction_contract.dart';

class LocalClient extends http.BaseClient {
  LocalClient(this.port);
  final int port;
  final inner = http.Client();
  @override
  Future<http.StreamedResponse> send(http.BaseRequest r) {
    final request = http.Request(r.method, r.url.replace(port: port))
      ..headers.addAll(r.headers);
    if (r is http.Request) request.bodyBytes = r.bodyBytes;
    return inner.send(request);
  }

  @override
  void close() => inner.close();
}

void main() {
  test('actual Dart to Node host session edits saves queries and closes variable declaration', () async {
    final dir = await Directory.systemTemp.createTemp(
      'summon-interaction-dart-',
    );
    final process = await Process.start('node', [
      'test/fixtures/interaction-http.mjs',
      dir.path,
    ]);
    final errors = process.stderr.transform(utf8.decoder).join();
    LocalClient? client;
    try {
      final line = await process.stdout
          .transform(utf8.decoder)
          .transform(const LineSplitter())
          .first
          .timeout(const Duration(seconds: 10));
      client = LocalClient(jsonDecode(line)['port']);
      final api = SceneExperimentApi(client);
      final pointer = await api.interactionCurrent();
      expect(pointer!['sessionId'], 'trial-form');
      final raw = await api.request('interaction-read', {
        'sessionId': 'trial-form',
      });
      final view = validatedInteractionSession(
        raw,
        sessionId: 'trial-form',
        context: Map<String, dynamic>.from(pointer['context']),
      );
      expect(view, isNotNull);
      expect(view!['draft']['values'].values.every((v) => v == null), true);
      final edit = await api.request('interaction-edit', {
        'commandId': 'edit-one',
        'sessionId': 'trial-form',
        'expectedRevision': view['revision'],
        'changes': {
          'arbitrarySubject': '😀中',
          'details': '实际HTTP\n字段副本',
          'selection': 'y',
        },
      });
      final saved = await api.request('interaction-save', {
        'commandId': 'save-one',
        'sessionId': 'trial-form',
        'expectedRevision': edit['ack']['revision'],
        'confirmation': 'save-local-draft',
      });
      final query = await api.request('interaction-query', {
        'commandId': 'save-one',
      });
      expect(query['ack'], saved['ack']);
      await api.request('interaction-close', {
        'commandId': 'close-one',
        'sessionId': 'trial-form',
        'expectedRevision': saved['ack']['revision'],
      });
      expect(await api.interactionCurrent(), null);
      final note = await api.request('interaction-saved', {
        'noteId': saved['ack']['noteId'],
      });
      expect(note['draft']['values']['arbitrarySubject'], '😀中');
      expect(note['draft']['values']['details'], '实际HTTP\n字段副本');
    } finally {
      client?.close();
      process.kill(ProcessSignal.sigterm);
      await process.exitCode.timeout(const Duration(seconds: 10));
      await errors;
      await dir.delete(recursive: true);
    }
  });
}
