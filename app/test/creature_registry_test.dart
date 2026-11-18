import 'package:material_ui/material_ui.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:summon_app/creature_workbench.dart';
import 'package:summon_app/creature_registry.dart';

import 'scene_experiment_test.dart' show Lab;
import 'creature_workbench_test.dart' show click, settle;

Map<String, dynamic> pet() => {
  'id': 'moss',
  'name': '苔苔',
  'personality': '喜欢安静陪伴',
  'kind': 'pet',
  'body': 'owl',
  'tone': 'playful',
  'senses': {'hearing': false, 'vision': false},
  'generation': 0,
};
void main() {
  testWidgets(
    'arbitrary registered creature renders name/body/tone without granting work authority',
    (t) async {
      final lab = Lab();
      (lab.state['creatures'] as List).add(pet());
      lab.state['activeCreatureId'] = 'moss';
      await t.pumpWidget(
        MaterialApp(home: CreatureWorkbench(client: lab.client)),
      );
      await settle(t);
      expect(find.text('苔苔'), findsOneWidget);
      expect(find.text('喜欢安静陪伴'), findsOneWidget);
      final avatar = t.widget<CreatureAvatar>(find.byType(CreatureAvatar));
      expect(avatar.work, isTrue);
      expect(avatar.precise, isFalse);
      expect(find.text('小谨的工作台'), findsNothing);
      expect(
        t
            .widget<FilledButton>(find.byKey(const Key('creature-hear')))
            .onPressed,
        isNull,
      );
    },
  );
  testWidgets(
    'partner picker sets primary without selecting or enabling senses; explicit toggle and exact selection',
    (t) async {
      final lab = Lab();
      (lab.state['creatures'] as List).add(pet());
      await t.pumpWidget(
        MaterialApp(home: CreatureWorkbench(client: lab.client)),
      );
      await settle(t);
      await click(t, 'creature-partners');
      await click(t, 'registry-row-moss');
      await click(t, 'registry-primary');
      expect(lab.state['primaryCreatureId'], 'moss');
      expect(lab.state['activeCreatureId'], 'companion');
      final creature = (lab.state['creatures'] as List).last;
      expect(creature['senses']['hearing'], isFalse);
      await click(t, 'registry-sense-hearing');
      expect(creature['senses']['hearing'], isTrue);
      expect(creature['senses']['vision'], isFalse);
      await click(t, 'registry-select');
      expect(lab.state['activeCreatureId'], 'moss');
      expect(find.text('苔苔'), findsOneWidget);
      expect(
        t
            .widget<FilledButton>(find.byKey(const Key('creature-hear')))
            .onPressed,
        isNotNull,
      );
      expect(
        t
            .widget<OutlinedButton>(find.byKey(const Key('creature-see')))
            .onPressed,
        isNull,
      );
      await click(t, 'creature-hear');
      expect(find.text('苔苔 · 听觉'), findsOneWidget);
      expect(find.text('当前绑定：苔苔（moss）'), findsOneWidget);
    },
  );
  testWidgets(
    'registry revision conflict refreshes without retrying primary mutation',
    (t) async {
      final lab = Lab();
      (lab.state['creatures'] as List).add(pet());
      await t.pumpWidget(
        MaterialApp(
          home: Scaffold(body: CreatureRegistrySheet(client: lab.client)),
        ),
      );
      await t.pumpAndSettle();
      await click(t, 'registry-row-moss');
      lab.fail = true;
      final before = lab.writes;
      await click(t, 'registry-primary');
      expect(find.byKey(const Key('registry-error')), findsOneWidget);
      expect(lab.writes, before + 1);
      expect(lab.state['primaryCreatureId'], 'companion');
    },
  );
  test(
    'missing or malformed senses deny sensor access, duplicates deny identity',
    () {
      final creature = pet()..remove('senses');
      expect(registeredSenseAllowed(creature, 'hearing'), isFalse);
      creature['senses'] = {'hearing': 'true'};
      expect(registeredSenseAllowed(creature, 'hearing'), isFalse);
      expect(
        registeredCreature({
          'creatures': [pet(), pet()],
        }, 'moss'),
        isNull,
      );
      expect(
        registeredCreature({
          'creatures': [pet()..['body'] = 'remote-url'],
        }, 'moss'),
        isNull,
      );
    },
  );
  testWidgets(
    'pet creation form is explicitly requested and new pet senses start disabled',
    (t) async {
      final lab = Lab();
      await t.pumpWidget(
        MaterialApp(
          home: Scaffold(body: CreatureRegistrySheet(client: lab.client)),
        ),
      );
      await t.pumpAndSettle();
      expect(find.byType(TextField), findsNothing);
      await click(t, 'registry-add-pet');
      expect(
        t
            .widget<FilledButton>(find.byKey(const Key('pet-create-confirm')))
            .onPressed,
        isNull,
      );
      await t.enterText(find.byKey(const Key('pet-name')), '芽芽');
      await t.pump();
      await click(t, 'pet-create-confirm');
      expect(find.byType(TextField), findsNothing);
      final pet = (lab.state['creatures'] as List).last;
      expect(pet['name'], '芽芽');
      expect(pet['id'], startsWith('pet-'));
      expect(pet['kind'], 'pet');
      expect(pet['body'], 'sprout');
      expect(pet['tone'], 'playful');
      expect(pet['senses'], {'hearing': false, 'vision': false});
      expect(lab.state['primaryCreatureId'], 'companion');
      expect(lab.state['activeCreatureId'], 'companion');
    },
  );
}
