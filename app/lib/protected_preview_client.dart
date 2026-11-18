import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;

import 'api.dart';
import 'preview_origin_stub.dart'
    if (dart.library.js_interop) 'preview_origin_web.dart'
    as platform;

part 'preview_session.dart';

/// Explicit text-only preview opt-in. No login, token persistence, retries, or
/// endpoint settings. Closing revokes this in-memory transport, not server state.
/// Production http 1.6.0 BrowserClient uses fetch redirect:error and propagates
/// AbortableRequest through AbortController, with same-origin credentials.
final class ProtectedPreviewClient extends http.BaseClient {
  factory ProtectedPreviewClient.currentPage({
    required String csrf,
    VoidCallback? onAuthenticationRequired,
  }) => ProtectedPreviewClient._(
    platform.currentPreviewOrigin(),
    csrf,
    http.Client(),
    const Duration(seconds: 10),
    onAuthenticationRequired,
  );

  @visibleForTesting
  factory ProtectedPreviewClient.forTesting({
    required Uri origin,
    required String csrf,
    required http.Client client,
    Duration timeout = const Duration(seconds: 10),
    VoidCallback? onAuthenticationRequired,
  }) {
    if (!kDebugMode) throw StateError('preview_test_transport_disabled');
    return ProtectedPreviewClient._(
      origin,
      csrf,
      client,
      timeout,
      onAuthenticationRequired,
    );
  }

  ProtectedPreviewClient._(
    this._origin,
    this._csrf,
    this._client,
    this._timeout,
    this._onAuthenticationRequired,
  ) {
    if (_origin.scheme != 'https' ||
        _origin.host.isEmpty ||
        _origin.userInfo.isNotEmpty ||
        _origin.query.isNotEmpty ||
        _origin.fragment.isNotEmpty ||
        !['', '/'].contains(_origin.path) ||
        !RegExp(r'^[A-Za-z0-9_-]{43,128}$').hasMatch(_csrf!) ||
        _timeout <= Duration.zero ||
        _timeout > const Duration(seconds: 10)) {
      _client.close();
      throw const ApiFailure(0, 'invalid_preview_configuration');
    }
  }

  static const _get = {
    'state',
    'usage',
    'interaction-current',
    'textgen-state',
  };
  static const _post = {
    'dish-read',
    'dish-command',
    'textgen-generate',
    'textgen-query',
    'textgen-cancel',
    'interaction-read',
    'interaction-edit',
    'interaction-save',
    'interaction-query',
    'interaction-close',
    'interaction-saved',
    'usage-select',
    'usage-presented',
    'usage-query',
  };
  final Uri _origin;
  final http.Client _client;
  final Duration _timeout;
  final VoidCallback? _onAuthenticationRequired;
  String? _csrf;
  bool _authenticationRetired = false;
  final _active = <Completer<void>>{};

  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) async {
    if (_csrf == null) throw const ApiFailure(0, 'preview_closed');
    // Only the existing fixed lab URL is an input. Neither a caller-supplied
    // remote URL nor an already-rewritten request can choose a destination.
    final url = request.url;
    final action = url.path.startsWith('/scene/')
        ? url.path.substring('/scene/'.length)
        : '';
    if (url.scheme != 'http' ||
        url.host != '127.0.0.1' ||
        url.port != 8091 ||
        url.userInfo.isNotEmpty ||
        url.query.isNotEmpty ||
        url.fragment.isNotEmpty ||
        !(request.method == 'GET'
                ? _get
                : request.method == 'POST'
                ? _post
                : const <String>{})
            .contains(action) ||
        request.headers.keys.any(
          (h) => !{'content-type', 'x-summon-lab'}.contains(h.toLowerCase()),
        )) {
      throw const ApiFailure(0, 'preview_endpoint_denied');
    }
    final abort = Completer<void>();
    void stop() {
      if (!abort.isCompleted) abort.complete();
    }

    _active.add(abort);
    if (request case http.Abortable(:final abortTrigger?)) {
      unawaited(
        abortTrigger.then((_) => stop(), onError: (Object _) => stop()),
      );
    }
    final timer = Timer(
      action == 'textgen-generate' ? _timeout * 6 : _timeout,
      stop,
    );
    try {
      final body = await _bounded(
        request.finalize(),
        abort.future,
        action == 'interaction-edit'
            ? 128 * 1024
            : action == 'textgen-generate'
            ? 64 * 1024
            : 4096,
      );
      if (request.method == 'GET' && body.isNotEmpty) {
        throw const ApiFailure(0, 'preview_get_body_denied');
      }
      if (request.method == 'POST' &&
          jsonDecode(utf8.decode(body, allowMalformed: false)) is! Map) {
        throw const ApiFailure(0, 'preview_json_required');
      }
      if (abort.isCompleted || _csrf == null) {
        throw http.RequestAbortedException();
      }
      final outgoing =
          http.AbortableRequest(
              request.method,
              _origin.replace(path: '/scene/$action'),
              abortTrigger: abort.future,
            )
            ..followRedirects = false
            ..headers['Accept'] = 'application/json';
      if (request.method == 'POST') {
        outgoing.headers.addAll({
          'Content-Type': 'application/json',
          'X-Preview-CSRF': _csrf!,
        });
        outgoing.bodyBytes = body;
      }
      final sending = _client.send(outgoing);
      unawaited(
        sending.then((response) {
          if (abort.isCompleted) {
            unawaited(response.stream.listen((_) {}).cancel());
          }
        }, onError: (Object _) {}),
      );
      final response = await Future.any([
        sending,
        abort.future.then<http.StreamedResponse>(
          (_) => throw http.RequestAbortedException(),
        ),
      ]);
      final authenticationDenied = response.statusCode == 401;
      if (authenticationDenied) _retireAuthentication(abort);
      if (response.statusCode >= 300 && response.statusCode < 400) {
        unawaited(response.stream.listen((_) {}).cancel());
        throw const ApiFailure(502, 'preview_redirect_denied');
      }
      if (response.headers['content-type']
              ?.split(';')
              .first
              .trim()
              .toLowerCase() !=
          'application/json') {
        unawaited(response.stream.listen((_) {}).cancel());
        throw ApiFailure(
          authenticationDenied ? 401 : 502,
          'preview_response_type_denied',
        );
      }
      final bytes = await _bounded(response.stream, abort.future, 128 * 1024);
      if (abort.isCompleted || (_csrf == null && !authenticationDenied)) {
        throw http.RequestAbortedException();
      }
      try {
        utf8.decode(bytes, allowMalformed: false);
      } on FormatException {
        if (authenticationDenied) {
          throw const ApiFailure(401, 'preview_invalid_auth_response');
        }
        rethrow;
      }
      if (response.statusCode == 403) {
        try {
          final value = jsonDecode(utf8.decode(bytes, allowMalformed: false));
          if (value is Map &&
              value.length == 1 &&
              value['error'] == 'csrf_required') {
            _retireAuthentication(abort);
          }
        } on FormatException {
          /* Other 403 responses do not grant authentication meaning. */
        }
      }
      return http.StreamedResponse(
        Stream.value(bytes),
        response.statusCode,
        headers: response.headers,
        request: request,
      );
    } finally {
      timer.cancel();
      stop();
      _active.remove(abort);
    }
  }

  void _retireAuthentication(Completer<void> own) {
    _authenticationRetired = true;
    _csrf = null;
    _onAuthenticationRequired?.call();
    for (final other in _active.toList()) {
      if (!identical(other, own) && !other.isCompleted) other.complete();
    }
  }

  @override
  void close() {
    _csrf = null;
    for (final abort in _active.toList()) {
      if (!abort.isCompleted) abort.complete();
    }
    _client.close();
    super.close();
  }
}

Future<List<int>> _bounded(
  Stream<List<int>> stream,
  Future<void> abort,
  int limit,
) {
  final done = Completer<List<int>>(), bytes = BytesBuilder(copy: false);
  StreamSubscription<List<int>>? subscription;
  void fail(Object e) {
    if (done.isCompleted) return;
    bytes.clear();
    done.completeError(e);
    unawaited(subscription?.cancel());
  }

  subscription = stream.listen(
    (chunk) {
      if (done.isCompleted) return;
      if (bytes.length + chunk.length > limit) {
        fail(const ApiFailure(502, 'preview_body_limit'));
        return;
      }
      bytes.add(chunk);
    },
    onError: (Object e) => fail(e),
    onDone: () {
      if (!done.isCompleted) done.complete(bytes.takeBytes());
    },
  );
  unawaited(abort.then((_) => fail(http.RequestAbortedException())));
  return done.future;
}
