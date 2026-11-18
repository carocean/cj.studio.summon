import {snapshot, digest} from '../../microkernel/src/canonical.js';
import {fields, deny} from '../../microkernel/src/grants.js';

// Pure synthetic-state contract: no IO, rendering, acquisition, owner authority,
// persistence, command ledger or model interpretation. Host claims are not evidence.
export const READING_LIMITS = Object.freeze({resourceBytes: 49152, stateBytes: 4096, blocks: 64, blockScalars: 2000, totalScalars: 8000, fonts: 16});
const seal = (kind, raw, limit) => {
  const value = snapshot(kind, raw);
  if (Buffer.byteLength(value.bytes) > limit) deny('reading_size_limit');
  return value.value;
};
const identifier = value => {
  if (typeof value !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(value)) deny('invalid_reading_id');
};
const positive = n => Number.isSafeInteger(n) && n >= 1;
const scalarLength = text => [...text].length;
const styleKeys = ['background', 'fontRef', 'textScalePermille', 'flow', 'pageControls'];

function resourceDeclaration(raw) {
  const r = seal('reading-resource', raw, READING_LIMITS.resourceBytes);
  fields(r, ['schema', 'resourceId', 'provenance', 'blocks']);
  if (r.schema !== 'reading-resource.v1') deny('invalid_reading_resource');
  identifier(r.resourceId);
  fields(r.provenance, ['kind', 'referenceId']);
  if (r.provenance.kind !== 'host-declared') deny('invalid_reading_provenance');
  identifier(r.provenance.referenceId);
  if (!Array.isArray(r.blocks) || r.blocks.length < 1 || r.blocks.length > READING_LIMITS.blocks) deny('invalid_reading_blocks');
  const ids = new Set();
  let total = 0;
  for (const block of r.blocks) {
    fields(block, ['id', 'text']);
    identifier(block.id);
    if (ids.has(block.id)) deny('duplicate_reading_block');
    ids.add(block.id);
    if (typeof block.text !== 'string' || scalarLength(block.text) < 1 || scalarLength(block.text) > READING_LIMITS.blockScalars || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(block.text)) deny('invalid_reading_text');
    total += scalarLength(block.text);
  }
  if (total > READING_LIMITS.totalScalars) deny('reading_text_limit');
  return r;
}
function contentDigest(r) {
  // Identifies these exact scalar strings/order, not a source file or edition hash.
  // Provenance is a separate host claim and does not change canonical content.
  return digest('reading-content', {resourceId: r.resourceId, blocks: r.blocks});
}
export function compileReadingResource(raw) {
  const r = resourceDeclaration(raw);
  return seal('compiled-reading-resource', {
    schema: 'compiled-reading-resource.v1', resourceId: r.resourceId,
    provenance: r.provenance, blocks: r.blocks, contentDigest: contentDigest(r),
    authorityGranted: false,
  }, READING_LIMITS.resourceBytes);
}
export function validateReadingResource(raw) {
  const r = seal('compiled-reading-resource', raw, READING_LIMITS.resourceBytes);
  fields(r, ['schema', 'resourceId', 'provenance', 'blocks', 'contentDigest', 'authorityGranted']);
  if (r.schema !== 'compiled-reading-resource.v1' || r.authorityGranted !== false) deny('invalid_compiled_reading_resource');
  const expected = compileReadingResource({schema: 'reading-resource.v1', resourceId: r.resourceId, provenance: r.provenance, blocks: r.blocks});
  if (expected.contentDigest !== r.contentDigest) deny('reading_digest_mismatch');
  return expected;
}
function presentation(raw) {
  const p = seal('reading-presentation', raw, READING_LIMITS.stateBytes);
  fields(p, styleKeys);
  if (typeof p.background !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(p.background)) deny('invalid_reading_background');
  identifier(p.fontRef);
  if (!Number.isSafeInteger(p.textScalePermille) || p.textScalePermille < 800 || p.textScalePermille > 2000 || !['scroll', 'paged'].includes(p.flow) || typeof p.pageControls !== 'boolean') deny('invalid_reading_presentation');
  return p;
}
// Capability compatibility is separate from state validity. A removed font does
// not invalidate or rewrite an existing canonical anchor. IDs do not prove that
// the font is licensed, loaded, complete, or that reading is authorized.
export function validateReadingPresentationCapabilities(raw, rawCapabilities) {
  const p = presentation(raw), c = seal('reading-capabilities', rawCapabilities, READING_LIMITS.stateBytes);
  fields(c, ['installedFontIds']);
  if (!Array.isArray(c.installedFontIds) || c.installedFontIds.length > READING_LIMITS.fonts) deny('invalid_reading_capabilities');
  c.installedFontIds.forEach(identifier);
  if (new Set(c.installedFontIds).size !== c.installedFontIds.length) deny('invalid_reading_capabilities');
  if (!c.installedFontIds.includes(p.fontRef)) deny('reading_font_unavailable');
  return p;
}
function anchor(resource, raw) {
  fields(raw, ['blockId', 'scalarOffset']);
  const block = resource.blocks.find(block => block.id === raw.blockId);
  if (!block || !Number.isSafeInteger(raw.scalarOffset) || raw.scalarOffset < 0 || raw.scalarOffset > scalarLength(block.text)) deny('invalid_reading_anchor');
  // Inclusive end-of-block is valid. Scalar boundaries are NOT grapheme breaks.
  return raw;
}
export function validateReadingState(resource, raw) {
  const r = validateReadingResource(resource), s = seal('reading-state', raw, READING_LIMITS.stateBytes);
  fields(s, ['schema', 'resourceId', 'contentDigest', 'revision', 'anchor', 'presentation']);
  if (s.schema !== 'reading-state.v1' || s.resourceId !== r.resourceId || s.contentDigest !== r.contentDigest) deny('reading_resource_mismatch');
  if (!positive(s.revision)) deny('invalid_reading_revision');
  anchor(r, s.anchor); presentation(s.presentation);
  return s;
}
export function createReadingState(resource, rawPresentation, capabilities) {
  const r = validateReadingResource(resource), p = validateReadingPresentationCapabilities(rawPresentation, capabilities);
  return validateReadingState(r, {schema: 'reading-state.v1', resourceId: r.resourceId, contentDigest: r.contentDigest, revision: 1, anchor: {blockId: r.blocks[0].id, scalarOffset: 0}, presentation: p});
}
function bound(state, request) {
  if (!positive(request.expectedRevision) || request.expectedRevision !== state.revision) deny('reading_revision_conflict');
  if (state.revision === Number.MAX_SAFE_INTEGER) deny('reading_revision_exhausted');
}
export function updateReadingPresentation(resource, state, raw, capabilities) {
  const s = validateReadingState(resource, state), r = seal('reading-presentation-update', raw, READING_LIMITS.stateBytes);
  fields(r, ['expectedRevision', 'changes']); bound(s, r);
  fields(r.changes, [], styleKeys);
  if (Object.keys(r.changes).length === 0) deny('empty_reading_change');
  const next = validateReadingPresentationCapabilities({...s.presentation, ...r.changes}, capabilities);
  return validateReadingState(resource, {...s, revision: s.revision + 1, presentation: next});
}
export function updateReadingAnchor(resource, state, raw) {
  const s = validateReadingState(resource, state), r = seal('reading-anchor-update', raw, READING_LIMITS.stateBytes);
  fields(r, ['expectedRevision', 'anchor']); bound(s, r);
  return validateReadingState(resource, {...s, revision: s.revision + 1, anchor: r.anchor});
}
