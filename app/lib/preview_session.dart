part of 'protected_preview_client.dart';

enum PreviewSessionPhase {
  checking,
  signedOut,
  ready,
  authenticating,
  locked,
  signingOut,
  closed,
}

/// Stable identity for Home and all open sheets. Authentication only replaces
/// its inner transport; it never repeats a scene request or clears a draft.
final class PreviewSessionClient extends http.BaseClient {
  factory PreviewSessionClient.currentPage() => PreviewSessionClient._(
    platform.currentPreviewOrigin(),
    () => http.Client(),
    platform.openPreviewLogin,
  );

  @visibleForTesting
  factory PreviewSessionClient.forTesting({
    required Uri origin,
    required http.Client Function() clientFactory,
    VoidCallback? openLogin,
  }) {
    if (!kDebugMode) throw StateError('preview_test_transport_disabled');
    return PreviewSessionClient._(origin, clientFactory, openLogin ?? () {});
  }
  PreviewSessionClient._(this._origin, this._factory, this._openLogin) {
    if (_origin.scheme != 'https' ||
        _origin.host.isEmpty ||
        _origin.userInfo.isNotEmpty ||
        _origin.query.isNotEmpty ||
        _origin.fragment.isNotEmpty ||
        !['', '/'].contains(_origin.path)) {
      throw const ApiFailure(0, 'invalid_preview_configuration');
    }
  }
  final Uri _origin;
  final http.Client Function() _factory;
  final VoidCallback _openLogin;
  final phase = ValueNotifier(PreviewSessionPhase.checking);
  final access = ValueNotifier(false);
  String message = '正在核验预览会话。';
  String? _csrf;
  ProtectedPreviewClient? _transport;
  Completer<void>? _attempt;
  int _epoch = 0;
  bool _closed = false, _everReady = false;
  bool get everReady => _everReady;
  int get generation => _epoch;
  bool get busy => _attempt != null;

  void _set(PreviewSessionPhase next, String text) {
    message = text;
    phase.value = next;
  }

  void openColdLogin() {
    if (!_closed && !_everReady && !busy) _openLogin();
  }

  void _lock(String text) {
    _csrf = null;
    _transport = null;
    access.value = false;
    _set(
      _everReady ? PreviewSessionPhase.locked : PreviewSessionPhase.signedOut,
      text,
    );
  }

  void cancelAuthentication() {
    if (_closed ||
        access.value ||
        phase.value == PreviewSessionPhase.signingOut) {
      return;
    }
    _epoch++;
    final abort = _attempt;
    _attempt = null;
    if (abort != null && !abort.isCompleted) abort.complete();
    _lock('认证已取消，原操作结果未判定；草稿仍在本页。可主动核对当前会话。');
  }

  Future<void> initialize() => checkSession();
  Future<void> checkSession() => _authenticate();
  Future<void> login(String invitation) async {
    if (invitation.length < 43 ||
        invitation.length > 256 ||
        RegExp(r'[\x00-\x20\x7f-\x9f]').hasMatch(invitation)) {
      _set(phase.value, '请输入有效邀请值。');
      return;
    }
    await _authenticate(invitation: invitation);
  }

  Future<void> _authenticate({String? invitation}) async {
    if (_closed || busy || access.value) return;
    final epoch = ++_epoch, abort = Completer<void>();
    _attempt = abort;
    bool current() => !_closed && epoch == _epoch && !abort.isCompleted;
    _set(
      invitation == null
          ? PreviewSessionPhase.checking
          : PreviewSessionPhase.authenticating,
      invitation == null ? '正在核验当前会话。' : '正在认证；不会重发原操作。',
    );
    try {
      if (invitation != null) {
        await _exchange('login', {'invitation': invitation}, abort.future);
        invitation = null;
        if (!current()) return;
      }
      final value = await _exchange('session', null, abort.future);
      if (!current()) return;
      if (value.length != 2 ||
          value['csrf'] is! String ||
          !RegExp(r'^[A-Za-z0-9_-]{43}$').hasMatch(value['csrf']) ||
          value['expiresInMs'] is! num ||
          !value['expiresInMs'].isFinite ||
          value['expiresInMs'] <= 0 ||
          value['expiresInMs'] > 1800000) {
        throw const ApiFailure(502, 'invalid_preview_session');
      }
      final csrf = value['csrf'] as String;
      late ProtectedPreviewClient fresh;
      fresh = ProtectedPreviewClient._(
        _origin,
        csrf,
        _factory(),
        const Duration(seconds: 10),
        () {
          if (!_closed && identical(_transport, fresh)) {
            _lock('预览认证已失效。保留文字及原命令，不会自动重试。');
          }
        },
      );
      _transport?.close();
      _transport = fresh;
      _csrf = csrf;
      _everReady = true;
      access.value = true;
      _set(PreviewSessionPhase.ready, '认证已就绪；保留草稿须主动核验原会话，未知操作只查原命令。');
    } catch (e) {
      if (current()) {
        _lock(
          e is ApiFailure && e.status == 429
              ? '尝试过于频繁，请稍后手动再试。'
              : '预览会话尚未就绪。原操作未重发，草稿仍在本页。',
        );
      }
    } finally {
      invitation = null;
      if (identical(_attempt, abort)) _attempt = null;
      if (!abort.isCompleted) abort.complete();
    }
  }

  Future<void> logout() async {
    if (_closed || busy || !access.value || _csrf == null) return;
    final csrf = _csrf!, abort = Completer<void>(), epoch = ++_epoch;
    _attempt = abort;
    final old = _transport;
    _transport = null;
    _csrf = null;
    access.value = false;
    old?.close();
    _set(PreviewSessionPhase.signingOut, '正在退出；本页保留副本不会自动保存。');
    try {
      final result = await _exchange('logout', {}, abort.future, csrf: csrf);
      if (_closed || epoch != _epoch) return;
      if (result.length != 1 || result['loggedOut'] != true) {
        throw const ApiFailure(502, 'invalid_logout');
      }
      _lock('已退出。保留副本仅在本页内存，关闭或刷新可能丢失。');
    } catch (_) {
      if (!_closed && epoch == _epoch) _lock('退出结果待核对，不自动重试。保留副本仍在本页。');
    } finally {
      if (identical(_attempt, abort)) _attempt = null;
      if (!abort.isCompleted) abort.complete();
    }
  }

  Future<Map<String, dynamic>> _exchange(
    String action,
    Map<String, dynamic>? body,
    Future<void> cancel, {
    String? csrf,
  }) async {
    final client = _factory(), abort = Completer<void>();
    void stop() {
      if (!abort.isCompleted) abort.complete();
    }

    unawaited(cancel.then((_) => stop()));
    final timer = Timer(const Duration(seconds: 10), stop);
    try {
      final request = http.AbortableRequest(
        body == null ? 'GET' : 'POST',
        _origin.replace(path: '/preview/$action'),
        abortTrigger: abort.future,
      )..followRedirects = false;
      if (body != null) {
        request.headers['Content-Type'] = 'application/json';
        request.body = jsonEncode(body);
      }
      if (csrf != null) request.headers['X-Preview-CSRF'] = csrf;
      final sending = client.send(request);
      unawaited(
        sending.then((r) {
          if (abort.isCompleted) unawaited(r.stream.listen((_) {}).cancel());
        }, onError: (Object _) {}),
      );
      final r = await Future.any([
        sending,
        abort.future.then<http.StreamedResponse>(
          (_) => throw http.RequestAbortedException(),
        ),
      ]);
      if (r.statusCode >= 300 && r.statusCode < 400) {
        unawaited(r.stream.listen((_) {}).cancel());
        throw const ApiFailure(502, 'preview_redirect_denied');
      }
      if (r.headers['content-type']?.split(';').first.trim().toLowerCase() !=
          'application/json') {
        unawaited(r.stream.listen((_) {}).cancel());
        throw const ApiFailure(502, 'preview_response_type_denied');
      }
      final bytes = await _bounded(r.stream, abort.future, 4096);
      if (abort.isCompleted) throw http.RequestAbortedException();
      final data = jsonDecode(utf8.decode(bytes, allowMalformed: false));
      if (r.statusCode != 200) {
        throw ApiFailure(r.statusCode, 'preview_auth_failed');
      }
      if (data is! Map<String, dynamic>) {
        throw const ApiFailure(502, 'invalid_preview_session');
      }
      return data;
    } finally {
      timer.cancel();
      stop();
      client.close();
    }
  }

  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) async {
    final active = _transport, epoch = _epoch;
    if (_closed || !access.value || active == null) {
      throw const ApiFailure(401, 'preview_authentication_required');
    }
    try {
      final result = await active.send(request);
      if (!identical(active, _transport) &&
          !(active._authenticationRetired &&
              epoch == _epoch &&
              _transport == null &&
              !access.value &&
              [401, 403].contains(result.statusCode))) {
        unawaited(result.stream.listen((_) {}).cancel());
        throw http.RequestAbortedException();
      }
      return result;
    } finally {
      if (!identical(active, _transport)) active.close();
    }
  }

  @override
  void close() {
    if (_closed) return;
    _closed = true;
    _epoch++;
    final abort = _attempt;
    _attempt = null;
    if (abort != null && !abort.isCompleted) abort.complete();
    _transport?.close();
    _transport = null;
    _csrf = null;
    access.value = false;
    _set(PreviewSessionPhase.closed, '预览连接已关闭。');
    super.close();
  }
}
