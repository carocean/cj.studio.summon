import 'dart:convert';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:summon_app/api.dart';

void main() {
  test('reject insecure remote and embedded credentials', () {
    final client = MockClient((_) async => http.Response('{}', 200));
    for (final endpoint in [
      'http://example.com',
      'https://user:password@example.com',
      'https://example.com/path',
      'file:///tmp/a'
    ]) {
      expect(() => SummonApi(endpoint: endpoint, token: 'test', client: client),
          throwsA(isA<ApiFailure>()));
    }
  });
  test('UTF8 contract and selected endpoint', () async {
    final client = MockClient((r) async {
      expect(r.url.toString(), 'http://127.0.0.1:8080/v1/sessions');
      expect(r.headers['Authorization'], 'Bearer local-test');
      expect(jsonDecode(r.body)['creatureId'], '主体');
      return http.Response.bytes(utf8.encode('{"id":"会话"}'), 201);
    });
    final api = SummonApi(
        endpoint: 'http://127.0.0.1:8080/',
        token: 'local-test',
        client: client);
    expect(
        (await api.request('/v1/sessions', body: {'creatureId': '主体'}))['id'],
        '会话');
  });
  test('structured errors and malformed response', () async {
    final api = SummonApi(
        endpoint: 'https://example.com',
        token: 'test',
        client: MockClient((_) async =>
            http.Response('{"error":"outside_service_boundary"}', 403)));
    await expectLater(
        api.request('/v1/creatures'),
        throwsA(isA<ApiFailure>()
            .having((e) => e.code, 'code', 'outside_service_boundary')));
    final bad = SummonApi(
        endpoint: 'https://example.com',
        token: 'test',
        client: MockClient((_) async => http.Response('[]', 200)));
    await expectLater(bad.request('/v1/creatures'), throwsA(isA<ApiFailure>()));
  });
}
