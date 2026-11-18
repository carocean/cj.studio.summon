import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSpokenRoute } from '../src/spoken-route.js';

test('all nine synthetic node pairs parse with exact provider and no authority or instance', () => {
  const names = ['甲', '乙', '丙'], ids = ['A', 'B', 'C'];
  for (let from = 0; from < 3; from++) for (let to = 0; to < 3; to++) {
    const expected = { productId: 'demo.maps.v1', from: ids[from], to: ids[to], parser: 'finite-spoken-route.v1' };
    for (const phrase of [
      `请用演示地图从${names[from]}站到${names[to]}站规划合成路线`,
      `用演示地图伙伴从${ids[from]}到${ids[to]}查询合成路线`,
      ` 请 用 演示 地图 从 ${names[from]} 到 ${ids[to]}站 查询 合成 路线 。 `,
      `用演示地图从${ids[from]}站到${names[to]}规划合成路线.`,
    ]) assert.deepEqual(parseSpokenRoute(phrase), expected);
  }
  const value = parseSpokenRoute('请用演示地图从甲站到丙站规划合成路线');
  assert.equal(Object.isFrozen(value), true);
  assert.throws(() => { value.from = 'real-location'; }, TypeError);
  assert.deepEqual(Object.keys(value).sort(), ['from', 'parser', 'productId', 'to']);
});
test('quoted, negative, conditional, compound, real-world and ambiguous requests never infer a route', () => {
  const phrase = '请用演示地图从甲站到丙站规划合成路线';
  for (const value of [
    `“${phrase}”`, `"${phrase}"`, `网页说${phrase}`, `有人说${phrase}`, `不要${phrase}`, `别${phrase}`,
    `如果可以${phrase}`, `${phrase}如果免费`, `${phrase}然后付款`, `${phrase}并提交`, `先${phrase}`,
    `${phrase}，`, `${phrase}！`, `${phrase}？`, `${phrase}。。`, `${phrase}..`, `${phrase}。.` , `${phrase} ${phrase}`,
    '请用Google地图从甲站到丙站规划合成路线', '请用谷歌地图从甲站到丙站规划合成路线',
    '请用演示地图从北京到上海规划合成路线', '请用演示地图到丙站规划合成路线',
    '请用演示地图从甲站到乙站和丙站规划合成路线', '请用演示地图从甲站到丙站经乙站规划合成路线',
    '请用演示地图从甲站到丙站规划路线', '请用演示地图从甲站到丙站规划真实路线',
    '请用演示地图从甲站到丁站规划合成路线', '请用演示地图从a站到c站规划合成路线',
    '请用掩饰地图从甲站到丙站规划合成路线', '请用演示地图从假站到饼站规划合成路线',
    '请用演示地图从甲站到丙站规划合乘路线', '请使用演示地图从甲站到丙站规划合成路线',
    '请用演示地图从甲甲站到丙站规划合成路线', '请用演示地图从A/B到C规划合成路线',
    `${phrase}\u200b`, `${phrase}\u0000`, `${phrase}<script>submit()</script>`,
  ]) assert.equal(parseSpokenRoute(value), null, value);
});
test('invalid input and over-limit input return null without coercion or guessing', () => {
  let called = false;
  for (const value of [null, undefined, 4, [], {}, { toString() { called = true; return '用演示地图从A到B规划合成路线'; } }, '', ' '.repeat(4001), '用演示地图从A到B规划合成路线' + ' '.repeat(4000)]) assert.equal(parseSpokenRoute(value), null);
  assert.equal(called, false);
  assert.equal(parseSpokenRoute('用演示地图从A到B规划合成路线'.padEnd(4000)).to, 'B');
});

test('explicit short call grammar preserves correctly recognized entities without correcting wrong ASR words',()=>{
 assert.deepEqual(parseSpokenRoute('演示地图，从甲站到丙站。'),{productId:'demo.maps.v1',from:'A',to:'C',parser:'finite-spoken-route.v1'});
 assert.equal(parseSpokenRoute('演示地图从甲站到丙站').to,'C');
 for(const text of ['使用演示地图从甲站到丙站规划和城路线','请 有 也是 地图 从 假 占道 秉政 规划 和 成 路线','他说演示地图从甲站到丙站','不要演示地图从甲站到丙站','如果演示地图从甲站到丙站','演示地图从甲站到丙站并转账'])assert.equal(parseSpokenRoute(text),null);
});
