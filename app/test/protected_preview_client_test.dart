import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:summon_app/api.dart';
import 'package:summon_app/hearing_interaction.dart';
import 'package:summon_app/protected_preview_client.dart';
import 'package:summon_app/scene_experiment.dart';

const csrf = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
ProtectedPreviewClient preview(http.Client client, {Duration? timeout}) =>
    ProtectedPreviewClient.forTesting(
      origin: Uri.parse('https://preview.example:8443'),
      csrf: csrf,
      client: client,
      timeout: timeout ?? const Duration(seconds: 10),
    );

class Sending extends http.BaseClient {
  Sending(this.handler);
  final Future<http.StreamedResponse> Function(http.BaseRequest) handler;
  @override
  Future<http.StreamedResponse> send(http.BaseRequest r) => handler(r);
}

void main() {
  test(
    'explicit preview API maps only fixed authority; CSRF stays in POST header',
    () async {
      final requests = <http.Request>[];
      final client = preview(
        MockClient((r) async {
          requests.add(r);
          expect(r.url.origin, 'https://preview.example:8443');
          expect(r.followRedirects, false);
          expect(r.headers.containsKey('X-Summon-Lab'), false);
          expect(r.headers.containsKey('authorization'), false);
          return http.Response(
            r.url.path.endsWith('interaction-current') ? 'null' : '{}',
            200,
            headers: {'content-type': 'application/json'},
          );
        }),
      );
      final api = SceneExperimentApi(client);
      expect(await api.interactionCurrent(), isNull);
      await api.request('usage');
      await api.request('interaction-read', {'sessionId': 'one'});
      expect(requests.length, 3);
      expect(requests.first.headers['X-Preview-CSRF'], isNull);
      expect(requests.last.headers['X-Preview-CSRF'], csrf);
      expect(requests.last.body, '{"sessionId":"one"}');
      client.close();
    },
  );
  test('preview denies media, generation and all arbitrary URL forms before network', () async {
    var sent = 0;
    final client = preview(
      MockClient((r) async {
        sent++;
        return http.Response('{}', 200);
      }),
    );
    for (final url in [
      'https://other.example/scene/usage',
      'https://preview.example:8443/scene/usage',
      'http://127.0.0.1:8092/scene/usage',
      'http://localhost:8091/scene/usage',
      'http://x@127.0.0.1:8091/scene/usage',
      'http://127.0.0.1:8091/scene/usage?x=1',
      'http://127.0.0.1:8091/scene/usage#x',
      'http://127.0.0.1:8091/scene/%2fusage',
      'http://127.0.0.1:8091/scene/sense',
    ]) {
      await expectLater(
        client.get(Uri.parse(url)),
        throwsA(isA<ApiFailure>()),
        reason: url,
      );
    }
    await expectLater(
      generateHearingInteraction(client, {
        'eventId': 'one',
      }, Completer<void>().future),
      throwsA(isA<ApiFailure>()),
    );
    await expectLater(
      SceneExperimentApi(client).request('speak', {}),
      throwsA(isA<ApiFailure>()),
    );
    expect(sent, 0);
    client.close();
  });
  test('no redirect forwarding, retry, or inherited auth headers', () async {
    var sent = 0;
    final client = preview(
      MockClient((r) async {
        sent++;
        return http.Response(
          '',
          302,
          headers: {'location': 'https://other.example'},
        );
      }),
    );
    await expectLater(
      SceneExperimentApi(client).request('usage'),
      throwsA(isA<ApiFailure>()),
    );
    expect(sent, 1);
    await expectLater(
      client.get(
        Uri.parse('http://127.0.0.1:8091/scene/usage'),
        headers: {'Authorization': 'do-not-send'},
      ),
      throwsA(isA<ApiFailure>()),
    );
    expect(sent, 1);
    client.close();
  });
  for (final mode in ['cancel', 'timeout', 'close']) {
    test('real Abortable propagation and late reply retired: $mode', () async {
      final response = Completer<http.StreamedResponse>(),
          aborted = Completer<void>(),
          cancel = Completer<void>();
      var sent = 0, cancelledBody = false;
      final client = preview(
        Sending((r) async {
          sent++;
          expect(r, isA<http.AbortableRequest>());
          (r as http.AbortableRequest).abortTrigger!.then((_) {
            if (!aborted.isCompleted) aborted.complete();
          });
          return response.future;
        }),
        timeout: mode == 'timeout' ? const Duration(milliseconds: 20) : null,
      );
      final request = http.AbortableRequest(
        'POST',
        Uri.parse('http://127.0.0.1:8091/scene/interaction-query'),
        abortTrigger: cancel.future,
      )..body = '{}';
      final result = client.send(request);
      final assertion = expectLater(
        result,
        throwsA(isA<http.RequestAbortedException>()),
      );
      await Future<void>.delayed(const Duration(milliseconds: 5));
      if (mode == 'cancel') cancel.complete();
      if (mode == 'close') client.close();
      await assertion;
      await aborted.future;
      final body = StreamController<List<int>>(
        onCancel: () {
          cancelledBody = true;
        },
      );
      response.complete(http.StreamedResponse(body.stream, 200));
      await Future<void>.delayed(const Duration(milliseconds: 5));
      expect(cancelledBody, true);
      expect(sent, 1);
      await body.close();
      client.close();
    });
  }
  test(
    'bounded body, strict UTF8, request limit and revoke on close',
    () async {
      for (final bytes in [
        List<int>.filled(128 * 1024 + 1, 32),
        [0xff],
      ]) {
        final client = preview(
          Sending(
            (r) async => http.StreamedResponse(
              Stream.value(bytes),
              200,
              headers: {'content-type': 'application/json'},
            ),
          ),
        );
        await expectLater(
          SceneExperimentApi(client).request('usage'),
          throwsA(anything),
        );
        client.close();
      }
      var sent = 0;
      final client = preview(
        MockClient((r) async {
          sent++;
          return http.Response('{}', 200);
        }),
      );
      await expectLater(
        SceneExperimentApi(client)
            .request('interaction-query', {'x': 'a' * 4096}),
        throwsA(isA<ApiFailure>()),
      );
      expect(sent, 0);
      client.close();
      await expectLater(
        SceneExperimentApi(client).request('usage'),
        throwsA(isA<ApiFailure>()),
      );
      expect(sent, 0);
    },
  );
  test('preview config rejects insecure or non-origin destinations; default remains lab', () async {
    for (final origin in [
      'http://preview.example',
      'https://preview.example/path',
      'https://u@preview.example',
      'https://preview.example?x=1',
    ]) {
      final client = MockClient((r) async => http.Response('{}', 200));
      expect(
        () => ProtectedPreviewClient.forTesting(
          origin: Uri.parse(origin),
          csrf: csrf,
          client: client,
        ),
        throwsA(isA<ApiFailure>()),
      );
      client.close();
    }
    final lab = MockClient((r) async {
      expect(r.url.origin, 'http://127.0.0.1:8091');
      return http.Response(jsonEncode({}), 200);
    });
    await SceneExperimentApi(lab).request('usage');
    lab.close();
  });
  test('401 retires CSRF, aborts other requests, returns original status without retry', () async {
    final gate = Completer<void>(), second = Completer<http.StreamedResponse>();
    var sends = 0;
    final client = preview(
      Sending((r) async {
        sends++;
        if (sends == 1) {
          await gate.future;
          return http.StreamedResponse(
            Stream.value(utf8.encode('{"error":"authentication_required"}')),
            401,
            headers: {'content-type': 'application/json'},
          );
        }
        return second.future;
      }),
    );
    final api = SceneExperimentApi(client);
    final first = api.request('usage');
    final firstCheck = expectLater(
      first,
      throwsA(isA<ApiFailure>().having((e) => e.status, 'status', 401)),
    );
    final other = api.request('interaction-query', {
      'commandId': 'original-command',
    });
    final otherCheck = expectLater(
      other,
      throwsA(isA<http.RequestAbortedException>()),
    );
    await Future<void>.delayed(const Duration(milliseconds: 5));
    gate.complete();
    await firstCheck;
    await otherCheck;
    await expectLater(
      api.request('usage'),
      throwsA(
        isA<ApiFailure>().having((e) => e.code, 'code', 'preview_closed'),
      ),
    );
    expect(sends, 2);
    second.complete(http.StreamedResponse(Stream.value([]), 200));
    client.close();
  });
  test('non JSON response is rejected', () async {
    final client = preview(
      MockClient(
        (r) async =>
            http.Response('{}', 200, headers: {'content-type': 'text/html'}),
      ),
    );
    await expectLater(
      SceneExperimentApi(client).request('usage'),
      throwsA(
        isA<ApiFailure>().having(
          (e) => e.code,
          'code',
          'preview_response_type_denied',
        ),
      ),
    );
    client.close();
  });
  test('cancellation while body is streaming cancels subscription and discards partial bytes', () async {
    var cancelled = false;
    final body = StreamController<List<int>>(
      onCancel: () {
        cancelled = true;
      },
    );
    final cancel = Completer<void>();
    final client = preview(
      Sending(
        (r) async => http.StreamedResponse(
          body.stream,
          200,
          headers: {'content-type': 'application/json'},
        ),
      ),
    );
    final request = http.AbortableRequest(
      'GET',
      Uri.parse('http://127.0.0.1:8091/scene/usage'),
      abortTrigger: cancel.future,
    );
    final result = client.send(request);
    final check = expectLater(
      result,
      throwsA(isA<http.RequestAbortedException>()),
    );
    await Future<void>.delayed(const Duration(milliseconds: 5));
    body.add(utf8.encode('{"partial":'));
    cancel.complete();
    await check;
    expect(cancelled, true);
    await body.close();
    client.close();
  });
}
