import 'dart:math';

import 'package:material_ui/material_ui.dart';
import 'package:http/http.dart' as http;

import 'api.dart';
import 'creature_market.dart';
import 'scene_experiment.dart';
import 'real_usage.dart';

Map<String, dynamic>? registeredCreature(dynamic state, dynamic id) {
  if (state is! Map ||
      state['creatures'] is! List ||
      id is! String ||
      id.isEmpty ||
      id.length > 128) {
    return null;
  }
  final matches = (state['creatures'] as List)
      .where((c) => c is Map && c['id'] == id)
      .toList();
  if (matches.length != 1) return null;
  final raw = matches.single as Map;
  if (raw['name'] is! String ||
      (raw['name'] as String).trim().isEmpty ||
      (raw['name'] as String).length > 100 ||
      raw['personality'] is! String ||
      (raw['personality'] as String).length > 600 ||
      !['sprout', 'owl'].contains(raw['body']) ||
      !['playful', 'precise'].contains(raw['tone']) ||
      !['companion', 'stand-in', 'pet', 'business'].contains(raw['kind'])) {
    return null;
  }
  return Map<String, dynamic>.from(raw);
}

bool registeredSenseAllowed(Map<String, dynamic>? creature, String modality) =>
    creature?['generation'] is int &&
    creature!['generation'] >= 0 &&
    creature['senses'] is Map &&
    creature['senses'][modality] == true;

class CreatureSelectionRecovery {
  Map<String, dynamic>? body;
}

class CreatureRegistrySheet extends StatefulWidget {
  const CreatureRegistrySheet({
    super.key,
    required this.client,
    this.canSelectCreature,
    this.selectionRecovery,
  });
  final http.Client client;
  final CreatureSelectionRecovery? selectionRecovery;
  final bool Function()? canSelectCreature;
  @override
  State<CreatureRegistrySheet> createState() => _CreatureRegistrySheetState();
}

class _CreatureRegistrySheetState extends State<CreatureRegistrySheet>
    with WidgetsBindingObserver {
  int _selectionEpoch = 0;
  bool _foreground = true;
  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    _selectionEpoch++;
    _foreground = state == AppLifecycleState.resumed;
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  late final SceneExperimentApi _api;
  Map<String, dynamic>? _state;
  String? _detailId, _error;
  bool _busy = false, _selectionUntracked = false;
  final _localSelection = CreatureSelectionRecovery();
  CreatureSelectionRecovery get _recovery =>
      widget.selectionRecovery ?? _localSelection;
  Map<String, dynamic>? get _selectionBody => _recovery.body;
  set _selectionBody(Map<String, dynamic>? body) => _recovery.body = body;
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _api = SceneExperimentApi(widget.client);
    _request('state');
  }

  Future<void> _request(String action, [Map<String, dynamic>? body]) async {
    if (_busy) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final state = await _api.request(action, body);
      if (!mounted) return;
      setState(() {
        _state = state;
        if (action == 'creature-create') _detailId = body?['id'] as String?;
        _detailId ??= state['activeCreatureId'];
      });
      if (action == 'creature-select' && mounted) Navigator.of(context).pop();
    } catch (error) {
      if (error is ApiFailure && error.code == 'revision_conflict') {
        try {
          final latest = await _api.request('state');
          if (mounted) _state = latest;
        } catch (_) {}
      }
      if (mounted) {
        setState(
          () => _error = error is ApiFailure
              ? '${error.code}：未自动重提，请核对状态后重新选择。'
              : '操作结果未确认，未自动重试；请刷新核对伙伴。',
        );
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _selectCreature(String creatureId, {bool query = false}) async {
    final epoch = _selectionEpoch, route = ModalRoute.of(context);
    bool valid() =>
        mounted &&
        _foreground &&
        epoch == _selectionEpoch &&
        route?.isCurrent == true &&
        identical(route, ModalRoute.of(context));
    if (!valid() || _busy || (!query && _selectionBody != null)) return;
    if (!query && widget.canSelectCreature?.call() == false) {
      setState(() => _error = '请先处理保留草稿，再切换生物；不会自动保存或清除。');
      return;
    }
    final frame = _state?['context'];
    if (!query && !usageContext(frame)) return;
    final body =
        _selectionBody ??
        <String, dynamic>{
          'commandId': usageCommandId(),
          'creatureId': creatureId,
          'context': Map<String, dynamic>.from(frame),
        };
    _selectionBody = body;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final r = await _api.request(
        query ? 'usage-query' : 'usage-select',
        query ? {'commandId': body['commandId']} : body,
      );
      if (!valid()) return;
      final ack = query
          ? (r['status'] == 'completed' &&
                    r['commandId'] == body['commandId'] &&
                    r.length == 3
                ? validatedUsageAck(
                    r['ack'],
                    body,
                    selection: true,
                    stored: true,
                  )
                : null)
          : validatedUsageResult(r, body, selection: true);
      if (ack == null) {
        if (query &&
            r['commandId'] == body['commandId'] &&
            r['status'] == 'untracked' &&
            r['reason'] == 'learning-saturated' &&
            r.length == 3) {
          final state = await _api.request('state');
          if (valid() &&
              usageContext(state['context']) &&
              state['mode'] == 'deterministic-synthetic' &&
              state['activeCreatureId'] == state['context']['creatureId'] &&
              registeredCreature(state, state['activeCreatureId']) != null) {
            setState(() {
              _state = state;
              _selectionUntracked = true;
              _error = '原动作无历史回执，不能判定成功或未执行。已核验当前状态，可结束核对后另选。';
            });
          }
          return;
        }
        throw const ApiFailure(502, 'usage_selection_unconfirmed');
      }
      _selectionBody = null;
      _selectionUntracked = false;
      if (!mounted || !valid()) return;
      if (ModalRoute.of(context)?.isCurrent == true &&
          Navigator.of(context).canPop()) {
        Navigator.of(context).pop();
      } else {
        final state = await _api.request('state');
        if (mounted) setState(() => _state = state);
      }
    } catch (_) {
      if (mounted) setState(() => _error = '选择结果待核对，不自动重发或启用感官。');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _createPet() async {
    if (_busy) return;
    final draft = await showDialog<Map<String, String>>(
      context: context,
      builder: (_) => const _CreatePetDialog(),
    );
    if (!mounted || draft == null || _busy) return;
    final id =
        'pet-${DateTime.now().microsecondsSinceEpoch.toRadixString(36)}-${Random().nextInt(1048576).toRadixString(36)}';
    await _request('creature-create', {
      'id': id,
      'name': draft['name'],
      'kind': 'pet',
      'personality': draft['personality'],
      'body': 'sprout',
      'tone': 'playful',
    });
  }

  @override
  Widget build(BuildContext context) {
    final all = _state?['creatures'];
    final selected = registeredCreature(_state, _detailId);
    final revision = _state?['registryRevision'];
    return SafeArea(
      child: SingleChildScrollView(
        padding: const EdgeInsets.all(20),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text('我的伙伴', style: Theme.of(context).textTheme.headlineSmall),
            if (_selectionUntracked)
              TextButton(
                key: const Key('registry-selection-finish'),
                onPressed: _busy
                    ? null
                    : () => setState(() {
                        _selectionBody = null;
                        _selectionUntracked = false;
                      }),
                child: const Text('结束核对（原动作仍未知）'),
              ),
            if (_selectionBody != null)
              TextButton(
                key: const Key('registry-selection-query'),
                onPressed: _busy
                    ? null
                    : () => _selectCreature(
                        _selectionBody!['creatureId'],
                        query: true,
                      ),
                child: const Text('核对原选择结果（不重发）'),
              ),
            const Text('主生物是陪伴关系，不会自动切换当前生物或增加任何业务权限。'),
            OutlinedButton(
              key: const Key('registry-add-pet'),
              onPressed: _busy ? null : _createPet,
              child: const Text('添加宠物伙伴'),
            ),
            OutlinedButton(
              key: const Key('registry-market'),
              onPressed: _busy
                  ? null
                  : () async {
                      await showModalBottomSheet<void>(
                        context: context,
                        isScrollControlled: true,
                        builder: (_) => FractionallySizedBox(
                          heightFactor: .9,
                          child: CreatureMarketSheet(client: widget.client),
                        ),
                      );
                      if (mounted) await _request('state');
                    },
              child: const Text('发现业务生物'),
            ),
            if (_busy) const LinearProgressIndicator(),
            if (_error != null) Text(_error!, key: const Key('registry-error')),
            TextButton(
              key: const Key('registry-refresh'),
              onPressed: _busy ? null : () => _request('state'),
              child: const Text('刷新伙伴状态'),
            ),
            if (all is List)
              for (final entry in all.take(50))
                if (entry is Map &&
                    registeredCreature(_state, entry['id']) != null)
                  ListTile(
                    key: Key('registry-row-${entry['id']}'),
                    title: Text(entry['name']),
                    subtitle: Text(
                      '${entry['id'] == _state?['activeCreatureId'] ? '当前生物 · ' : ''}${entry['id'] == _state?['primaryCreatureId'] ? '主生物' : '伙伴'}',
                    ),
                    selected: entry['id'] == _detailId,
                    onTap: _busy
                        ? null
                        : () => setState(() => _detailId = entry['id']),
                  ),
            if (selected != null) ...[
              const Divider(),
              Text(selected['personality']),
              FilledButton(
                key: const Key('registry-select'),
                onPressed:
                    _busy ||
                        _selectionBody != null ||
                        selected['id'] == _state?['activeCreatureId']
                    ? null
                    : () => _selectCreature(selected['id']),
                child: Text('与${selected['name']}相处'),
              ),
              OutlinedButton(
                key: const Key('registry-primary'),
                onPressed:
                    _busy ||
                        revision is! int ||
                        selected['id'] == _state?['primaryCreatureId']
                    ? null
                    : () => _request('creature-primary', {
                        'creatureId': selected['id'],
                        'expectedRevision': revision,
                      }),
                child: const Text('设为主生物（不切换、不扩权）'),
              ),
              const Text('仅为此生物允许本机感官处理。开启不会自动录音或拍照。'),
              for (final modality in ['hearing', 'vision'])
                SwitchListTile(
                  key: Key('registry-sense-$modality'),
                  title: Text(
                    '允许${selected['name']}使用${modality == 'hearing' ? '听觉' : '视觉'}',
                  ),
                  value: registeredSenseAllowed(selected, modality),
                  onChanged: _busy || revision is! int
                      ? null
                      : (enabled) => _request('creature-sense', {
                          'creatureId': selected['id'],
                          'modality': modality,
                          'enabled': enabled,
                          'expectedRevision': revision,
                        }),
                ),
            ],
          ],
        ),
      ),
    );
  }
}

class _CreatePetDialog extends StatefulWidget {
  const _CreatePetDialog();
  @override
  State<_CreatePetDialog> createState() => _CreatePetDialogState();
}

class _CreatePetDialogState extends State<_CreatePetDialog> {
  final _name = TextEditingController(),
      _personality = TextEditingController(text: '好奇、温柔，陪伴我的日常。');
  bool get valid =>
      _name.text.trim().isNotEmpty &&
      _name.text.length <= 64 &&
      _personality.text.trim().isNotEmpty &&
      _personality.text.length <= 512 &&
      !RegExp(r'[\x00-\x1f\x7f]').hasMatch(_name.text + _personality.text);
  @override
  void dispose() {
    _name.dispose();
    _personality.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => AlertDialog(
    title: const Text('添加宠物伙伴'),
    content: SingleChildScrollView(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          const Text('默认叶芽外形、活泼动作。不会自动变成主生物，也不会自动开启听觉或视觉。'),
          TextField(
            key: const Key('pet-name'),
            controller: _name,
            maxLength: 64,
            decoration: const InputDecoration(labelText: '名字'),
            onChanged: (_) => setState(() {}),
          ),
          TextField(
            key: const Key('pet-personality'),
            controller: _personality,
            maxLength: 512,
            decoration: const InputDecoration(labelText: '个性'),
            onChanged: (_) => setState(() {}),
          ),
        ],
      ),
    ),
    actions: [
      TextButton(
        onPressed: () => Navigator.pop(context),
        child: const Text('取消'),
      ),
      FilledButton(
        key: const Key('pet-create-confirm'),
        onPressed: valid
            ? () => Navigator.pop(context, {
                'name': _name.text.trim(),
                'personality': _personality.text.trim(),
              })
            : null,
        child: const Text('创建（感官默认关闭）'),
      ),
    ],
  );
}
