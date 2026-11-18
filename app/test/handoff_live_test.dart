import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:summon_app/api.dart';
import 'package:summon_app/scene_experiment.dart';
import 'package:summon_app/handoff_sheet.dart';

void main() {
  test('real Dart -> Node explicit delegation, interrupted running recovery, immutable receipt and cancellation', () async {
    final dir = await Directory.systemTemp.createTemp('handoff-dart-live-'),
        client = http.Client();
    Process? server;
    try {
      server = await Process.start(
        'node',
        [
          '--input-type=module',
          '-e',
          r'''
import {SceneLab} from './src/scene.js';
import {createSceneServer} from './src/scene-server.js';
import {join} from 'node:path';
let interrupted=false;
const lab=new SceneLab(join(process.env.SUMMON_SCENE_DATA,'core.sqlite'),join(process.env.SUMMON_SCENE_DATA,'sink.sqlite'),{handoffOptions:{afterStage:stage=>{if(stage==='root'&&!interrupted){interrupted=true;throw Error('test-only interruption after root grant');}}}});
const server=createSceneServer(lab);server.listen(8091,'127.0.0.1',()=>console.log('handoff-test-ready'));
process.on('SIGTERM',()=>server.close(()=>{lab.close();process.exit(0);}));
''',
        ],
        workingDirectory: '../runtime',
        environment: {'SUMMON_SCENE_DATA': dir.path},
      );
      final errors = <String>[];
      server.stderr.transform(utf8.decoder).listen(errors.add);
      await server.stdout
          .transform(utf8.decoder)
          .transform(const LineSplitter())
          .firstWhere((l) => l == 'handoff-test-ready')
          .timeout(
            const Duration(seconds: 10),
            onTimeout: () => throw StateError('startup: $errors'),
          );
      final api = SceneExperimentApi(client);
      var state = await api.request('perceive', {
        'modality': 'hearing',
        'signal': 'account-request',
      });
      state = await api.request('update', {
        'activityId': state['activity']['id'],
        'expectedRevision': state['activity']['revision'],
        'values': {
          'customerAlias': 'demo-a',
          'accountType': 'savings',
          'contactPreference': 'none',
        },
      });
      state = await api.request('creature-select', {'creatureId': 'companion'});
      expect(canPrepareHandoff(state), true);
      expect(
        validatedHandoffList(await api.request('handoff-list', {})),
        isEmpty,
      );
      final first = validatedHandoff(
        await api.request('handoff-prepare', {'context': state['context']}),
      )!;
      expect(first['status'], 'prepared');
      expect(handoffMatchesScene(first, state), true);
      final id = first['handoffId'];
      final repeated = validatedHandoff(
        await api.request('handoff-prepare', {'context': state['context']}),
      )!;
      expect(repeated, first);
      await expectLater(
        api.request('handoff-confirm', {
          'handoffId': id,
          'confirmation': 'share-synthetic-draft',
        }),
        throwsA(isA<ApiFailure>()),
      );
      final running = validatedHandoff(
        await api.request('handoff-status', {'handoffId': id}),
      )!;
      expect(running['status'], 'running');
      expect(running['expiresAt'], first['expiresAt']);
      expect(running['budget'], first['budget']);
      final done = validatedHandoff(
        await api.request('handoff-confirm', {
          'handoffId': id,
          'confirmation': 'share-synthetic-draft',
        }),
      )!;
      expect(done['status'], 'delivered');
      expect(done['receipt']['fact'], 'local_recipient_copy_saved');
      final historical = validatedHandoff(
        await api.request('handoff-confirm', {
          'handoffId': id,
          'confirmation': 'share-synthetic-draft',
        }),
      )!;
      expect(historical['receipt'], done['receipt']);
      expect(
        validatedHandoff(
          await api.request('handoff-cancel', {'handoffId': id}),
        )!['status'],
        'delivered',
      );
      expect(
        validatedHandoffList(await api.request('handoff-list', {}))!.length,
        1,
      );
      state = await api.request('state');
      expect(state['activity']['status'], 'draft');
      expect(state['activity']['receipt'], isNull);
      expect(state['primaryCreatureId'], 'companion');
      state = await api.request('creature-select', {'creatureId': 'work'});
      state = await api.request('update', {
        'activityId': state['activity']['id'],
        'expectedRevision': state['activity']['revision'],
        'values': {
          'customerAlias': 'demo-b',
          'accountType': 'daily',
          'contactPreference': 'none',
        },
      });
      state = await api.request('creature-select', {'creatureId': 'companion'});
      final next = validatedHandoff(
        await api.request('handoff-prepare', {'context': state['context']}),
      )!;
      expect(next['handoffId'], isNot(id));
      expect(
        validatedHandoff(
          await api.request('handoff-cancel', {'handoffId': next['handoffId']}),
        )!['status'],
        'cancelled',
      );
      expect(
        validatedHandoffList(await api.request('handoff-list', {}))!.length,
        2,
      );
    } finally {
      client.close();
      server?.kill();
      if (server != null) await server.exitCode;
      await dir.delete(recursive: true);
    }
  }, skip: Platform.environment['SUMMON_HANDOFF_LIVE'] != '1');
}
