import {snapshot, digest} from '../../microkernel/src/canonical.js';
import {fields, deny} from '../../microkernel/src/grants.js';

// Pure synthetic focus protocol. No microphone, playback, model, IO, identity,
// permission, persistence, ordering or payment. The host must bind and commit it.
const seal = (kind, raw) => {
  const s = snapshot(kind, raw);
  if (Buffer.byteLength(s.bytes) > 32768) deny('dish_focus_size_limit');
  return s.value;
};
const id = v => typeof v === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(v);
const text = (v, n) => typeof v === 'string' && v.trim().length > 0 && [...v].length <= n && !/[\u0000-\u001f\u007f]/u.test(v);
export function compileDishCatalog(raw) {
  const c = seal('dish-catalog', raw);
  fields(c, ['schema', 'catalogId', 'items']);
  if (c.schema !== 'synthetic-dish-catalog.v1' || !id(c.catalogId) || !Array.isArray(c.items) || !c.items.length || c.items.length > 32) deny('invalid_dish_catalog');
  const seen = new Set();
  for (const d of c.items) {
    fields(d, ['dishId', 'name', 'description', 'imageRef']);
    if (!id(d.dishId) || seen.has(d.dishId) || !text(d.name, 120) || !(d.description === null || text(d.description, 2000)) || !(d.imageRef === null || id(d.imageRef))) deny('invalid_dish');
    seen.add(d.dishId);
  }
  return seal('compiled-dish-catalog', {declaration: c, catalogDigest: digest('dish-catalog', c)});
}
function catalog(raw) {
  const c = seal('compiled-dish-catalog', raw);
  fields(c, ['declaration', 'catalogDigest']);
  const expected = compileDishCatalog(c.declaration);
  if (c.catalogDigest !== expected.catalogDigest) deny('dish_catalog_digest_mismatch');
  return expected;
}
export function validateDishFocus(rawCatalog, rawState) {
  const c = catalog(rawCatalog), s = seal('dish-focus', rawState);
  fields(s, ['schema', 'taskId', 'catalogDigest', 'revision', 'lastSpeechSequence', 'dishId', 'speech', 'view', 'zoomPermille']);
  if (s.schema !== 'dish-focus.v1' || !id(s.taskId) || s.catalogDigest !== c.catalogDigest || !Number.isSafeInteger(s.revision) || s.revision < 1 || !Number.isSafeInteger(s.lastSpeechSequence) || s.lastSpeechSequence < 0) deny('invalid_dish_focus');
  const item = c.declaration.items.find(d => d.dishId === s.dishId);
  if (!(s.dishId === null || item) || !['none','details','image'].includes(s.view) || !Number.isSafeInteger(s.zoomPermille) || s.zoomPermille < 1000 || s.zoomPermille > 3000 || s.zoomPermille % 250 !== 0) deny('invalid_dish_focus');
  if (s.speech !== null) {
    fields(s.speech, ['sequence', 'phase']);
    if (!item || s.speech.sequence !== s.lastSpeechSequence || s.speech.sequence < 1 || !['playback-requested','stop-required','stopped'].includes(s.speech.phase)) deny('invalid_dish_speech');
  }
  if (!item && (s.speech !== null || s.view !== 'none' || s.lastSpeechSequence !== 0)) deny('invalid_dish_focus');
  if (item && (s.speech === null || s.lastSpeechSequence < 1)) deny('invalid_dish_focus');
  if (s.view !== 'none' && s.speech?.phase !== 'stopped') deny('invalid_dish_view');
  if (s.view === 'image' && !item?.imageRef || s.view !== 'image' && s.zoomPermille !== 1000) deny('invalid_dish_view');
  return s;
}
export function createDishFocus(rawCatalog, taskId) {
  const c = catalog(rawCatalog);
  return validateDishFocus(c, {schema:'dish-focus.v1',taskId,catalogDigest:c.catalogDigest,revision:1,lastSpeechSequence:0,dishId:null,speech:null,view:'none',zoomPermille:1000});
}
// A revision is an optimistic precondition, not an atomic transaction. A trusted
// host must re-check owner/context/authority and commit exactly once under CAS.
export function advanceDishFocus(rawCatalog, rawState, rawCommand) {
  const c = catalog(rawCatalog), s = validateDishFocus(c, rawState), cmd = seal('dish-focus-command', rawCommand);
  const shapes = {speak:['dishId'],interrupt:['speechSequence'],stopped:['speechSequence'],details:[],image:[],zoom:['direction'],hide:[]};
  if (typeof cmd.kind !== 'string' || !Object.hasOwn(shapes, cmd.kind)) deny('unsupported_dish_focus_command');
  fields(cmd, ['kind','expectedRevision',...shapes[cmd.kind]]);
  if (cmd.expectedRevision !== s.revision) deny('stale_dish_focus');
  if (s.revision === Number.MAX_SAFE_INTEGER) deny('dish_focus_revision_exhausted');
  const n = {...s, revision:s.revision+1};
  const item = c.declaration.items.find(d => d.dishId === s.dishId);
  if (cmd.kind === 'speak') {
    if (!c.declaration.items.some(d => d.dishId === cmd.dishId)) deny('unknown_dish');
    if (s.speech && s.speech.phase !== 'stopped') deny('dish_playback_not_stopped');
    if (s.lastSpeechSequence === Number.MAX_SAFE_INTEGER) deny('dish_speech_sequence_exhausted');
    n.lastSpeechSequence++; n.dishId=cmd.dishId; n.speech={sequence:n.lastSpeechSequence,phase:'playback-requested'}; n.view='none'; n.zoomPermille=1000;
  } else if (cmd.kind === 'interrupt' || cmd.kind === 'stopped') {
    if (!s.speech || cmd.speechSequence !== s.speech.sequence || s.speech.phase !== (cmd.kind === 'interrupt' ? 'playback-requested' : 'stop-required')) deny('stale_dish_speech');
    n.speech={...s.speech,phase:cmd.kind === 'interrupt' ? 'stop-required' : 'stopped'};
  } else {
    if (!item || s.speech?.phase !== 'stopped') deny('dish_playback_not_stopped');
    if (cmd.kind === 'details') {n.view='details'; n.zoomPermille=1000;}
    if (cmd.kind === 'image') {if (!item.imageRef) deny('dish_image_unavailable'); n.view='image'; n.zoomPermille=1000;}
    if (cmd.kind === 'zoom') {
      if (s.view !== 'image' || !['in','out'].includes(cmd.direction)) deny('invalid_dish_zoom');
      n.zoomPermille += cmd.direction === 'in' ? 250 : -250;
      if (n.zoomPermille < 1000 || n.zoomPermille > 3000) deny('dish_zoom_limit');
    }
    if (cmd.kind === 'hide') {n.view='none'; n.zoomPermille=1000;}
  }
  return validateDishFocus(c, n);
}
