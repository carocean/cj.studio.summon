import 'dart:async';

import 'package:material_ui/material_ui.dart';

import 'creature_home.dart';
import 'protected_preview_client.dart';

/// An explicit, text-only preview entry. No developer routes or endpoint fields.
class PreviewApp extends StatefulWidget {
  const PreviewApp({
    super.key,
    this.session,
    this.controller,
    this.restaurantDevTarget = const RestaurantDevTarget(
      sessionId: 'meal',
      creatureId: 'companion',
      sceneRevision: 1,
    ),
  });
  final PreviewSessionClient? session;
  final CreatureHomeController? controller;
  final RestaurantDevTarget restaurantDevTarget;
  @override
  State<PreviewApp> createState() => _PreviewAppState();
}

class _PreviewAppState extends State<PreviewApp> {
  PreviewSessionClient? _session;
  late final CreatureHomeController _controller;
  final _invitation = TextEditingController();
  final _navigator = GlobalKey<NavigatorState>();
  bool _hasHome = false, _showInput = false, _showOptions = false;
  String? _entryMessage;
  @override
  void initState() {
    super.initState();
    _controller = widget.controller ?? CreatureHomeController();
    try {
      _session = widget.session ?? PreviewSessionClient.currentPage();
      _session!.phase.addListener(_changed);
      _hasHome = _session!.access.value;
      unawaited(_session!.initialize());
    } catch (
      _
    ) {} // Non-browser/non-HTTPS preview fails closed, no local fallback.
  }

  void _changed() {
    if (!mounted) return;
    setState(() {
      if (!_session!.access.value) _showOptions = false;
      if (_session!.access.value) {
        _hasHome = true;
        _showInput = false;
        _invitation.clear();
      }
    });
  }

  Future<void> _login() async {
    final value = _invitation.text;
    _invitation.clear();
    await _session!.login(value);
    if (mounted) setState(() {});
  }

  void _cancel() {
    _invitation.clear();
    _session!.cancelAuthentication();
    setState(() => _showInput = false);
  }

  Future<void> _logout(BuildContext context) async {
    final generation = _session!.generation;
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (c) => AlertDialog(
        title: const Text('退出预览？'),
        content: Text(
          _controller.hasUnsavedInteractions
              ? '有未保存输入或结果未知的操作。退出不等于保存，也不会重发原命令；副本只留在本页，刷新或关闭可能丢失。'
              : '退出不会保存内容。本页保留副本在刷新或关闭后可能丢失。',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(c, false),
            child: const Text('取消'),
          ),
          TextButton(
            key: const Key('preview-confirm-logout'),
            onPressed: () => Navigator.pop(c, true),
            child: const Text('退出并保留本页副本'),
          ),
        ],
      ),
    );
    if (!mounted || confirmed != true || generation != _session!.generation) {
      return;
    }
    await _session!.logout();
  }

  @override
  void dispose() {
    _session?.phase.removeListener(_changed);
    _session?.close();
    _invitation.clear();
    _invitation.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => MaterialApp(
    debugShowCheckedModeBanner: false,
    navigatorKey: _navigator,
    initialRoute: '/',
    theme: ThemeData(
      fontFamily: 'SummonPreviewSC',
      colorScheme: ColorScheme.fromSeed(seedColor: const Color(0xff385C58)),
      useMaterial3: true,
    ),
    home: _hasHome
        ? CreatureHome(
            key: const ValueKey('preview-stable-home'),
            controller: _controller,
            client: _session,
            interactionAccess: _session!.access,
            enableTextInteraction: true,
            restaurantDevTarget:
                const bool.fromEnvironment('SUMMON_RESTAURANT_DEV') &&
                    const bool.fromEnvironment('SUMMON_PROTECTED_PREVIEW')
                ? widget.restaurantDevTarget
                : null,
          )
        : const Scaffold(body: Center(child: Text('受保护的文字预览'))),
    // Unknown URL/routes cannot enter the local workbench or configurable API UI.
    onUnknownRoute: (_) => MaterialPageRoute<void>(
      builder: (_) => const Scaffold(body: Center(child: Text('此预览不开放开发路由。'))),
    ),
    builder: (context, child) => Overlay.wrap(
      child: LayoutBuilder(
        builder: (context, constraints) {
          final visibleHeight =
              (constraints.maxHeight - MediaQuery.viewInsetsOf(context).bottom)
                  .clamp(0.0, constraints.maxHeight);
          return Column(
            children: [
              SafeArea(
                bottom: false,
                child: ConstrainedBox(
                  constraints: BoxConstraints(
                    maxHeight: (visibleHeight * .45).clamp(0.0, 280.0),
                  ),
                  child: Material(
                    key: const Key('preview-auth-region'),
                    elevation: 2,
                    child: SingleChildScrollView(
                      key: ValueKey(
                        'preview-auth-scroll-${_session?.phase.value}',
                      ),
                      padding: const EdgeInsets.symmetric(
                        horizontal: 12,
                        vertical: 4,
                      ),
                      child: _session == null
                          ? const Text('预览仅支持当前 HTTPS 页面；不会回退到本地开发连接。')
                          : _authPanel(context),
                    ),
                  ),
                ),
              ),
              Expanded(child: child ?? const SizedBox()),
            ],
          );
        },
      ),
    ),
  );
  Widget _authPanel(BuildContext context) {
    final session = _session!,
        ready = session.access.value,
        busy = session.busy;
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        if (!ready || busy)
          Text(session.message, key: const Key('preview-status')),
        if (ready) ...[
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              const Flexible(child: Text('认证就绪', key: Key('preview-ready'))),
              TextButton(
                key: const Key('preview-options'),
                onPressed: busy
                    ? null
                    : () => setState(() => _showOptions = !_showOptions),
                child: Text(_showOptions ? '收起会话选项' : '预览会话'),
              ),
            ],
          ),
          if (_showOptions) ...[
            TextButton(
              key: const Key('preview-text-demand'),
              onPressed: busy
                  ? null
                  : () async {
                      setState(() {
                        _showOptions = false;
                        _entryMessage = null;
                      });
                      final result = await _controller.presentTextDemand();
                      if (mounted &&
                          result != CreaturePresentationResult.shown) {
                        setState(
                          () => _entryMessage = '未打开文字入口；当前内容未替换，可返回当前任务后再选择。',
                        );
                      }
                    },
              child: const Text('本次用文字提出需求'),
            ),
            TextButton(
              key: const Key('preview-logout'),
              onPressed: busy
                  ? null
                  : () => _logout(_navigator.currentState!.overlay!.context),
              child: const Text('退出预览'),
            ),
          ],
          if (_entryMessage != null) Text(_entryMessage!),
        ] else ...[
          if (_showInput) ...[
            TextField(
              key: const Key('preview-invitation'),
              controller: _invitation,
              obscureText: true,
              autofillHints: const [],
              autocorrect: false,
              enableSuggestions: false,
              decoration: const InputDecoration(labelText: '邀请值（只用于本次认证）'),
            ),
            TextButton(
              key: const Key('preview-login-submit'),
              onPressed: busy ? null : _login,
              child: const Text('认证，不重发原操作'),
            ),
          ] else if (_hasHome)
            TextButton(
              key: const Key('preview-reauth'),
              onPressed: busy ? null : () => setState(() => _showInput = true),
              child: const Text('就地重新认证'),
            ),
          if (!_hasHome && !busy)
            TextButton(
              key: const Key('preview-cold-login'),
              onPressed: session.openColdLogin,
              child: const Text('前往固定登录页'),
            ),
          if (!ready)
            TextButton(
              key: const Key('preview-check-session'),
              onPressed: busy ? null : session.checkSession,
              child: const Text('核对当前认证（不重发操作）'),
            ),
          if ((_showInput || busy) &&
              session.phase.value != PreviewSessionPhase.signingOut)
            TextButton(
              key: const Key('preview-auth-cancel'),
              onPressed: _cancel,
              child: const Text('取消认证输入，保留查看草稿'),
            ),
        ],
      ],
    );
  }
}
