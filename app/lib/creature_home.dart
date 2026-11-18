import 'dish_remote_surface.dart';

import 'dart:async';

import 'package:material_ui/material_ui.dart';
import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;

import 'standin_avatar.dart';
import 'api.dart';
import 'real_usage.dart';
import 'media_captions.dart';
import 'scene_experiment.dart';
import 'scene_text_entry.dart';
import 'choice_form.dart';
import 'creature_registry.dart';
import 'creature_market.dart';
import 'creature_sense.dart';
import 'perception_capture.dart';
import 'focus_sheet.dart';
import 'handoff_sheet.dart';
import 'temporary_interaction.dart';
import 'interaction_contract.dart';
import 'text_interaction.dart';
import 'text_interaction_sheet.dart';

/// Host runtime presentation intents, not permissions, captured speech or model code.
enum CreatureIntent {
  textInput,
  account,
  focus,
  handoff,
  market,
  companions,
  hearing,
  vision,
}

enum CreaturePresentationResult {
  shown,
  notAttached,
  stale,
  blocked,
  unavailable,
}

class CreatureHomeController {
  Future<CreaturePresentationResult> Function(String, Map<String, dynamic>)?
  _presentDish;
  Future<CreaturePresentationResult> presentDish(
    String sessionId, {
    required Map<String, dynamic> expectedContext,
  }) =>
      _presentDish?.call(
        sessionId,
        Map<String, dynamic>.unmodifiable(expectedContext),
      ) ??
      Future.value(CreaturePresentationResult.notAttached);

  final _textDemand = TextInteractionDraft();
  Future<CreaturePresentationResult> Function()? _presentTextDemand;
  Future<CreaturePresentationResult> presentTextDemand() =>
      _presentTextDemand?.call() ??
      Future.value(CreaturePresentationResult.notAttached);
  bool get hasUnsavedInteractions =>
      _textDemand.hasWork ||
      _interactions.values.any((d) => d.dirty || d.pending != null);
  final Map<String, InteractionDraftState> _interactions = {};
  Future<CreaturePresentationResult> Function(String, Map<String, dynamic>?)?
  _presentInteraction;
  Future<CreaturePresentationResult> presentInteraction(
    String sessionId, {
    Map<String, dynamic>? expectedContext,
  }) =>
      _presentInteraction?.call(
        sessionId,
        expectedContext == null
            ? null
            : Map<String, dynamic>.unmodifiable(expectedContext),
      ) ??
      Future.value(CreaturePresentationResult.notAttached);

  Future<CreaturePresentationResult> Function(String)? _resumeInteraction,
      _pauseInteraction;
  Future<CreaturePresentationResult> resumeInteraction(String sessionId) =>
      _resumeInteraction?.call(sessionId) ??
      Future.value(CreaturePresentationResult.notAttached);
  Future<CreaturePresentationResult> pauseInteractionForHearing(
    String sessionId,
  ) =>
      _pauseInteraction?.call(sessionId) ??
      Future.value(CreaturePresentationResult.notAttached);

  Future<void> Function()? _refreshUsage;
  Future<void> refreshUsage() async {
    await _refreshUsage?.call();
  }

  BoundMediaCaptions? _captions;
  BoundMediaCaptions? get mediaCaptions => _captions;
  Future<bool> Function()? _refreshMedia;
  Future<bool> refreshMediaContext() =>
      _refreshMedia?.call() ?? Future.value(false);
  Future<CreaturePresentationResult> Function(
    CreatureIntent,
    Map<String, dynamic>?,
  )?
  _present;
  VoidCallback? _dismiss;
  Future<CreaturePresentationResult> present(
    CreatureIntent intent, {
    Map<String, dynamic>? expectedContext,
  }) =>
      _present?.call(
        intent,
        expectedContext == null
            ? null
            : Map<String, dynamic>.unmodifiable(expectedContext),
      ) ??
      Future.value(CreaturePresentationResult.notAttached);
  void dismiss() => _dismiss?.call();
}

/// The user entry is only a human-shaped stand-in. It has no hidden hit targets.
/// No capture/permission/provider request is made until a host intent requests a
/// bounded surface. This presentation seam does not claim automatic perception.
class CreatureHome extends StatefulWidget {
  const CreatureHome({
    super.key,
    this.controller,
    this.client,
    this.senseCaptureFactory,
    this.enableHearingInteraction = false,
    this.enableTextInteraction = false,
    this.interactionAccess,
  });
  final CreatureHomeController? controller;
  final http.Client? client;
  final SenseCapture Function()? senseCaptureFactory;
  final bool enableHearingInteraction;
  final bool enableTextInteraction;
  final ValueListenable<bool>? interactionAccess;
  @override
  State<CreatureHome> createState() => _CreatureHomeState();
}

class _CreatureHomeState extends State<CreatureHome>
    with WidgetsBindingObserver {
  late final http.Client _client;
  late final SceneExperimentApi _api;
  List<Map<String, dynamic>> _frequent = [];
  int _usageEpoch = 0;
  bool _usageBusy = false, _selectionUntracked = false;
  final _registryRecovery = CreatureSelectionRecovery();
  Map<String, dynamic>? _selectionPending;
  final Map<String, Map<String, dynamic>> _presentationPending = {};
  String? _usageMessage;
  final FocusRecovery _focusRecovery = FocusRecovery();
  final BoundMediaCaptions _captions = BoundMediaCaptions();
  Route<void>? _surface;
  bool _interactionVisible = false;
  String? _visibleInteraction;
  final Map<String, InteractionDraftState> _localInteractions = {};
  int _epoch = 0, _mediaRefresh = 0, _authEpoch = 0;
  final _localTextDemand = TextInteractionDraft();
  TextInteractionDraft get _textDemand =>
      widget.controller?._textDemand ?? _localTextDemand;
  void _authenticationChanged() {
    _authEpoch++;
  }

  bool _foreground = true;
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    widget.interactionAccess?.addListener(_authenticationChanged);
    _foreground =
        WidgetsBinding.instance.lifecycleState == null ||
        WidgetsBinding.instance.lifecycleState == AppLifecycleState.resumed;
    _captions.setForeground(_foreground);
    _client = widget.client ?? http.Client();
    _api = SceneExperimentApi(_client);
    _bind(widget.controller);
    unawaited(_refreshUsage());
  }

  Future<void> _refreshUsage() async {
    final round = ++_usageEpoch;
    try {
      for (final entry in _presentationPending.entries.toList()) {
        try {
          final r = await _api.request('usage-query', {'commandId': entry.key});
          if (r['commandId'] == entry.key &&
              ((r['status'] == 'completed' &&
                      r.length == 3 &&
                      validatedUsageAck(
                            r['ack'],
                            entry.value,
                            selection: false,
                            stored: true,
                          ) !=
                          null) ||
                  (r['status'] == 'untracked' &&
                      r['reason'] == 'learning-saturated' &&
                      r.length == 3))) {
            _presentationPending.remove(entry.key);
          }
        } catch (_) {}
      }
      final raw = await _api.request('usage');
      if (!mounted || !_foreground || round != _usageEpoch) return;
      final history = validatedUsage(raw);
      setState(
        () => _frequent = history == null
            ? []
            : (history['items'] as List)
                  .take(4)
                  .map((e) => Map<String, dynamic>.from(e))
                  .toList(),
      );
    } catch (_) {
      if (mounted && round == _usageEpoch) setState(() => _frequent = []);
    }
  }

  bool get _hasRetainedWork =>
      _drafts.values.any((d) => d.presented && (d.dirty || d.pending != null));
  Future<void> _openFrequent(Map<String, dynamic> item) async {
    if (!_foreground ||
        _surface != null ||
        _usageBusy ||
        _selectionPending != null ||
        _registryRecovery.body != null ||
        ModalRoute.of(context)?.isCurrent == false) {
      return;
    }
    if (item['kind'] == 'creature' && _hasRetainedWork) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('请先处理保留草稿，再切换生物；不会自动保存或清除。')),
      );
      return;
    }
    final epoch = _epoch;
    setState(() {
      _usageBusy = true;
      _usageMessage = null;
    });
    try {
      final state = await _api.request('state');
      if (!mounted ||
          !_current(epoch) ||
          _surface != null ||
          ModalRoute.of(context)?.isCurrent == false) {
        return;
      }
      final frame = _frame(state);
      if (frame == null) return;
      if (item['kind'] == 'interaction-session') {
        final shown = await _presentInteraction(
          item['targetId'],
          frame,
          explicitUsage: true,
          usageDiscovery: true,
        );
        if (mounted && shown != CreaturePresentationResult.shown) {
          ScaffoldMessenger.of(context)
              .showSnackBar(const SnackBar(content: Text('此临时内容已不可用，不会自动重建。')));
        }
        await _refreshUsage();
      } else {
        if (_hasRetainedWork ||
            registeredCreature(state, item['targetId']) == null) {
          return;
        }
        final body = <String, dynamic>{
          'commandId': usageCommandId(),
          'creatureId': item['targetId'],
          'context': frame,
        };
        _selectionUntracked = false;
        _selectionPending = body;
        final result = await _api.request('usage-select', body);
        final ack = validatedUsageResult(result, body, selection: true);
        if (ack == null) throw const ApiFailure(502, 'invalid_usage_receipt');
        _selectionPending = null;
        if (!_current(epoch)) return;
        await _refreshMedia();
        await _refreshUsage();
      }
    } catch (_) {
      if (mounted) setState(() => _usageMessage = '结果待核对，不自动重发。');
    } finally {
      if (mounted) setState(() => _usageBusy = false);
    }
  }

  Future<void> _querySelection() async {
    final body = _selectionPending;
    final epoch = _epoch, route = ModalRoute.of(context);
    bool valid() =>
        _current(epoch) &&
        _surface == null &&
        identical(route, ModalRoute.of(context)) &&
        route?.isCurrent == true &&
        identical(body, _selectionPending);
    if (body == null || _usageBusy || !_foreground || _surface != null) return;
    setState(() => _usageBusy = true);
    try {
      final r = await _api.request('usage-query', {
        'commandId': body['commandId'],
      });
      if (!valid()) return;
      if (r['commandId'] == body['commandId'] &&
          r['status'] == 'completed' &&
          r.length == 3 &&
          validatedUsageAck(r['ack'], body, selection: true, stored: true) !=
              null) {
        _selectionPending = null;
        _selectionUntracked = false;
        await _refreshMedia();
        await _refreshUsage();
        if (mounted) setState(() => _usageMessage = null);
      } else if (r['commandId'] == body['commandId'] &&
          r['status'] == 'untracked' &&
          r['reason'] == 'learning-saturated' &&
          r.length == 3) {
        final state = await _api.request('state');
        if (valid() && _frame(state) != null) {
          _captions.bind(state);
          setState(() {
            _selectionUntracked = true;
            _usageMessage = '原动作无历史回执，不能判定成功或未执行。已核验当前状态，可结束核对后另选。';
          });
        }
      }
    } catch (_) {
    } finally {
      if (mounted) setState(() => _usageBusy = false);
    }
  }

  void _reportPresentation(
    Map<String, dynamic> view,
    Route<void> route,
    int epoch,
  ) {
    if (_presentationPending.length >= 64) return;
    final body = <String, dynamic>{
      'commandId': usageCommandId(),
      'sessionId': view['sessionId'],
      'context': view['context'],
      'expectedRevision': view['revision'],
      'programDigest': view['program']['programDigest'],
      'confirmation': 'presented-explicitly',
    };
    WidgetsBinding.instance.addPostFrameCallback((_) async {
      if (!_current(epoch) || !identical(route, _surface) || !route.isCurrent) {
        return;
      }
      _presentationPending[body['commandId']] = body;
      try {
        final r = await _api.request('usage-presented', body);
        if (validatedUsageResult(r, body, selection: false) != null) {
          _presentationPending.remove(body['commandId']);
        }
      } catch (
        _
      ) {} // Unknown telemetry stays pending; never resend the report.
      if (mounted) await _refreshUsage();
    });
  }

  void _bind(CreatureHomeController? controller) {
    if (controller == null) return;
    if (controller._present != null) {
      throw StateError('controller_already_attached');
    }
    controller._presentDish = _presentDish;
    controller._presentTextDemand = _presentTextDemand;
    controller._refreshUsage = _refreshUsage;
    controller._present = _present;
    controller._dismiss = _dismiss;
    controller._captions = _captions;
    controller._refreshMedia = _refreshMedia;
    controller._presentInteraction = _presentInteraction;
    controller._resumeInteraction = _resumeInteraction;
    controller._pauseInteraction = _pauseInteractionForHearing;
  }

  void _unbind(CreatureHomeController? controller) {
    if (controller?._present == _present) {
      controller!._presentDish = null;
      controller._presentTextDemand = null;
      controller._refreshUsage = null;
      controller._present = null;
      controller._dismiss = null;
      controller._captions = null;
      controller._refreshMedia = null;
      controller._presentInteraction = null;
      controller._resumeInteraction = null;
      controller._pauseInteraction = null;
    }
  }

  @override
  void didUpdateWidget(CreatureHome old) {
    super.didUpdateWidget(old);
    if (old.interactionAccess != widget.interactionAccess) {
      old.interactionAccess?.removeListener(_authenticationChanged);
      widget.interactionAccess?.addListener(_authenticationChanged);
      _authEpoch++;
    }
    if (old.controller != widget.controller) {
      _unbind(old.controller);
      _dismiss();
      _bind(widget.controller);
    }
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    _foreground = state == AppLifecycleState.resumed;
    _captions.setForeground(_foreground);
    if (!_foreground) {
      _epoch++;
      _captions.clear();
    }
  }

  void _dismiss() {
    _captions.clear();
    _epoch++;
    final route = _surface;
    _surface = null;
    _interactionVisible = false;
    _visibleInteraction = null;
    if (route?.navigator != null) route!.navigator!.removeRoute(route);
  }

  Future<bool> _refreshMedia() async {
    final refresh = ++_mediaRefresh;
    final epoch = _epoch;
    if (!_foreground) return false;
    try {
      final state = await _api.request('state');
      if (!_current(epoch) || refresh != _mediaRefresh) return false;
      if (_frame(state) == null) {
        _captions.clear();
        return false;
      }
      _captions.bind(state);
      return true;
    } catch (_) {
      if (_current(epoch) && refresh == _mediaRefresh) _captions.clear();
      return false;
    }
  }

  bool _current(int epoch) => mounted && _foreground && epoch == _epoch;
  Map<String, dynamic>? _frame(Map<String, dynamic> state) {
    final frame = state['context'];
    if (state['mode'] != 'deterministic-synthetic' ||
        frame is! Map ||
        frame.length != 2 ||
        frame['creatureId'] is! String ||
        frame['creatureId'] != state['activeCreatureId'] ||
        frame['sceneRevision'] is! int ||
        frame['sceneRevision'] < 1 ||
        frame['sceneRevision'] > 9007199254740991 ||
        registeredCreature(state, frame['creatureId']) == null) {
      return null;
    }
    return Map<String, dynamic>.from(frame);
  }

  Map<String, InteractionDraftState> get _drafts =>
      widget.controller?._interactions ?? _localInteractions;
  Future<CreaturePresentationResult> _resumeInteraction(
    String sessionId,
  ) async {
    if (_drafts[sessionId]?.presented != true) {
      return CreaturePresentationResult.blocked;
    }
    return _presentInteraction(sessionId, null);
  }

  bool _resumeAllowed(
    Map<String, dynamic> state,
    InteractionDraftState draft,
  ) =>
      !draft.resumeReadOnly &&
      _frame(state) != null &&
      interactionCanonical(state['context']) ==
          interactionCanonical(draft.view!['context']);
  Future<CreaturePresentationResult> _presentDish(
    String sessionId,
    Map<String, dynamic> expected,
  ) async {
    final access = widget.interactionAccess;
    if (!_foreground ||
        _surface != null ||
        access == null ||
        !access.value ||
        !interactionId(sessionId)) {
      return CreaturePresentationResult.blocked;
    }
    final epoch = ++_epoch, auth = _authEpoch;
    try {
      final state = await _api.request('state');
      if (!_current(epoch) ||
          !access.value ||
          auth != _authEpoch ||
          !identical(access, widget.interactionAccess)) {
        return CreaturePresentationResult.stale;
      }
      final frame = _frame(state);
      if (frame == null ||
          interactionCanonical(frame) != interactionCanonical(expected)) {
        return CreaturePresentationResult.stale;
      }
      return _show(
        DishRemoteSurface(
          api: _api,
          sessionId: sessionId,
          creatureId: frame['creatureId'],
          sceneRevision: frame['sceneRevision'],
          access: access,
        ),
        epoch,
      );
    } catch (_) {
      return CreaturePresentationResult.unavailable;
    }
  }

  Future<CreaturePresentationResult> _presentTextDemand() async {
    final route = _surface, epoch = _epoch, auth = _authEpoch;
    if (!widget.enableTextInteraction ||
        !_foreground ||
        !(widget.interactionAccess?.value ?? true) ||
        (route != null && (!_interactionVisible || !route.isCurrent)) ||
        (route == null && ModalRoute.of(context)?.isCurrent != true)) {
      return CreaturePresentationResult.blocked;
    }
    final prior = _visibleInteraction;
    if (route != null && _drafts[prior]?.presented != true) {
      return CreaturePresentationResult.blocked;
    }
    try {
      final state = await _api.request('state');
      if (!mounted ||
          !_current(epoch) ||
          auth != _authEpoch ||
          !identical(route, _surface) ||
          (route != null && !route.isCurrent) ||
          (route == null && ModalRoute.of(context)?.isCurrent != true)) {
        return CreaturePresentationResult.stale;
      }
      final frame = _frame(state);
      if (frame == null) return CreaturePresentationResult.blocked;
      final draft = _textDemand;
      draft.context ??= Map<String, dynamic>.from(frame);
      if (prior != null) draft.returnSessionId = prior;
      if (route != null) _dismiss();
      return _show(
        TextInteractionSheet(
          api: _api,
          draft: draft,
          frame: frame,
          access: widget.interactionAccess,
          onReturn: draft.returnSessionId == null
              ? null
              : (source) => _returnToRetained(source, draft.returnSessionId!),
          onOpen: (source) => _openTextResult(source, draft),
        ),
        _epoch,
      );
    } catch (_) {
      return CreaturePresentationResult.unavailable;
    }
  }

  Future<void> _openTextResult(
    BuildContext source,
    TextInteractionDraft draft,
  ) async {
    final route = ModalRoute.of(source),
        epoch = _epoch,
        auth = _authEpoch,
        body = draft.body;
    if (route == null ||
        !route.isCurrent ||
        !identical(route, _surface) ||
        body == null ||
        !_foreground ||
        !(widget.interactionAccess?.value ?? true)) {
      return;
    }
    final raw = await _api.request('textgen-query', {
      'commandId': body['commandId'],
    });
    if (!_current(epoch) ||
        auth != _authEpoch ||
        !route.isCurrent ||
        !identical(route, _surface) ||
        !identical(body, draft.body)) {
      return;
    }
    final record = textGenerationRecord(raw, body['commandId']);
    if (record?['status'] != 'completed' ||
        record?['result']['kind'] != 'form') {
      throw const ApiFailure(409, 'text_result_unavailable');
    }
    final state = await _api.request('state');
    if (!_current(epoch) ||
        auth != _authEpoch ||
        !route.isCurrent ||
        !identical(route, _surface)) {
      return;
    }
    if (_frame(state) == null ||
        interactionCanonical(state['context']) !=
            interactionCanonical(body['context'])) {
      throw const ApiFailure(409, 'text_context_changed');
    }
    draft.record = record;
    _dismiss();
    final shown = await _presentInteraction(
      record!['result']['creation']['sessionId'],
      body['context'],
      textSource: {'context': body['context'], 'record': record},
      textAuthEpoch: auth,
      returnDraft: draft.returnSessionId,
      explicitUsage: true,
    );
    if (mounted && shown != CreaturePresentationResult.shown) {
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(const SnackBar(content: Text('生成会话已不可用；原文字和旧稿仍保留在本页。')));
    }
  }

  Future<CreaturePresentationResult> _pauseInteractionForHearing(
    String sessionId,
  ) async {
    final route = _surface, draft = _drafts[sessionId], epoch = _epoch;
    if (!_foreground ||
        !_interactionVisible ||
        _visibleInteraction != sessionId ||
        route == null ||
        !route.isCurrent ||
        draft?.presented != true) {
      return CreaturePresentationResult.blocked;
    }
    try {
      final state = await _api.request('state');
      if (!_current(epoch) || !identical(route, _surface) || !route.isCurrent) {
        return CreaturePresentationResult.stale;
      }
      final frame = _frame(state),
          c = registeredCreature(state, state['activeCreatureId']);
      if (frame == null || !registeredSenseAllowed(c, 'hearing')) {
        return CreaturePresentationResult.blocked;
      }
      // No close/edit/save. Disposal leaves values and in-flight command intact.
      _dismiss();
      return await _present(
        CreatureIntent.hearing,
        frame,
        returnDraft: sessionId,
      );
    } catch (_) {
      return CreaturePresentationResult.unavailable;
    }
  }

  Future<void> _returnToRetained(BuildContext source, String sessionId) async {
    final route = ModalRoute.of(source);
    if (!_foreground ||
        route == null ||
        !route.isCurrent ||
        !identical(route, _surface) ||
        _drafts[sessionId]?.presented != true) {
      return;
    }
    _dismiss();
    await _presentInteraction(sessionId, null, explicitUsage: true);
  }

  bool _hearingSourceAllowed(Map<String, dynamic> state, Map source) {
    final frame = _frame(state),
        c = registeredCreature(state, state['activeCreatureId']);
    return frame != null &&
        source['expiresAt'] is int &&
        source['expiresAt'] > DateTime.now().millisecondsSinceEpoch &&
        interactionCanonical(frame) == interactionCanonical(source['frame']) &&
        registeredSenseAllowed(c, 'hearing') &&
        c?['generation'] == source['metadata']?['creatureGeneration'];
  }

  Future<CreaturePresentationResult> _presentInteraction(
    String sessionId,
    Map<String, dynamic>? expected, {
    Map<String, dynamic>? hearingSource,
    Map<String, dynamic>? textSource,
    int? textAuthEpoch,
    String? returnDraft,
    bool explicitUsage = false,
    bool usageDiscovery = false,
  }) async {
    if (!_foreground || _surface != null || !interactionId(sessionId)) {
      return CreaturePresentationResult.blocked;
    }
    final epoch = ++_epoch;
    final sessions = widget.controller?._interactions ?? _localInteractions;
    final existing = sessions[sessionId]?.presented == true
        ? sessions[sessionId]
        : null;
    CreaturePresentationResult history() {
      if (!_current(epoch)) return CreaturePresentationResult.stale;
      if (hearingSource != null || existing?.view == null) {
        return CreaturePresentationResult.blocked;
      }
      _interactionVisible = true;
      _visibleInteraction = sessionId;
      return _show(
        TemporaryInteractionSheet(
          onTextDemand: widget.enableTextInteraction
              ? () async {
                  await _presentTextDemand();
                }
              : null,
          access: widget.interactionAccess,
          api: _api,
          sessionId: sessionId,
          contextBinding: Map<String, dynamic>.from(existing!.view!['context']),
          recovery: existing,
          recoveryOnly: true,
          onReturnToDraft: existing.returnSessionId == null
              ? null
              : (source) =>
                    _returnToRetained(source, existing.returnSessionId!),
          onPauseForHearing: () async {
            await _pauseInteractionForHearing(sessionId);
          },
        ),
        epoch,
      );
    }

    if (existing?.pending != null || existing?.closed == true) return history();
    try {
      final state = await _api.request('state');
      if (!_current(epoch)) return CreaturePresentationResult.stale;
      if (hearingSource != null &&
          !_hearingSourceAllowed(state, hearingSource)) {
        return CreaturePresentationResult.blocked;
      }
      if (existing?.view != null && !_resumeAllowed(state, existing!)) {
        existing.resumeReadOnly = true;
        return history();
      }
      final frame = _frame(state);
      if (frame == null ||
          (expected != null &&
              interactionCanonical(expected) != interactionCanonical(frame))) {
        return history();
      }
      if (existing?.view == null && !usageDiscovery && textSource == null) {
        final pointer = await _api.interactionCurrent();
        if (!_current(epoch)) return CreaturePresentationResult.stale;
        if (pointer == null ||
            pointer['sessionId'] != sessionId ||
            interactionCanonical(pointer['context']) !=
                interactionCanonical(frame)) {
          return history();
        }
      }
      final raw = await _api.request('interaction-read', {
        'sessionId': sessionId,
      });
      if (!_current(epoch)) return CreaturePresentationResult.stale;
      final view = validatedInteractionSession(
        raw,
        sessionId: sessionId,
        context: frame,
      );
      if (view == null) {
        if (existing != null) existing.resumeReadOnly = true;
        return history();
      }
      if (existing?.view != null) {
        final latest = await _api.request('state');
        if (!_current(epoch)) return CreaturePresentationResult.stale;
        if (!_resumeAllowed(latest, existing!) ||
            interactionCanonical(view) != interactionCanonical(existing.view)) {
          existing.resumeReadOnly = true;
          return history();
        }
      }
      if (usageDiscovery) {
        final latest = await _api.request('state');
        if (!_current(epoch)) return CreaturePresentationResult.stale;
        if (_frame(latest) == null ||
            interactionCanonical(latest['context']) !=
                interactionCanonical(view['context'])) {
          return CreaturePresentationResult.blocked;
        }
      }
      if (hearingSource != null) {
        final latest = await _api.request('state');
        if (!_current(epoch)) return CreaturePresentationResult.stale;
        if (!_hearingSourceAllowed(latest, hearingSource)) {
          return CreaturePresentationResult.blocked;
        }
      }
      if (textSource != null) {
        final latest = await _api.request('state');
        if (!_current(epoch) ||
            textAuthEpoch != _authEpoch ||
            !(widget.interactionAccess?.value ?? true) ||
            _frame(latest) == null ||
            interactionCanonical(latest['context']) !=
                interactionCanonical(textSource['context']) ||
            !textFormMatches(
              view,
              textSource['record'],
              textSource['context'],
            )) {
          return CreaturePresentationResult.blocked;
        }
      }
      final recovery = sessions.putIfAbsent(
        sessionId,
        () => InteractionDraftState(),
      );
      if (!recovery.presented || recovery.view == null) {
        recovery.view = view;
        recovery.values = Map<String, dynamic>.from(view['draft']['values']);
      }
      // Same authoritative snapshot + final context check can lift a transient
      // read failure, without discarding dirty values or a permanent read-only latch.
      if (existing != null && recovery.stale) {
        recovery.stale = false;
        recovery.message = null;
      }
      recovery.returnSessionId ??= returnDraft;
      _interactionVisible = true;
      _visibleInteraction = sessionId;
      final result = _show(
        TemporaryInteractionSheet(
          onTextDemand: widget.enableTextInteraction
              ? () async {
                  await _presentTextDemand();
                }
              : null,
          access: widget.interactionAccess,
          api: _api,
          sessionId: sessionId,
          contextBinding: frame,
          recovery: recovery,
          onReturnToDraft: recovery.returnSessionId == null
              ? null
              : (source) =>
                    _returnToRetained(source, recovery.returnSessionId!),
          onPauseForHearing: () async {
            await _pauseInteractionForHearing(sessionId);
          },
        ),
        epoch,
      );
      if (result == CreaturePresentationResult.shown) {
        recovery.presented = true;
        if (explicitUsage && _surface != null) {
          _reportPresentation(view, _surface!, epoch);
        }
      }
      return result;
    } catch (error) {
      if (existing != null &&
          error is ApiFailure &&
          [
            'interaction_session_expired',
            'interaction_session_closed',
            'interaction_context_changed',
            'unauthenticated',
            'interaction_session_not_found',
          ].contains(error.code)) {
        existing.resumeReadOnly = true;
      }
      return existing?.view != null
          ? history()
          : (_current(epoch)
                ? CreaturePresentationResult.unavailable
                : CreaturePresentationResult.stale);
    }
  }

  Future<CreaturePresentationResult> _present(
    CreatureIntent intent,
    Map<String, dynamic>? expected, {
    String? returnDraft,
  }) async {
    if (_interactionVisible) return CreaturePresentationResult.blocked;
    _dismiss();
    final epoch = _epoch;
    if (!_foreground) return CreaturePresentationResult.stale;
    try {
      var state = await _api.request('state');
      if (!_current(epoch)) return CreaturePresentationResult.stale;
      final frame = _frame(state);
      if (frame == null) return CreaturePresentationResult.blocked;
      if (expected != null &&
          (expected.length != 2 ||
              expected['creatureId'] != frame['creatureId'] ||
              expected['sceneRevision'] != frame['sceneRevision'])) {
        return CreaturePresentationResult.stale;
      }
      final creature = registeredCreature(state, frame['creatureId'])!;
      _captions.bind(state);
      Widget body;
      String title;
      switch (intent) {
        case CreatureIntent.textInput:
          if (trustedTextEntry(state) == null) {
            state = await _api.request('text-entry', {
              'context': frame,
              'visible': true,
            });
          }
          if (!_current(epoch)) return CreaturePresentationResult.stale;
          final entry = trustedTextEntry(state);
          if (entry == null) return CreaturePresentationResult.blocked;
          title = '文字输入';
          body = SingleChildScrollView(
            padding: const EdgeInsets.all(16),
            child: SceneTextEntry(
              api: _api,
              frame: entry,
              onState: (next) {
                if (_current(epoch) && trustedTextEntry(next) == null) {
                  _dismiss();
                }
              },
            ),
          );
        case CreatureIntent.account:
          if (validatedChoiceForm(
                    state['choiceForms']?['account'],
                    state,
                    'synthetic-account.v1',
                  ) ==
                  null ||
              state['activeCreatureId'] != 'work') {
            return CreaturePresentationResult.blocked;
          }
          title = '合成账户表单';
          body = SceneExperiment(client: _client, workbenchOnly: true);
        case CreatureIntent.focus:
          if (state['primaryCreatureId'] != frame['creatureId']) {
            return CreaturePresentationResult.blocked;
          }
          title = '一起专注';
          body = FocusSheet(client: _client, recovery: _focusRecovery);
        case CreatureIntent.handoff:
          title = '主生物协作';
          body = HandoffSheet(client: _client);
        case CreatureIntent.market:
          title = '生物市场';
          body = CreatureMarketSheet(client: _client);
        case CreatureIntent.companions:
          title = '我的生物';
          body = CreatureRegistrySheet(
            selectionRecovery: _registryRecovery,
            client: _client,
            canSelectCreature: () =>
                !_hasRetainedWork && _selectionPending == null,
          );
        case CreatureIntent.hearing:
        case CreatureIntent.vision:
          final modality = intent == CreatureIntent.hearing
              ? 'hearing'
              : 'vision';
          if (!registeredSenseAllowed(creature, modality)) {
            return CreaturePresentationResult.blocked;
          }
          // The requested sheet retains OS permission and explicit send/confirm
          // controls. Merely displaying it never enables a device sensor.
          return _show(
            CreatureSenseSheet(
              creatureId: frame['creatureId'],
              creatureName: creature['name'],
              modality: modality,
              client: _client,
              capture: widget.senseCaptureFactory?.call(),
              captions: _captions,
              enableInteractionGeneration: widget.enableHearingInteraction,
              onReturnToDraft: returnDraft == null
                  ? null
                  : (source) => _returnToRetained(source, returnDraft),
              onOpenInteraction: (source, session, binding, event) async {
                final route = ModalRoute.of(source);
                if (!_foreground ||
                    route == null ||
                    !route.isCurrent ||
                    !identical(route, _surface)) {
                  return false;
                }
                // Only the explicitly confirmed originating hearing route.
                _dismiss();
                return await _presentInteraction(
                      session,
                      binding,
                      hearingSource: event,
                      explicitUsage: true,
                      returnDraft: returnDraft,
                    ) ==
                    CreaturePresentationResult.shown;
              },
            ),
            epoch,
          );
      }
      return _show(
        Scaffold(
          appBar: AppBar(
            title: Text(title),
            leading: IconButton(
              key: const Key('generated-close'),
              tooltip: '关闭当前场景',
              icon: const Icon(Icons.close),
              onPressed: _dismiss,
            ),
          ),
          body: SafeArea(child: body),
        ),
        epoch,
      );
    } catch (_) {
      return _current(epoch)
          ? CreaturePresentationResult.unavailable
          : CreaturePresentationResult.stale;
    }
  }

  CreaturePresentationResult _show(Widget surface, int epoch) {
    if (!_current(epoch) || ModalRoute.of(context)?.isCurrent == false) {
      if (_surface == null) {
        _interactionVisible = false;
        _visibleInteraction = null;
      }
      return CreaturePresentationResult.stale;
    }
    final route = MaterialPageRoute<void>(builder: (_) => surface);
    _surface = route;
    Navigator.of(context).push(route).then((_) {
      if (identical(_surface, route)) {
        _surface = null;
        _interactionVisible = false;
        _visibleInteraction = null;
        _epoch++;
        unawaited(_refreshUsage());
      }
    });
    return CreaturePresentationResult.shown;
  }

  @override
  void dispose() {
    _epoch++;
    _usageEpoch++;
    _unbind(widget.controller);
    _captions.dispose();
    widget.interactionAccess?.removeListener(_authenticationChanged);
    WidgetsBinding.instance.removeObserver(this);
    if (widget.client == null) _client.close();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    backgroundColor: const Color(0xfff7f6f2),
    bottomNavigationBar: _frequent.isEmpty && _selectionPending == null
        ? null
        : SafeArea(
            child: Padding(
              padding: const EdgeInsets.only(bottom: 8),
              child: Row(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  for (final item in _frequent)
                    Flexible(
                      child: TextButton(
                        key: ValueKey(
                          'frequent-${item['kind']}-${item['targetId']}',
                        ),
                        onPressed: _usageBusy || _selectionPending != null
                            ? null
                            : () => _openFrequent(item),
                        child: Text(
                          '${item['kind'] == 'interaction-session' ? '临时 · ' : ''}${item['label']}',
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: const TextStyle(fontSize: 12),
                        ),
                      ),
                    ),
                  if (_selectionUntracked)
                    IconButton(
                      key: const Key('usage-finish-unknown'),
                      tooltip: _usageMessage,
                      onPressed: _usageBusy
                          ? null
                          : () => setState(() {
                              _selectionPending = null;
                              _selectionUntracked = false;
                            }),
                      icon: const Icon(Icons.done, size: 18),
                    ),
                  if (_selectionPending != null)
                    IconButton(
                      key: const Key('usage-query'),
                      tooltip: _usageMessage ?? '核对原选择结果（不重发）',
                      onPressed: _usageBusy ? null : _querySelection,
                      icon: const Icon(Icons.sync, size: 18),
                    ),
                ],
              ),
            ),
          ),
    body: SafeArea(
      child: Center(
        child: SingleChildScrollView(
          child: AnimatedBuilder(
            animation: _captions,
            builder: (_, _) => Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                StandInAvatar(speaking: _captions.speaking),
                if (_captions.visible)
                  Padding(
                    padding: const EdgeInsets.symmetric(horizontal: 24),
                    child: MediaCaptionView(captions: _captions),
                  ),
              ],
            ),
          ),
        ),
      ),
    ),
  );
}
