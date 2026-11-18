import 'dart:convert';

import 'package:http/http.dart' as http;

class ApiFailure implements Exception {
  const ApiFailure(this.status, this.code);
  final int status;
  final String code;
}

class SummonApi {
  SummonApi({
    required String endpoint,
    required this.token,
    required this.client,
  }) : endpoint = Uri.parse(endpoint.trim().replaceFirst(RegExp(r'/+$'), '')) {
    final local = [
      'localhost',
      '127.0.0.1',
      '10.0.2.2',
      '::1',
    ].contains(this.endpoint.host);
    if ((this.endpoint.scheme != 'https' &&
            !(this.endpoint.scheme == 'http' && local)) ||
        this.endpoint.userInfo.isNotEmpty ||
        this.endpoint.host.isEmpty ||
        this.endpoint.query.isNotEmpty ||
        this.endpoint.fragment.isNotEmpty ||
        this.endpoint.path.isNotEmpty) {
      throw const ApiFailure(0, 'invalid_endpoint');
    }
    if (token.trim().isEmpty) throw const ApiFailure(0, 'missing_token');
  }
  final Uri endpoint;
  final String token;
  final http.Client client;

  Future<Map<String, dynamic>> request(
    String path, {
    Map<String, dynamic>? body,
  }) async {
    if (!path.startsWith('/v1/')) throw const ApiFailure(0, 'invalid_path');
    final uri = endpoint.replace(path: path);
    final headers = {
      'Authorization': 'Bearer $token',
      'Content-Type': 'application/json',
    };
    final response =
        await (body == null
                ? client.get(uri, headers: headers)
                : client.post(uri, headers: headers, body: jsonEncode(body)))
            .timeout(Duration(seconds: path == '/v1/perceptions' ? 95 : 25));
    if (response.statusCode >= 400) {
      String code = 'request_failed';
      try {
        code = (jsonDecode(response.body) as Map)['error'] as String? ?? code;
      } catch (_) {}
      throw ApiFailure(response.statusCode, code);
    }
    final data = jsonDecode(utf8.decode(response.bodyBytes));
    if (data is! Map<String, dynamic>) {
      throw const ApiFailure(502, 'invalid_response');
    }
    return data;
  }
}
