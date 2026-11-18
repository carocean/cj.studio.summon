import 'package:material_ui/material_ui.dart';

import 'scene_experiment.dart';
import 'creature_market.dart';

Map<String, dynamic>? validatedSpokenRoute(
  dynamic raw,
  Map event,
  String modality,
) {
  const keys = {
    'schema',
    'proposalId',
    'eventId',
    'context',
    'requestId',
    'productId',
    'providerId',
    'instanceId',
    'serviceId',
    'serviceVersion',
    'from',
    'to',
    'source',
    'status',
    'reason',
    'subscriptionRevision',
    'subscriptionGeneration',
    'expiresAt',
  };
  if (raw is! Map ||
      raw.length != keys.length ||
      !raw.keys.every(keys.contains) ||
      modality != 'hearing' ||
      event['modality'] != 'hearing' ||
      event['metadata'] is! Map ||
      event['metadata']['candidate'] != null) {
    return null;
  }
  final frame = event['frame'], context = raw['context'];
  if (frame is! Map ||
      context is! Map ||
      context.length != 2 ||
      context['creatureId'] is! String ||
      context['creatureId'] != frame['creatureId'] ||
      context['sceneRevision'] is! int ||
      context['sceneRevision'] != frame['sceneRevision'] ||
      raw['schema'] != 'spoken-route-proposal.v1' ||
      raw['eventId'] != event['eventId'] ||
      event['eventId'] is! String ||
      raw['proposalId'] != 'sr-${event['eventId']}' ||
      raw['requestId'] != 'speech-${event['eventId']}' ||
      raw['productId'] != marketProduct ||
      raw['providerId'] != 'demo-maps' ||
      raw['serviceId'] != 'synthetic.route.v1' ||
      raw['serviceVersion'] != 1 ||
      raw['source'] != 'finite-spoken-route.v1' ||
      !['A', 'B', 'C'].contains(raw['from']) ||
      !['A', 'B', 'C'].contains(raw['to']) ||
      raw['expiresAt'] is! int ||
      raw['expiresAt'] <= 0) {
    return null;
  }
  final ready = raw['status'] == 'ready';
  if (ready) {
    if (raw['reason'] != null ||
        raw['instanceId'] is! String ||
        (raw['instanceId'] as String).isEmpty ||
        raw['subscriptionRevision'] is! int ||
        raw['subscriptionRevision'] < 1 ||
        raw['subscriptionGeneration'] is! int ||
        raw['subscriptionGeneration'] < 0 ||
        event['status'] != 'awaiting_route_confirmation') {
      return null;
    }
  } else {
    if (raw['status'] != 'blocked' ||
        !['not_subscribed', 'route_not_granted'].contains(raw['reason']) ||
        event['status'] != 'observation') {
      return null;
    }
    if (raw['instanceId'] != null && raw['instanceId'] is! String) return null;
    if (raw['subscriptionRevision'] != null &&
        (raw['subscriptionRevision'] is! int ||
            raw['subscriptionRevision'] < 1)) {
      return null;
    }
    if (raw['subscriptionGeneration'] != null &&
        (raw['subscriptionGeneration'] is! int ||
            raw['subscriptionGeneration'] < 0)) {
      return null;
    }
  }
  return Map<String, dynamic>.from(raw);
}

class SpokenRouteProposalCard extends StatefulWidget {
  const SpokenRouteProposalCard({
    super.key,
    required this.proposal,
    required this.api,
    required this.onApplied,
    this.onPendingChanged,
    this.recoveryOnly = false,
    this.disabled = false,
  });
  final Map<String, dynamic> proposal;
  final SceneExperimentApi api;
  final VoidCallback onApplied;
  final ValueChanged<bool>? onPendingChanged;
  final bool recoveryOnly;
  final bool disabled;
  @override
  State<SpokenRouteProposalCard> createState() =>
      _SpokenRouteProposalCardState();
}

class _SpokenRouteProposalCardState extends State<SpokenRouteProposalCard> {
  bool _busy = false, _attempted = false, _done = false;
  String? _message;
  Map<String, dynamic>? _route;
  Future<void> _request(String action) async {
    if (_busy ||
        _done ||
        (widget.disabled &&
            !(widget.recoveryOnly && action != 'sense-route-confirm'))) {
      return;
    }
    final p = widget.proposal;
    if (action == 'sense-route-confirm' &&
        DateTime.now().millisecondsSinceEpoch >= p['expiresAt']) {
      setState(() => _message = '建议已过期，请重新采集。');
      return;
    }
    setState(() {
      _busy = true;
      _attempted = true;
      _message = null;
    });
    widget.onPendingChanged?.call(true);
    try {
      final response = await widget.api.request(action, {
        'eventId': p['eventId'],
        'expectedProposal': p,
        if (action == 'sense-route-confirm') ...{
          'context': p['context'],
          'confirmation': 'request-synthetic-route',
        },
      });
      if (!mounted ||
          (widget.disabled &&
              !(widget.recoveryOnly && action != 'sense-route-confirm'))) {
        return;
      }
      final status = response['requestStatus'];
      if (response['eventId'] != p['eventId'] ||
          response['requestId'] != p['requestId'] ||
          response['eventStatus'] is! String ||
          (action == 'sense-route-confirm' && response['replayed'] is! bool) ||
          ![
            'not_started',
            'pending',
            'failed',
            'cancelled',
            'completed',
          ].contains(status)) {
        throw StateError('response_mismatch');
      }
      if (status == 'completed' && action == 'sense-route-confirm') {
        final route = trustedRoute(response['state']);
        final r = route?['receipt'];
        if (r is! Map ||
            r['receiptId'] != response['receiptId'] ||
            r['requestId'] != p['requestId'] ||
            r['instanceId'] != p['instanceId'] ||
            r['input']['from'] != p['from'] ||
            r['input']['to'] != p['to']) {
          throw StateError('receipt_mismatch');
        }
        setState(() {
          _route = route;
          _done = true;
          _message = '已取得合成路线回执。关闭返回生物空间查看。';
        });
        widget.onPendingChanged?.call(false);
        widget.onApplied();
      } else {
        setState(() {
          _message =
              '此请求：${{'not_started': '尚未开始（不自动重派）', 'pending': '服务器仍处理中', 'failed': '已失败', 'cancelled': '已取消', 'completed': '已完成，可关闭后核对历史回执'}[status]}。查询和放弃不会自动呈现场景。';
          _done = ['failed', 'cancelled', 'completed'].contains(status);
        });
        widget.onPendingChanged?.call(!_done);
      }
    } catch (_) {
      if (mounted) setState(() => _message = '结果未知，未自动重提。请查询结果或放弃此请求。');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final p = widget.proposal, ready = widget.proposal['status'] == 'ready';
    final expired = DateTime.now().millisecondsSinceEpoch >= p['expiresAt'];
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(
              _attempted
                  ? '有限口令、非 LLM：请求结果以服务器记录与回执为准。'
                  : '有限口令、非 LLM：这只是路线建议，尚未调用服务。',
            ),
            Text(
              '提供者：demo-maps\n服务：synthetic.route.v1 / v1\n实例：${p['instanceId'] ?? '尚未订阅'}\n合成起终点：${p['from']} → ${p['to']}',
            ),
            const Text('支持有限口令示例：演示地图，从甲站到丙站。不是通用语义理解，也不是真实导航。'),
            if (!ready)
              Text(
                p['reason'] == 'not_subscribed'
                    ? '请到伙伴面板的市场手动订阅。不会自动订阅或授权。'
                    : '请到市场手动允许此实例的合成路线能力。不会自动授权。',
              ),
            if (expired && !_attempted) const Text('建议已过期，请重新采集。'),
            if (ready && !_attempted)
              FilledButton(
                key: const Key('spoken-route-confirm'),
                onPressed: widget.disabled || _busy || expired
                    ? null
                    : () => _request('sense-route-confirm'),
                child: const Text('确认获取合成路线'),
              ),
            if (_attempted && !_done) ...[
              TextButton(
                key: const Key('spoken-route-status'),
                onPressed: (widget.disabled && !widget.recoveryOnly) || _busy
                    ? null
                    : () => _request('sense-route-status'),
                child: const Text('查询此路线请求结果'),
              ),
              TextButton(
                key: const Key('spoken-route-cancel'),
                onPressed: (widget.disabled && !widget.recoveryOnly) || _busy
                    ? null
                    : () => _request('sense-route-cancel'),
                child: const Text('放弃此请求（不重派）'),
              ),
              const Text('放弃只阻止本机合成回执提交，不代表停止 CPU 或远端动作。'),
            ],
            if (_busy) const LinearProgressIndicator(),
            if (_message != null)
              Text(_message!, key: const Key('spoken-route-status-message')),
            if (_route != null)
              Text(
                (_route!['render']['nodes'] as List).join(' → '),
                key: const Key('spoken-route-result'),
              ),
          ],
        ),
      ),
    );
  }
}
