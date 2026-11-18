"""Opt-in local Paraformer inference. No bundled media/models or network calls."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import wave

SCRIPT = Path(__file__).with_name('processor.py')

class ParaformerTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.env = {**os.environ, 'SENSE_ASR_ENGINE': 'paraformer'}
    def tearDown(self):
        self.tmp.cleanup()
    def call(self, path=None, language='zh', env=None):
        args = ['--capabilities'] if path is None else ['--modality', 'hearing', '--input', str(path), '--input-root', str(self.root), '--mime', 'audio/wav', '--language', language]
        r = subprocess.run([sys.executable, str(SCRIPT), *args], capture_output=True, env=env or self.env, timeout=30)
        return r.returncode, json.loads(r.stdout)
    def audio(self, seconds=1):
        p = self.root / 'audio.wav'
        with wave.open(str(p), 'wb') as f:
            f.setnchannels(1); f.setsampwidth(2); f.setframerate(16000)
            f.writeframes(b'\0' * int(32000 * seconds))
        return p
    def test_missing_model_unknown_engine_and_language_no_fallback(self):
        env = {**self.env, 'SENSE_PARAFORMER_MODEL': str(self.root/'missing')}
        self.assertFalse(self.call(env=env)[1]['hearing']['available'])
        p = self.audio()
        self.assertEqual(self.call(p, env=env)[1]['error'], 'speech_model_missing')
        self.assertEqual(self.call(p, language='en', env=env)[1]['error'], 'unsupported_language')
        env['SENSE_ASR_ENGINE'] = 'unknown'
        cap = self.call(env=env)[1]['hearing']
        self.assertFalse(cap['available']); self.assertEqual(cap['error'], 'unsupported_asr_engine')
        self.assertEqual(self.call(p, env=env)[1]['error'], 'unsupported_asr_engine')
    @unittest.skipUnless(os.environ.get('SENSE_PARAFORMER_MODEL'), 'requires explicit local Paraformer model')
    def test_real_silence_and_audio_limits(self):
        caps = self.call()[1]['hearing']
        self.assertTrue(caps['available']); self.assertEqual(caps['supportedLanguages'], ['zh'])
        p = self.audio()
        code, result = self.call(p)
        # Earlier unguarded inference hallucinated "嗯没有" on zero PCM. The
        # explicit host quality rule now rejects before inference, not success.
        self.assertNotEqual(code, 0); self.assertEqual(result['error'], 'silent_audio')
        self.assertFalse(result['realProcessing'])
        self.assertEqual(self.call(self.audio(16))[1]['error'], 'audio_duration_out_of_range')
        p.write_bytes(b'not audio'); self.assertEqual(self.call(p)[1]['error'], 'unsupported_audio_format')
        p.write_bytes(b'RIFF'+b'\0'*4+b'WAVEbroken'); self.assertNotEqual(self.call(p)[0], 0)
        p.write_bytes(b'x'*(4*1024*1024+1)); self.assertEqual(self.call(p)[1]['error'], 'invalid_media_size')
    @unittest.skipUnless(os.environ.get('SENSE_PARAFORMER_TEST_FIXTURES') and os.environ.get('SENSE_PARAFORMER_MODEL'), 'requires explicitly permitted external fixtures')
    def test_three_fixed_real_fixtures_uncorrected(self):
        # Fixed 16k FFmpeg pipeline differs from direct 44.1k model probe:
        # fixture 3 was 使用... in that probe, but here is 形用...; no correction.
        expected = ['使用演示地图从甲站到丙站规划和城路线', '演示地图从甲站到丙站', '形用演示地图规划从甲到丙的路线']
        source = Path(os.environ['SENSE_PARAFORMER_TEST_FIXTURES'])
        for i, text in enumerate(expected, 1):
            p = self.root / 'fixture.wav'; p.write_bytes((source/f'route-command-{i}.wav').read_bytes())
            code, result = self.call(p)
            self.assertEqual(code, 0, result); self.assertEqual(result['text'], text)
            self.assertEqual(result['model'], 'paraformer-zh-2023-03-28-int8')
            print(json.dumps({'fixture': i, 'actualText': result['text']}, ensure_ascii=False))

if __name__ == '__main__':
    unittest.main()
