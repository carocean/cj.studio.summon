import test from 'node:test';
import assert from 'node:assert/strict';
import {parseCreatureName} from '../src/spoken-creature.js';
test('spoken names use a bounded exact whole-utterance grammar, not correction or quoted instructions',()=>{
 assert.equal(parseCreatureName('切换到工作伙伴'),'工作伙伴');assert.equal(parseCreatureName('请切换到工作伙伴。'),'工作伙伴');
 assert.equal(parseCreatureName('切换到A B'),'A B','spaces inside a registered name remain literal');
 for(const text of ['不要切换到工作伙伴','他说切换到工作伙伴','如果切换到工作伙伴','“切换到工作伙伴”','切换到','切换到\n工作伙伴','切换到'+'😀'.repeat(65),null])assert.equal(parseCreatureName(text),null);
 // A compound string is never reduced to a shorter registered name.
 assert.equal(parseCreatureName('切换到工作伙伴并开户'),'工作伙伴并开户');
});
