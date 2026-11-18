import 'dart:math';

import 'package:material_ui/material_ui.dart';
import 'package:http/http.dart' as http;

import 'scene_experiment.dart';
import 'route_voice.dart';
import 'choice_form.dart';
import 'api.dart';

const marketProduct = 'demo.maps.v1';

/// Closed synthetic receipt renderer. No coordinates, URLs or executable actions.
Map<String, dynamic>? trustedRoute(dynamic state) {
  if (state is! Map) return null;
  final route = state['route'];
  if (route is! Map ||
      route['visible'] is! bool ||
      route['replayed'] is! bool) {
    return null;
  }
  final r = route['receipt'],
      render = route['render'],
      p = state['presentation'];
  if (r is! Map || render is! Map || p is! Map) return null;
  final creatures = state['creatures'];
  if (creatures is! List) return null;
  final matches = creatures
      .where((c) => c is Map && c['id'] == r['instanceId'])
      .toList();
  if (matches.length != 1) return null;
  final creature = matches.single as Map;
  if (creature['kind'] != 'business' ||
      creature['body'] != 'owl' ||
      creature['tone'] != 'precise' ||
      p['body'] != creature['body'] ||
      p['tone'] != creature['tone']) {
    return null;
  }
  final result = r['result'], input = r['input'];
  if (result is! Map || input is! Map) return null;
  const nodes = ['A', 'B', 'C'];
  if (!nodes.contains(input['from']) || !nodes.contains(input['to'])) {
    return null;
  }
  final from = nodes.indexOf(input['from']), to = nodes.indexOf(input['to']);
  final path = <String>[];
  for (var i = from; ; i += from <= to ? 1 : -1) {
    path.add(nodes[i]);
    if (i == to) break;
  }
  bool samePath(dynamic value) =>
      value is List &&
      value.length == path.length &&
      List.generate(path.length, (i) => value[i] == path[i]).every((v) => v);
  if (r['receiptId'] is! String ||
      (r['receiptId'] as String).isEmpty ||
      r['requestId'] is! String ||
      r['instanceId'] is! String ||
      r['providerId'] != 'demo-maps' ||
      r['productId'] != marketProduct ||
      r['serviceId'] != 'synthetic.route.v1' ||
      r['serviceVersion'] != 1 ||
      r['source'] != 'deterministic-synthetic-route' ||
      !samePath(result['path']) ||
      result['hops'] != path.length - 1 ||
      render['schema'] != 'synthetic-route.v1' ||
      !samePath(render['nodes']) ||
      render['hops'] != result['hops'] ||
      [
        'receiptId',
        'providerId',
        'productId',
        'instanceId',
        'source',
      ].any((k) => render[k] != r[k]) ||
      state['activeCreatureId'] != r['instanceId'] ||
      p['schema'] != 'creature-scene.v1' ||
      p['source'] != 'deterministic-policy' ||
      p['creatureId'] != r['instanceId'] ||
      p['surface'] !=
          (route['visible'] == true ? 'synthetic-route' : 'route-summary')) {
    return null;
  }
  return Map<String, dynamic>.from(route);
}

class SyntheticRouteCard extends StatelessWidget {
  const SyntheticRouteCard({
    super.key,
    required this.route,
    required this.onVisibility,
    this.busy = false,
  });
  final Map<String, dynamic> route;
  final void Function(bool) onVisibility;
  final bool busy;
  @override
  Widget build(BuildContext context) => Card(
    child: Padding(
      padding: const EdgeInsets.all(16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          const Text('演示地图伙伴 · 合成路线回执'),
          Text(route['replayed'] == true ? '历史回执重放，未再次调用服务' : '本次请求已有合成服务回执'),
          const Text('只含 A/B/C 合成节点，不是真实地图、GPS 或导航。'),
          if (route['visible'] == true) ...[
            Text(
              (route['render']['nodes'] as List).join(' → '),
              key: const Key('synthetic-route-path'),
              style: Theme.of(context).textTheme.headlineSmall,
            ),
            Text('提供者：demo-maps\n回执：${route['receipt']['receiptId']}'),
          ] else
            const Text('路线卡已收起，服务回执仍保留。'),
          TextButton(
            key: const Key('route-visibility'),
            onPressed: busy
                ? null
                : () => onVisibility(route['visible'] != true),
            child: Text(route['visible'] == true ? '收起路线卡（保留回执）' : '恢复路线卡'),
          ),
        ],
      ),
    ),
  );
}

class CreatureMarketSheet extends StatefulWidget {
  const CreatureMarketSheet({super.key, required this.client});
  final http.Client client;
  @override
  State<CreatureMarketSheet> createState() => _CreatureMarketSheetState();
}

class _CreatureMarketSheetState extends State<CreatureMarketSheet> {
  late final SceneExperimentApi _api;
  Map<String, dynamic>? _state;
  bool _busy = false;
  final ChoiceDraft _draft = ChoiceDraft();
  String? _error, _pending, _requestNotice;
  @override
  void initState() {
    super.initState();
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
      if (action == 'form-route') {
        final route = trustedRoute(state);
        final receipt = route?['receipt'];
        if (receipt is! Map ||
            receipt['requestId'] != body?['requestId'] ||
            receipt['instanceId'] != body?['binding']?['instanceId'] ||
            receipt['input']['from'] != body?['values']?['from'] ||
            receipt['input']['to'] != body?['values']?['to']) {
          throw StateError('route_response_mismatch');
        }
      }
      if (!mounted) return;
      setState(() {
        _state = state;
        _draft.reconcile(
          state['choiceForms']?['route'],
          state,
          'synthetic-route.v1',
          acknowledged: action == 'form-route',
        );
      });
      if (_pending != null) {
        final requests = state['market']?['requests'];
        final matches = requests is List
            ? requests
                  .where((r) => r is Map && r['requestId'] == _pending)
                  .toList()
            : [];
        final status = matches.length == 1 ? matches.single['status'] : null;
        const labels = {
          'pending': '服务器仍处理中',
          'failed': '已失败',
          'cancelled': '已取消',
          'completed': '已完成',
        };
        setState(() {
          _requestNotice =
              '请求 $_pending：${labels[status] ?? '结果未知'}。下方既有回执不代表此请求成功。';
          if (['failed', 'cancelled', 'completed'].contains(status)) {
            _pending = null;
          }
        });
      }
    } catch (error) {
      if (action == 'form-route') {
        if (error is ApiFailure && error.code == 'form_binding_conflict') {
          _draft.stale = true;
          try {
            final fresh = await _api.request('state');
            if (mounted) {
              _state = fresh;
              _draft.reconcile(
                fresh['choiceForms']?['route'],
                fresh,
                'synthetic-route.v1',
              );
            }
          } catch (_) {
            /* Keep the original uncertainty and draft; never re-dispatch. */
          }
        }
      }
      if (mounted) {
        setState(() {
          _error = '操作结果未确认。不会自动重新派发，请刷新核对回执及权限。';
          if (_pending != null) {
            _requestNotice = '请求 $_pending：结果未知。下方既有回执不代表此请求成功。';
          }
        });
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final market = _state?['market'];
    final catalog = market is Map ? market['catalog'] : null;
    final available =
        catalog is List &&
        catalog.any(
          (p) =>
              p is Map &&
              p['productId'] == marketProduct &&
              p['providerId'] == 'demo-maps' &&
              p['serviceId'] == 'synthetic.route.v1' &&
              p['serviceVersion'] == 1 &&
              p['mode'] == 'synthetic-only' &&
              p['network'] == false &&
              p['paid'] == false,
        );
    final subs = market is Map ? market['subscriptions'] : null;
    final matches = subs is List
        ? subs
              .where((s) => s is Map && s['productId'] == marketProduct)
              .toList()
        : [];
    final sub = matches.length == 1 ? matches.single as Map : null;
    final active = sub?['status'] == 'active';
    final route = trustedRoute(_state);
    return SafeArea(
      child: SingleChildScrollView(
        padding: const EdgeInsets.all(20),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text('发现业务生物', style: Theme.of(context).textTheme.headlineSmall),
            const Text('本机合成市场实验 · 免费、不联网、不使用 GPS。订阅不会改变主生物，也不会开启感官。'),
            if (_busy) const LinearProgressIndicator(),
            if (_error != null) Text(_error!, key: const Key('market-error')),
            TextButton(
              onPressed: _busy ? null : () => _request('state'),
              child: const Text('刷新并核对回执'),
            ),
            if (_requestNotice != null)
              Text(_requestNotice!, key: const Key('market-request-status')),
            if (_pending != null) ...[
              Text('待核对请求：$_pending。未明确终止前不发起新路线。'),
              const Text('放弃只阻止本地合成路线提交新回执，不代表停止 CPU 或任何远端动作。已完成的回执会保留。'),
              OutlinedButton(
                key: const Key('market-cancel'),
                onPressed: _busy
                    ? null
                    : () => _request('market-cancel', {'requestId': _pending}),
                child: const Text('放弃此未确认请求（不重派）'),
              ),
            ],
            if (available) ...[
              const Text('演示地图伙伴\n发布者：demo-maps · synthetic.route.v1 / v1'),
              if (!active)
                FilledButton(
                  key: const Key('market-subscribe'),
                  onPressed: _busy
                      ? null
                      : () => _request('market-subscribe', {
                          'productId': marketProduct,
                        }),
                  child: const Text('订阅合成地图伙伴'),
                ),
              if (active) ...[
                Text('指定提供者实例：${sub!['instanceId']}'),
                SwitchListTile(
                  key: const Key('market-grant'),
                  title: const Text('允许此实例计算合成路线'),
                  value: sub['routeGranted'] == true,
                  onChanged: _busy || sub['revision'] is! int
                      ? null
                      : (v) => _request('market-grant', {
                          'productId': marketProduct,
                          'enabled': v,
                          'expectedRevision': sub['revision'],
                        }),
                ),
                ChoiceForm(
                  draft: _draft,
                  disabled: _busy || _pending != null,
                  fieldKey: (id) => 'market-$id',
                  onChanged: () => setState(() {}),
                ),
                FilledButton(
                  key: const Key('market-route'),
                  onPressed:
                      _busy ||
                          _pending != null ||
                          sub['routeGranted'] != true ||
                          !_draft.ready ||
                          sub['instanceId'] is! String
                      ? null
                      : () {
                          final id =
                              'route-${DateTime.now().microsecondsSinceEpoch.toRadixString(36)}-${Random().nextInt(1048576)}';
                          _pending = id;
                          _requestNotice = '请求 $id：发送中，尚无回执。';
                          _request('form-route', {
                            ..._draft.submission(),
                            'requestId': id,
                          });
                        },
                  child: const Text('请求此提供者的合成路线'),
                ),
                TextButton(
                  onPressed: _busy || sub['revision'] is! int
                      ? null
                      : () => _request('market-unsubscribe', {
                          'productId': marketProduct,
                          'expectedRevision': sub['revision'],
                        }),
                  child: const Text('退订（保留历史回执）'),
                ),
              ],
            ] else if (!_busy)
              const Text('未取得可信的演示产品目录。'),
            if (route != null)
              RouteVoiceControl(state: _state!, api: _api, disabled: _busy),
            if (route != null)
              SyntheticRouteCard(
                route: route,
                busy: _busy,
                onVisibility: (v) => _request('route-visible', {
                  'receiptId': route['receipt']['receiptId'],
                  'visible': v,
                }),
              ),
          ],
        ),
      ),
    );
  }
}
