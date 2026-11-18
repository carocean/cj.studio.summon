import { snapshot } from '../../microkernel/src/canonical.js';

const nodes = Object.freeze({ 甲: 'A', 乙: 'B', 丙: 'C', A: 'A', B: 'B', C: 'C' });
// Finite whole-utterance grammar only, not general language understanding or ASR
// correction. The caller must restrict use to hearing, bind the provider instance,
// and independently obtain authorization/confirmation. This output grants nothing.
export function parseSpokenRoute(text) {
  if (typeof text !== 'string' || text.length > 4000) return null;
  // Spaces may separate recognized tokens; only ONE final full stop is allowed.
  // Do not strip quotes, negation, conjunctions, conditions or other punctuation.
  const normalized = text.replace(/\s+/gu, '').replace(/[。.]$/u, '');
  const match = /^(?:请)?用演示地图(?:伙伴)?从([甲乙丙ABC])(?:站)?到([甲乙丙ABC])(?:站)?(?:规划|查询)合成路线$/u.exec(normalized)
    ?? /^演示地图(?:伙伴)?[，,]?从([甲乙丙ABC])站到([甲乙丙ABC])站$/u.exec(normalized);
  if (!match) return null;
  return snapshot('spoken-route-proposal', {
    productId: 'demo.maps.v1', from: nodes[match[1]], to: nodes[match[2]], parser: 'finite-spoken-route.v1',
  }).value;
}
