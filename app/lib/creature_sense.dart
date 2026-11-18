import 'dart:async';
import 'dart:convert';

import 'package:material_ui/material_ui.dart';
import 'package:http/http.dart' as http;

import 'api.dart';
import 'hearing_interaction.dart';
import 'media_captions.dart';
import 'creature_registry.dart';
import 'perception_capture.dart';
import 'scene_experiment.dart';
import 'creature_voice.dart';
import 'spoken_route.dart';
import 'spoken_creature.dart';

/// One modality, one creature, one context generation. No implicit scene action.
class CreatureSenseSheet extends StatefulWidget {
  const CreatureSenseSheet({
    super.key,
    required this.creatureId,
    required this.creatureName,
    required this.modality,
    this.client,
    this.capture,
    this.voicePlayer,
    this.captions,
    this.enableInteractionGeneration = false,
    this.onOpenInteraction,
    this.onReturnToDraft,
  });
  final String creatureId, creatureName, modality;
  final http.Client? client;
  final SenseCapture? capture;
  final CreatureVoicePlayer? voicePlayer;
  final BoundMediaCaptions? captions;
  final bool enableInteractionGeneration;
  final Future<void> Function(BuildContext)? onReturnToDraft;
  final Future<bool> Function(
    BuildContext,
    String,
    Map<String, dynamic>,
    Map<String, dynamic>,
  )?
  onOpenInteraction;
  @override
  State<CreatureSenseSheet> createState() => _CreatureSenseSheetState();
}

class _CreatureSenseSheetState extends State<CreatureSenseSheet>
    with WidgetsBindingObserver {
  late final http.Client _client;
  late final SenseCapture _capture;
  late final CreatureVoicePlayer _voice;
  bool _voiceAvailable = false, _voiceActive = false;
  int _voiceEpoch = 0;
  String? _voiceMessage;
  int? _captionRound;
  StreamSubscription<VoicePlaybackPhase>? _playback;
  String? _captionVoiceEvent;
  bool _audioBound = false;
  late final SceneExperimentApi _api;
  Map<String, dynamic>? _context, _event, _result, _reply;
  Completer<void>? _generationCancel;
  Timer? _generationDeadline;
  bool _generationBusy = false, _generationAttempted = false;
  Map<String, dynamic>? _generated;
  String? _generationMessage;
  void _cancelGeneration() {
    final cancel = _generationCancel;
    if (cancel != null && !cancel.isCompleted) cancel.complete();
    _generationCancel = null;
    _generated = null;
    _generationBusy = false;
  }

  bool get _generationEligible =>
      widget.enableInteractionGeneration &&
      _hearing &&
      !_locked &&
      !_recording &&
      _pending == null &&
      _event?['status'] == 'observation' &&
      _event?['metadata']?['realProcessing'] == true &&
      _result?['realProcessing'] == true &&
      _event?['metadata']?['candidate'] == null &&
      _event?['metadata']?['routeProposal'] == null &&
      _event?['metadata']?['creatureProposal'] == null &&
      _event?['expiresAt'] is int &&
      _event!['expiresAt'] > DateTime.now().millisecondsSinceEpoch;
  Future<bool> _generationAuthority(Map event, int epoch) async {
    Map<String, dynamic> state;
    try {
      state = await _api.request('state');
    } catch (_) {
      if (mounted && epoch == _epoch) _suspend();
      return false;
    }
    if (!mounted || epoch != _epoch) return false;
    final c = registeredCreature(state, widget.creatureId);
    final valid =
        !_locked &&
        _event?['eventId'] == event['eventId'] &&
        event['expiresAt'] > DateTime.now().millisecondsSinceEpoch &&
        ModalRoute.of(context)?.isCurrent == true &&
        _matching(state['context']) &&
        state['activeCreatureId'] == widget.creatureId &&
        registeredSenseAllowed(c, 'hearing') &&
        c?['generation'] == event['metadata']['creatureGeneration'];
    if (!valid) {
      _suspend();
      return false;
    }
    widget.captions?.bind(state);
    return true;
  }

  Future<void> _generateInteraction() async {
    if (!_generationEligible || _generationAttempted || _busy) return;
    final event = Map<String, dynamic>.from(_event!);
    final epoch = _epoch, cancel = Completer<void>();
    _generationCancel = cancel;
    setState(() {
      _generationAttempted = true;
      _voiceAvailable = false;
      _generationBusy = true;
      _generationMessage = '正在尝试生成；不会自动重试。';
    });
    try {
      await _stopVoice(ensureStopped: true);
      if (cancel.isCompleted || !await _generationAuthority(event, epoch)) {
        return;
      }
      if (cancel.isCompleted) return;
      setState(() => _voiceAvailable = false);
      final r = await generateHearingInteraction(_client, {
        'eventId': event['eventId'],
        'context': event['frame'],
      }, cancel.future);
      if (cancel.isCompleted || !await _generationAuthority(event, epoch)) {
        return;
      }
      if (cancel.isCompleted) return;
      setState(() {
        _generated = r;
        _generationMessage = r['replayed'] == true
            ? '仅查到历史创建事实，不自动重开。'
            : r['kind'] == 'form'
            ? '已创建空的临时表单，尚未保存。'
            : '模型建议（未朗读、未执行）：${r['proposal'][r['kind'] == 'clarify' ? 'question' : 'reason']}';
      });
    } catch (error) {
      if (mounted &&
          epoch == _epoch &&
          !cancel.isCompleted &&
          error is ApiFailure &&
          [
            'authorization_changed',
            'creature_sensory_authority_changed',
            'sensory_context_changed',
            'sensory_event_expired',
            'interaction_source_unavailable',
            'interaction_generation_cancelled',
            'subject_not_active',
            'outside_sensory_boundary',
            'sensory_subject_unmapped',
            'subject_not_found',
            'perception_not_found',
            'sensory_event_not_found',
            'perception_not_completed',
          ].contains(error.code)) {
        _suspend();
        return;
      }
      if (mounted && epoch == _epoch && !cancel.isCompleted) {
        setState(() {
          _generationMessage =
              error is ApiFailure &&
                  error.code == 'interaction_planner_unavailable'
              ? '宿主未启用模型生成。未生成界面。'
              : '结果待核查；不会重发生成请求或恢复权限。';
        });
      }
    } finally {
      if (mounted && epoch == _epoch && !cancel.isCompleted) {
        setState(() {
          _generationBusy = false;
          if (_generated == null && _generationMessage == '正在尝试生成；不会自动重试。') {
            _generationMessage = '来源已失效，未呈现结果。';
          }
        });
      }
    }
  }

  Future<void> _openGenerated() async {
    final r = _generated, event = _event, epoch = _epoch;
    if (_busy ||
        _generationBusy ||
        r == null ||
        event == null ||
        r['kind'] != 'form' ||
        r['replayed'] == true) {
      return;
    }
    setState(() => _generationBusy = true);
    try {
      await _stopVoice(ensureStopped: true);
      if (!await _generationAuthority(event, epoch) ||
          !identical(_generated, r)) {
        return;
      }
      if (!mounted) return;
      await widget.onOpenInteraction?.call(
        context,
        r['creation']['ack']['sessionId'],
        Map<String, dynamic>.from(event['frame']),
        Map<String, dynamic>.from(event),
      );
    } catch (_) {
      if (mounted && epoch == _epoch) {
        setState(() => _generationMessage = '当前状态未确认，未打开表单。');
      }
    } finally {
      if (mounted && epoch == _epoch) setState(() => _generationBusy = false);
    }
  }

  bool _replyRejected = false, _routeApplied = false;
  bool _sendOnStop = false,
      _routeRequestPending = false,
      _routeRecovery = false;
  CapturedSense? _pending;
  bool _busy = false,
      _recording = false,
      _available = false,
      _locked = false,
      _permissionTransition = false,
      _applied = false;
  int _epoch = 0;
  Timer? _limit;
  String? _error;
  String get _name => widget.creatureName;
  bool get _hearing => widget.modality == 'hearing';
  static const proposals = {
    'work-context': '切换到内置小谨的工作情境',
    'personal-context': '切换到内置小伴的个人情境',
    'text-entry-request': '为当前生物打开按需文字入口（不执行业务）',
    'account-request': '进入工作情境并显示合成账户表单（不开户、不提交）',
  };
  Map<String, dynamic>? get _creatureProposal => _event == null
      ? null
      : validatedSpokenCreature(
          _event!['metadata']?['creatureProposal'],
          _event!,
          widget.modality,
        );
  String? get _candidate {
    final value = _event?['metadata']?['candidate'];
    return _hearing &&
            _event?['modality'] == 'hearing' &&
            _event?['status'] == 'awaiting_confirmation' &&
            _result?['realProcessing'] == true &&
            _reply != null &&
            _reply!['suggestedScene'] == value &&
            (proposals.containsKey(value) ||
                (value == 'creature-request' &&
                    _creatureProposal?['status'] == 'ready')) &&
            !_locked
        ? value as String
        : null;
  }

  bool _matching(dynamic frame) =>
      frame is Map &&
      _context != null &&
      frame['creatureId'] == widget.creatureId &&
      frame['creatureId'] == _context!['creatureId'] &&
      frame['sceneRevision'] == _context!['sceneRevision'];
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _client = widget.client ?? http.Client();
    _capture = widget.capture ?? PlatformSenseCapture();
    _voice = widget.voicePlayer ?? GenerationVoicePlayer();
    if (_voice is ObservableVoicePlayback) {
      _playback = (_voice as ObservableVoicePlayback).playbackStates.listen((
        phase,
      ) {
        final eventId = _captionVoiceEvent;
        if (!mounted || !_audioBound || eventId == null) return;
        widget.captions?.voice(_captionRound, eventId, phase.name);
      });
    }
    _api = SceneExperimentApi(_client);
    _run(_connect);
  }

  Future<void> _run(Future<void> Function() action) async {
    if (_busy) return;
    final epoch = _epoch;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await action();
    } catch (error) {
      if (mounted && epoch == _epoch) {
        if (error is ApiFailure &&
            [
              'sensory_context_changed',
              'authorization_changed',
              'creature_sensory_authority_changed',
              'sensory_event_expired',
            ].contains(error.code)) {
          widget.captions?.clear();
        } else {
          widget.captions?.fail(_captionRound);
        }
        _limit?.cancel();
        _audioBound = false;
        _captionVoiceEvent = null;
        _voiceEpoch++;
        if (mounted && epoch == _epoch) {
          setState(() {
            _error = error is ApiFailure
                ? error.code
                : '采集或处理结果未确认，请检查设备权限和本机服务。媒体不会自动重发。';
            _pending = null;
            _event = null;
            _result = null;
            _reply = null;
            _replyRejected = false;
            _voiceActive = false;
            _voiceAvailable = false;
            _voiceMessage = null;
            _recording = false;
            _sendOnStop = false;
            if (error is ApiFailure) _locked = true;
          });
        }
        // Hardware cleanup must not delay withdrawal of visible data/actions.
        // Keep _busy latched until cleanup settles, so a late cancel/stop
        // cannot race a newly started media round after a generic error.
        await Future.wait([
          _voice.stop().catchError((_) {}),
          _capture.cancel().catchError((_) {}),
        ]);
      }
    } finally {
      if (mounted && epoch == _epoch) setState(() => _busy = false);
    }
  }

  Future<void> _connect() async {
    if (widget.creatureId.isEmpty ||
        widget.creatureId.length > 128 ||
        widget.creatureName.trim().isEmpty ||
        widget.creatureName.length > 100 ||
        !['hearing', 'vision'].contains(widget.modality)) {
      throw const ApiFailure(0, 'invalid_bound_sense');
    }
    final epoch = _epoch;
    final data = await _api.request('sense-capabilities');
    if (!mounted || epoch != _epoch) return;
    final context = data['context'];
    if (context is! Map ||
        context['creatureId'] != widget.creatureId ||
        context['sceneRevision'] is! int) {
      throw const ApiFailure(409, 'sensory_context_changed');
    }
    setState(() {
      _context = {
        'creatureId': context['creatureId'],
        'sceneRevision': context['sceneRevision'],
      };
      _available = data['capabilities']?[widget.modality]?['available'] == true;
    });
  }

  Future<void> _begin() async {
    if (!_available || _locked || _context == null || _routeRequestPending) {
      return;
    }
    _cancelGeneration();
    _generationDeadline?.cancel();
    _generationAttempted = false;
    _generationMessage = null;
    final epoch = _epoch;
    await _stopVoice(ensureStopped: true);
    if (!mounted || epoch != _epoch || _locked) return;
    widget.captions?.clear();
    setState(() {
      _pending = null;
      _result = null;
      _reply = null;
      _replyRejected = false;
      _event = null;
    });
    _permissionTransition = true;
    try {
      if (_hearing) {
        await _capture.startHearing();
        if (!mounted || epoch != _epoch) {
          await _capture.cancel();
          return;
        }
        setState(() => _recording = true);
        _limit = Timer(const Duration(seconds: 14), () {
          if (mounted && _recording && !_busy) {
            unawaited(_run(() => _stop(allowAutoSend: false)));
          }
        });
      } else {
        final media = await _capture.photograph(context);
        if (!mounted || epoch != _epoch) return;
        _accept(media);
      }
    } finally {
      _permissionTransition = false;
    }
  }

  void _accept(CapturedSense? media) {
    if (media == null) return;
    if (media.bytes.length > 4 * 1024 * 1024) {
      throw const ApiFailure(413, 'media_too_large');
    }
    setState(() => _pending = media);
  }

  Future<void> _stop({bool allowAutoSend = true}) async {
    _limit?.cancel();
    final epoch = _epoch;
    final media = await _capture.stopHearing();
    if (!mounted || epoch != _epoch) return;
    setState(() => _recording = false);
    _accept(media);
    if (_sendOnStop && allowAutoSend && _pending != null) await _send();
  }

  Future<void> _cancelRound() async {
    _limit?.cancel();
    await _capture.cancel();
    if (mounted) {
      setState(() {
        _recording = false;
        _pending = null;
      });
    }
  }

  Future<void> _send() async {
    final media = _pending, frame = _context;
    if (media == null || frame == null || _locked) return;
    final epoch = _epoch;
    setState(() => _pending = null);
    _captionRound = widget.captions?.begin(frame, widget.modality);
    final data = await _api.request('sense', {
      'context': Map.of(frame),
      'modality': widget.modality,
      'media': {
        'mimeType': media.mimeType,
        'base64': base64Encode(media.bytes),
      },
    });
    if (!mounted || epoch != _epoch) return;
    final event = data['event'], result = data['result'];
    if (event is! Map ||
        !_matching(event['frame']) ||
        event['modality'] != widget.modality ||
        event['eventId'] is! String ||
        event['metadata'] is! Map ||
        ![
          'observation',
          'awaiting_confirmation',
          'awaiting_route_confirmation',
        ].contains(event['status']) ||
        result is! Map ||
        result['text'] is! String) {
      throw const ApiFailure(409, 'sensory_response_mismatch');
    }
    final reply = validatedCreatureReply(
      data['companionReply'],
      event,
      widget.modality,
    );
    // Authorization is a sheet boundary, never an optional caption feature.
    late final Map<String, dynamic> currentState;
    try {
      currentState = await _api.request('state');
    } catch (_) {
      throw const ApiFailure(409, 'sensory_authority_unconfirmed');
    }
    if (!mounted || epoch != _epoch) return;
    // Record known withdrawal/new generations even when the sheet rejects it.
    widget.captions?.bind(currentState);
    final creature = registeredCreature(currentState, widget.creatureId);
    if (!_matching(currentState['context']) ||
        currentState['activeCreatureId'] != widget.creatureId ||
        !registeredSenseAllowed(creature, widget.modality) ||
        event['metadata']['creatureGeneration'] is! int ||
        event['metadata']['creatureGeneration'] != creature?['generation'] ||
        event['expiresAt'] is! int ||
        event['expiresAt'] <= DateTime.now().millisecondsSinceEpoch) {
      throw const ApiFailure(409, 'creature_sensory_authority_changed');
    }
    if (widget.captions != null) {
      if (!widget.captions!.accept(_captionRound, data, reply)) {
        throw const ApiFailure(409, 'sensory_response_mismatch');
      }
    }
    setState(() {
      _voiceAvailable = data['voiceAvailable'] == true;
      _voiceMessage = null;
      _reply = reply;
      _replyRejected = reply == null;
      _event = Map<String, dynamic>.from(event);
      _result = Map<String, dynamic>.from(result);
    });
    if (widget.enableInteractionGeneration && _hearing) {
      _generationDeadline?.cancel();
      _generationDeadline = Timer(
        Duration(
          milliseconds:
              event['expiresAt'] - DateTime.now().millisecondsSinceEpoch,
        ),
        () {
          if (mounted && _event?['eventId'] == event['eventId']) _suspend();
        },
      );
    }
  }

  Future<void> _confirm() async {
    widget.captions?.clear();
    final event = _event, candidate = _candidate;
    if (event == null || candidate == null || !_matching(event['frame'])) {
      return;
    }
    final epoch = _epoch;
    await _stopVoice();
    if (!mounted || epoch != _epoch || _locked) return;
    final data = await _api.request('sense-confirm', {
      'eventId': event['eventId'],
      'context': event['frame'],
      'expectedCandidate': candidate,
      'confirmation': 'apply-scene-proposal',
      if (candidate == 'creature-request')
        'expectedCreatureProposal': _creatureProposal,
    });
    if (!mounted || epoch != _epoch) return;
    if (data['state'] is! Map ||
        data['state']['mode'] != 'deterministic-synthetic') {
      throw const ApiFailure(502, 'invalid_scene_confirmation');
    }
    // Only leave the route that initiated this confirmation. A newer route must
    // not be popped by a late result, even if this sheet is still mounted below it.
    if (candidate == 'creature-request' &&
        ModalRoute.of(context)?.isCurrent == true &&
        Navigator.of(context).canPop()) {
      Navigator.of(context).pop();
      return;
    }
    setState(() {
      _applied = true;
      _locked = true;
      _event = null;
    });
  }

  Future<void> _stopVoice({bool ensureStopped = false}) async {
    _voiceEpoch++;
    final id = _captionVoiceEvent;
    if (id != null) widget.captions?.voice(_captionRound, id, 'waiting');
    _audioBound = false;
    _captionVoiceEvent = null;
    if (mounted) {
      setState(() {
        _voiceActive = false;
        _voiceMessage = null;
      });
    }
    try {
      await _voice.stop();
      if (id != null) widget.captions?.voice(_captionRound, id, 'stopped');
    } catch (_) {
      if (mounted) setState(() => _voiceMessage = '停止播放未确认，请关闭此页面。');
      if (id != null) widget.captions?.voice(_captionRound, id, 'failed');
      if (ensureStopped) throw StateError('voice_stop_unconfirmed');
    }
  }

  Future<void> _speak() async {
    final event = _event, frame = _context;
    if (_reply == null ||
        !_voiceAvailable ||
        _locked ||
        _applied ||
        event == null ||
        frame == null ||
        !_matching(event['frame'])) {
      return;
    }
    final epoch = _epoch, voiceEpoch = ++_voiceEpoch;
    _audioBound = false;
    _captionVoiceEvent = event['eventId'];
    widget.captions?.voice(_captionRound, event['eventId'], 'preparing');
    setState(() {
      _voiceActive = true;
      _voiceMessage = '正在本机合成语音…';
    });
    try {
      await _voice.stop();
      if (!mounted || epoch != _epoch || voiceEpoch != _voiceEpoch) return;
      final response = await _api.request('speak', {
        'eventId': event['eventId'],
        'context': Map.of(frame),
      });
      if (!mounted || epoch != _epoch || voiceEpoch != _voiceEpoch) return;
      final audio = validatedCreatureVoice(response, event, frame);
      if (audio == null) throw const ApiFailure(502, 'invalid_creature_voice');
      _audioBound = true;
      await _voice.play(audio);
      if (!mounted || epoch != _epoch || voiceEpoch != _voiceEpoch) return;
      setState(() => _voiceMessage = '语音已交给本机播放器；不会自动重播。');
    } catch (error) {
      if (mounted && epoch == _epoch && voiceEpoch == _voiceEpoch) {
        await _voice.stop().catchError((_) {});
        if (!mounted || epoch != _epoch || voiceEpoch != _voiceEpoch) return;
        _audioBound = false;
        widget.captions?.voice(_captionRound, event['eventId'], 'failed');
        setState(() {
          _voiceActive = false;
          _voiceAvailable = false;
          _voiceMessage =
              '合成或播放未确认，不自动重试。${error is ApiFailure ? error.code : '请检查设备音频支持或浏览器播放限制。'}';
          if (error is ApiFailure &&
              [
                'sensory_context_changed',
                'authorization_changed',
                'creature_sensory_authority_changed',
                'sensory_event_expired',
              ].contains(error.code)) {
            _locked = true;
            widget.captions?.clear();
          }
        });
      }
    }
  }

  void _suspend() {
    _generationDeadline?.cancel();
    _cancelGeneration();
    _generationMessage = null;
    widget.captions?.clear();
    _audioBound = false;
    _captionVoiceEvent = null;
    _epoch++;
    _voiceEpoch++;
    unawaited(_voice.stop().catchError((_) {}));
    _limit?.cancel();
    unawaited(_capture.cancel().catchError((_) {}));
    if (mounted) {
      setState(() {
        _voiceActive = false;
        _voiceMessage = null;
        _pending = null;
        if (_routeRequestPending) _routeRecovery = true;
        if (!_routeRequestPending && !_routeRecovery) {
          _event = null;
        } else if (_event != null) {
          _event = {
            for (final key in ['eventId', 'frame', 'modality', 'status'])
              key: _event![key],
            'metadata': {
              'candidate': null,
              'routeProposal': _event!['metadata']['routeProposal'],
            },
          };
        }
        _result = null;
        _reply = null;
        _replyRejected = false;
        _recording = false;
        _sendOnStop = false;
        _busy = false;
        _locked = true;
        _error = '已停止采集并清除待发媒体。请关闭后重新进入，核对当前生物。';
      });
    }
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.paused ||
        state == AppLifecycleState.detached ||
        state == AppLifecycleState.hidden ||
        (state == AppLifecycleState.inactive && !_permissionTransition)) {
      _suspend();
    }
  }

  @override
  void dispose() {
    _generationDeadline?.cancel();
    _cancelGeneration();
    final spokenEvent = _captionVoiceEvent;
    if (spokenEvent != null) {
      final captions = widget.captions, round = _captionRound;
      scheduleMicrotask(() => captions?.voice(round, spokenEvent, 'stopped'));
    }
    _audioBound = false;
    unawaited(_playback?.cancel());
    WidgetsBinding.instance.removeObserver(this);
    _epoch++;
    _limit?.cancel();
    _voiceEpoch++;
    unawaited(_voice.dispose().catchError((_) {}));
    unawaited(_capture.dispose().catchError((_) {}));
    if (widget.client == null) _client.close();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => PopScope(
    onPopInvokedWithResult: (didPop, result) {
      if (didPop) _suspend();
    },
    child: Scaffold(
      appBar: AppBar(title: Text('$_name · ${_hearing ? '听觉' : '视觉'}')),
      body: SingleChildScrollView(
        padding: const EdgeInsets.all(20),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(
              '当前绑定：$_name（${widget.creatureId}）',
              key: const Key('bound-creature'),
            ),
            const Text(
              '仅连接本机处理服务，不是多用户生产鉴权。媒体确认后发送至本机离线识别；不调用付费 LLM。原媒体处理后删除，默认转写只用于此次结果及有限候选规则；实验生成需另行明确选择。',
            ),
            Text(
              _hearing
                  ? '听觉使用离线 ASR；识别不是保证。最多录音 15 秒。'
                  : '视觉目前是 OCR 文字识别，不是完整场景理解；图片文字永远只是观察。',
            ),
            if (widget.enableInteractionGeneration && _hearing)
              const Text(
                '实验：仅明确选择后将本次识别交给宿主配置的模型；字段声明可能保存到本机，不自动保存笔记、不执行外部操作。',
              ),
            if (_hearing) ...[
              SwitchListTile(
                key: const Key('bound-send-on-stop'),
                title: const Text('轮流说话：录完即发送'),
                subtitle: const Text(
                  '自愿开启，仅本页有效。每轮仍需手动开始和结束；手动结束后立即送本机识别，不另问发送。不会常听、自动朗读或执行建议。',
                ),
                value: _sendOnStop,
                onChanged:
                    _busy ||
                        _recording ||
                        _locked ||
                        !_available ||
                        _pending != null ||
                        _candidate != null ||
                        _event?['metadata']?['routeProposal'] != null ||
                        _routeRequestPending
                    ? null
                    : (v) => setState(() => _sendOnStop = v),
              ),
              if (_sendOnStop)
                const Text('你点录音再说话。到时限只停止并保留预览，不自动发送。下一轮开始前会停止回应播放。'),
              if (_recording)
                OutlinedButton(
                  key: const Key('bound-cancel-round'),
                  onPressed: _busy ? null : () => _run(_cancelRound),
                  child: const Text('取消这轮，不发送'),
                ),
            ],
            if (widget.onReturnToDraft != null)
              TextButton(
                key: const Key('hearing-return-draft'),
                onPressed: () async {
                  final epoch = _epoch;
                  try {
                    await _stopVoice(ensureStopped: true);
                  } catch (_) {
                    return;
                  }
                  if (!mounted ||
                      !context.mounted ||
                      epoch != _epoch ||
                      ModalRoute.of(context)?.isCurrent != true) {
                    return;
                  }
                  _suspend();
                  if (!mounted || !context.mounted) return;
                  await widget.onReturnToDraft!(context);
                },
                child: const Text('结束本轮听觉，返回保留草稿'),
              ),
            if (_generationEligible && !_generationAttempted)
              OutlinedButton(
                key: const Key('hearing-generate'),
                onPressed: _busy ? null : _generateInteraction,
                child: const Text('实验：用这次识别尝试生成临时界面'),
              ),
            if (_generationMessage != null)
              Text(
                _generationMessage!,
                key: const Key('hearing-generation-status'),
              ),
            if (_generationBusy)
              TextButton(
                key: const Key('hearing-generation-cancel'),
                onPressed: () => setState(() {
                  _cancelGeneration();
                  _generationMessage = '已取消等待，结果待核查；不重发。';
                }),
                child: const Text('取消等待（不保证服务已停止）'),
              ),
            if (_generated?['kind'] == 'form' &&
                _generated?['replayed'] == false &&
                widget.onOpenInteraction != null)
              FilledButton(
                key: const Key('hearing-generation-open'),
                onPressed: _generationBusy ? null : _openGenerated,
                child: const Text('收起听觉并查看临时界面'),
              ),
            if (_busy || _generationBusy) const LinearProgressIndicator(),
            if (_error != null)
              Text('未确认：$_error。不自动重试。', key: const Key('bound-error')),
            if (_context != null && !_available)
              const Text('当前处理引擎不可用，不能启动采集。'),
            FilledButton.icon(
              key: const Key('bound-capture'),
              onPressed: _busy || _locked || !_available || _routeRequestPending
                  ? null
                  : () => _run(_recording ? _stop : _begin),
              icon: Icon(
                _recording
                    ? Icons.stop
                    : (_hearing ? Icons.mic : Icons.camera_alt),
              ),
              label: Text(
                _recording
                    ? (_sendOnStop ? '结束这轮并发送' : '停止录音')
                    : _hearing
                    ? '允许并开始本次录音'
                    : '允许并打开相机拍照',
              ),
            ),
            if (_pending != null) ...[
              if (!_hearing)
                Image.memory(
                  _pending!.bytes,
                  height: 180,
                  errorBuilder: (_, _, _) => const Text('预览不可用，建议丢弃重拍'),
                ),
              Text(
                '${_hearing ? '录音' : '图像'}已采集，${(_pending!.bytes.length / 1024).toStringAsFixed(1)} KiB，尚未发送。',
              ),
              FilledButton(
                key: const Key('bound-send'),
                onPressed: _busy ? null : () => _run(_send),
                child: Text('确认发送给$_name的本机处理服务'),
              ),
              TextButton(
                key: const Key('bound-discard'),
                onPressed: _busy ? null : () => setState(() => _pending = null),
                child: const Text('丢弃媒体，不发送'),
              ),
            ],
            if (_result != null) ...[
              Text(
                '引擎：${_result!['engine']} · 模型：${_result!['model'] ?? '服务未报告'}',
              ),
              Text(
                _result!['realProcessing'] == true
                    ? '服务报告已执行真实本地识别；未使用 LLM。'
                    : '未验证真实识别，不能当作已完成感知。',
              ),
              const Text('识别原文 · 仅作观察'),
              SelectableText(
                (_result!['text'] as String).substring(
                  0,
                  (_result!['text'] as String).length.clamp(0, 8000),
                ),
                key: const Key('bound-observation'),
              ),
              const Text('未知语句仅保留观察，不伪装通用理解。候选是有限规则推导，不是自动执行。'),
            ],
            if (_reply != null)
              Card(
                child: Padding(
                  padding: const EdgeInsets.all(16),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text('$_name的回应 · 本地规则回应，非大模型'),
                      Text(
                        _reply!['text'] as String,
                        key: const Key('bound-creature-reply'),
                      ),
                      const Text('不会自动执行或自动扬声。'),
                    ],
                  ),
                ),
              ),
            if (_reply != null && _voiceAvailable && !_locked && !_applied)
              FilledButton(
                key: const Key('bound-speak'),
                onPressed: _busy ? null : () => _run(_speak),
                child: const Text('朗读回应（本机合成）'),
              ),
            if (_voiceActive)
              TextButton(
                key: const Key('bound-stop-voice'),
                onPressed: () => _stopVoice(),
                child: const Text('停止本次语音播放'),
              ),
            if (_voiceMessage != null)
              Text(_voiceMessage!, key: const Key('bound-voice-status')),
            if (_replyRejected)
              const Text(
                '生物回应未通过绑定与格式校验，已隐藏；保留识别观察，不允许确认情境建议。',
                key: Key('bound-reply-rejected'),
              ),
            if ((_reply != null || _routeRequestPending || _routeRecovery) &&
                _event != null &&
                validatedSpokenRoute(
                      _event!['metadata']?['routeProposal'],
                      _event!,
                      widget.modality,
                    ) !=
                    null)
              SpokenRouteProposalCard(
                key: ValueKey('spoken-${_event!['eventId']}'),
                proposal: validatedSpokenRoute(
                  _event!['metadata']?['routeProposal'],
                  _event!,
                  widget.modality,
                )!,
                api: _api,
                recoveryOnly: _locked && _routeRecovery,
                onPendingChanged: (pending) {
                  if (mounted) {
                    setState(() {
                      _routeRequestPending = pending;
                      if (pending) _sendOnStop = false;
                    });
                  }
                },
                disabled: _locked || _busy,
                onApplied: () {
                  if (mounted) {
                    setState(() {
                      _applied = true;
                      _routeApplied = true;
                      _locked = true;
                    });
                  }
                },
              ),
            if (_reply != null && _creatureProposal?['status'] == 'ambiguous')
              const Text(
                '有同名的已注册生物，无法唯一确定目标。请在“我的伙伴”中明确选择；不会替你猜选。',
                key: Key('bound-creature-ambiguous'),
              ),
            if (_reply != null && _creatureProposal?['status'] == 'unavailable')
              const Text(
                '没有找到唯一可用的已注册生物。请检查名称或到“我的伙伴”中选择；不会自动订阅或创建。',
                key: Key('bound-creature-unavailable'),
              ),
            if (_candidate != null) ...[
              Text(
                _candidate == 'creature-request'
                    ? '待确认的精确动作：切换到 ${_creatureProposal!['targetName']}（${_creatureProposal!['targetCreatureId']}），不改变主生物或开启感官；已有任务保留。'
                    : '待确认的精确动作：${proposals[_candidate]}',
                key: const Key('bound-proposal'),
              ),
              FilledButton(
                key: const Key('bound-confirm'),
                onPressed: _busy ? null : () => _run(_confirm),
                child: const Text('另行确认：应用此情境建议'),
              ),
            ],
            if (_applied)
              Text(
                _routeApplied
                    ? '已取得合成路线回执，关闭返回生物空间查看。'
                    : '已确认情境建议。关闭返回生物空间查看；没有提交任何业务表单。',
                key: Key('bound-applied'),
              ),
          ],
        ),
      ),
    ),
  );
}

/// Bounded display data is not an authorization grant. Reject missing fields,
/// cross-creature/event replies and inconsistent action suggestions.
Map<String, dynamic>? validatedCreatureReply(
  dynamic raw,
  Map event,
  String modality,
) {
  if (raw is! Map<String, dynamic> ||
      event['frame'] is! Map ||
      event['metadata'] is! Map) {
    return null;
  }
  const keys = {
    'schema',
    'creatureId',
    'sceneRevision',
    'eventId',
    'source',
    'llmUsed',
    'text',
    'suggestedScene',
  };
  if (raw.length != keys.length || !raw.keys.every(keys.contains)) return null;
  final frame = event['frame'] as Map,
      candidate = event['metadata']['candidate'];
  final text = raw['text'];
  final creatureProposal = validatedSpokenCreature(
    event['metadata']['creatureProposal'],
    event,
    modality,
  );
  if ((event['metadata']['creatureProposal'] != null &&
          creatureProposal == null) ||
      (candidate == 'creature-request' &&
          creatureProposal?['status'] != 'ready') ||
      (event['metadata']['routeProposal'] != null &&
          validatedSpokenRoute(
                event['metadata']['routeProposal'],
                event,
                modality,
              ) ==
              null) ||
      raw['schema'] != 'creature-reply.v1' ||
      raw['source'] != 'deterministic-local' ||
      raw['llmUsed'] != false ||
      raw['creatureId'] is! String ||
      raw['creatureId'] != frame['creatureId'] ||
      raw['sceneRevision'] is! int ||
      raw['sceneRevision'] != frame['sceneRevision'] ||
      raw['eventId'] is! String ||
      (raw['eventId'] as String).isEmpty ||
      raw['eventId'] != event['eventId'] ||
      text is! String ||
      text.trim().isEmpty ||
      text.length > 600 ||
      !raw.containsKey('suggestedScene') ||
      raw['suggestedScene'] != candidate ||
      (candidate != null &&
          ![
            'work-context',
            'personal-context',
            'account-request',
            'text-entry-request',
            'creature-request',
          ].contains(candidate)) ||
      (modality == 'vision' &&
          (candidate != null ||
              event['metadata']['routeProposal'] != null ||
              event['metadata']['creatureProposal'] != null)) ||
      !['hearing', 'vision'].contains(modality) ||
      event['modality'] != modality ||
      event['status'] !=
          (candidate == null
              ? (validatedSpokenRoute(
                          event['metadata']['routeProposal'],
                          event,
                          modality,
                        )?['status'] ==
                        'ready'
                    ? 'awaiting_route_confirmation'
                    : 'observation')
              : 'awaiting_confirmation')) {
    return null;
  }
  return Map<String, dynamic>.from(raw);
}
