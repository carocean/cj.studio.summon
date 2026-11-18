import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalVoice, validateVoiceWav } from '../src/local-voice.js';
function wav() {
 const b = Buffer.alloc(44 + 3200); b.write('RIFF'); b.writeUInt32LE(b.length - 8, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(16000, 24); b.writeUInt32LE(32000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(3200, 40); return b;
}
async function setup(t, timeoutMs = 3000) {
 const root = await mkdtemp(join(tmpdir(), 'voice-test-'));
 t.after(() => rm(root, { recursive: true, force: true }));
 const script = join(root, 'mock.mjs');
 await writeFile(script, `import{writeFileSync}from'node:fs';let raw='';process.stdin.on('data',d=>raw+=d);process.stdin.on('end',()=>{const {text}=JSON.parse(raw);const out=process.argv[process.argv.indexOf('--output')+1];const root=process.argv[process.argv.indexOf('--model-dir')+1];if(process.env.SECRET_VOICE_TEST)process.exit(9);if(text==='hang'){writeFileSync(root+'/pid',String(process.pid));setInterval(()=>{},1000);return;}if(text==='flood'){process.stdout.write(Buffer.alloc(8192));setInterval(()=>{},1000);return;}if(text==='fail'){writeFileSync(out,'partial',{mode:0o600});process.exit(2);}let b=Buffer.from('${wav().toString('base64')}','base64');if(text==='bad')b[0]=0;if(text==='oversize')b=Buffer.alloc(2097153);writeFileSync(out,b,{mode:0o600});});`);
 return { root, voice: new LocalVoice({ python: process.execPath, script, modelDir: root, scratch: root, timeoutMs }) };
}
async function clean(root) { assert.equal((await readdir(root)).filter(s => s.startsWith('summon-voice-')).length, 0); }
async function waitPid(root) { for(let i=0;i<100;i++){try{return Number(await readFile(join(root,'pid'),'utf8'));}catch{await new Promise(r=>setTimeout(r,10));}}throw Error('no pid'); }
test('private valid WAV and minimal subprocess env; successful cleanup', async t => {
 const {root,voice}=await setup(t); process.env.SECRET_VOICE_TEST='do-not-inherit'; t.after(()=>delete process.env.SECRET_VOICE_TEST);
 const r=await voice.synthesize({text:'你好'}); assert.equal(r.realProcessing,true); assert.equal(r.durationSeconds,0.1); assert.equal(r.mimeType,'audio/wav'); await clean(root);
});
test('input schema, bounds and pre-abort are rejected before spawn', async t => {
 const {root,voice}=await setup(t);
 for(const input of [{text:''},{text:'a'.repeat(601)},{text:'x',path:'/tmp/a'},{text:'a\0b'},{text:'a',signal:{}}]) await assert.rejects(voice.synthesize(input),{code:'invalid_voice_input'});
 await assert.rejects(voice.synthesize({text:'a',signal:AbortSignal.abort()}),{code:'voice_cancelled'}); await clean(root);
});
test('abort kills/reaps, rejects concurrency, cleans before reuse', async t => {
 const {root,voice}=await setup(t); const c=new AbortController(); const pending=voice.synthesize({text:'hang',signal:c.signal}); const checked=assert.rejects(pending,{code:'voice_cancelled'}); const pid=await waitPid(root);
 await assert.rejects(new LocalVoice({modelDir:root}).synthesize({text:'other instance'}),{code:'voice_busy'});
 await assert.rejects(voice.synthesize({text:'second'}),{code:'voice_busy'}); c.abort(); await checked;
 assert.throws(()=>process.kill(pid,0),{code:'ESRCH'}); await clean(root); await voice.synthesize({text:'retry'});
});
test('timeout kills/reaps before settling and cleans files', async t => {
 const {root,voice}=await setup(t,250); const pending=voice.synthesize({text:'hang'}); const checked=assert.rejects(pending,{code:'voice_timeout'}); const pid=await waitPid(root); await checked; assert.throws(()=>process.kill(pid,0),{code:'ESRCH'}); await clean(root);
});
test('bad output, huge output, noisy worker, and failed worker fail closed', async t => {
 const {root,voice}=await setup(t);
 for(const text of ['bad','oversize','flood','fail']) {await assert.rejects(voice.synthesize({text}));await clean(root);}
});
test('missing executable cleans scratch', async t => {
 const {root}=await setup(t); await assert.rejects(new LocalVoice({python:'/no/voice/python',modelDir:root,scratch:root}).synthesize({text:'你好'}),{code:'voice_engine_unavailable'}); await clean(root);
});
test('WAV rejects invalid PCM, size, channels and chunk lengths', () => {
 assert.equal(validateVoiceWav(wav()).sampleRate,16000);
 for(const [offset,value] of [[20,3],[22,2],[32,4],[34,32],[16,15],[40,3199],[4,1]]) {const b=wav(); b.writeUInt16LE(value,offset); assert.throws(()=>validateVoiceWav(b));}
 assert.throws(()=>validateVoiceWav(Buffer.alloc(2097153)));
});
test('opt-in actual offline Chinese model', {skip: process.env.VOICE_REAL_TEST !== '1'}, async () => {
 const voice=new LocalVoice(); const r=await voice.synthesize({text:'你好，我可以用中文回应。'}); assert.equal(r.realProcessing,true); assert.ok(r.durationSeconds>0.3); assert.equal(r.sampleRate,44100); assert.ok(r.audio.length<2097152);
});
