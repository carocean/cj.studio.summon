import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:material_ui/material_ui.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:summon_app/creature_home.dart';
import 'package:summon_app/dish_remote_surface.dart';

import 'creature_home_minimal_test.dart' show response, state, idle;

void main() {
  for (final replace in [false, true]) {
    testWidgets(
      'late dish intent cannot cross authentication ${replace ? 'replacement' : 'revoke/regrant'}',
      (t) async {
        final access = ValueNotifier(true),
            next = ValueNotifier(true),
            controller = CreatureHomeController(),
            pending = Completer<http.Response>();
        var dishReads = 0;
        final client = MockClient((r) async {
          if (r.url.path.endsWith('/state')) return pending.future;
          if (r.url.path.endsWith('/dish-read')) dishReads++;
          return response({
            'schema': 'real-usage-history.v1',
            'items': [],
            'learningSaturated': false,
            'minUses': 2,
            'sourceTrust': 'host-actions-and-client-presentation-reports',
          });
        });
        Widget home(ValueNotifier<bool> a) => MaterialApp(
          home: CreatureHome(
            controller: controller,
            client: client,
            interactionAccess: a,
          ),
        );
        await t.pumpWidget(home(access));
        await idle(t);
        final operation = controller.presentDish(
          'meal',
          expectedContext: {'creatureId': 'companion', 'sceneRevision': 1},
        );
        await t.pump();
        if (replace) {
          await t.pumpWidget(home(next));
        } else {
          access.value = false;
          access.value = true;
        }
        pending.complete(response(state()));
        await idle(t);
        expect(await operation, CreaturePresentationResult.stale);
        expect(dishReads, 0);
        expect(find.byType(DishRemoteSurface), findsNothing);
        await t.pumpWidget(const SizedBox());
        client.close();
        access.dispose();
        next.dispose();
      },
    );
  }
}
