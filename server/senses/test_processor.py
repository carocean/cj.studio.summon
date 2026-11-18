"""Offline processor smoke/limits tests; no microphone/camera or network access.
Optional real speech fixture: SENSE_TEST_AUDIO=/path/file.wav and
SENSE_TEST_LANGUAGE=zh|en. Fixture audio is never copied into the repository.
"""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import wave
from PIL import Image, ImageDraw, ImageFont

PROCESSOR = Path(__file__).with_name('processor.py')


class ProcessorTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def call(self, path, kind='vision', mime='image/png', language='en', env=None):
        result = subprocess.run([sys.executable, str(PROCESSOR), '--modality', kind,
                                 '--input', str(path), '--input-root', str(self.root),
                                 '--mime', mime, '--language', language],
                                capture_output=True, timeout=30, env=env)
        return result.returncode, json.loads(result.stdout)

    def test_real_ocr_and_type_boundary(self):
        image = Image.new('RGB', (1000, 180), 'white')
        font_path = os.environ.get('SENSE_TEST_FONT', '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf')
        ImageDraw.Draw(image).text((20, 40), 'SUMMON VISION 42', fill='black',
                                   font=ImageFont.truetype(font_path, 58))
        path = self.root / 'text.png'
        image.save(path)
        code, result = self.call(path)
        self.assertEqual(code, 0, result)
        self.assertEqual(result['text'], 'SUMMON VISION 42')
        self.assertTrue(result['realProcessing'])
        code, result = self.call(path, mime='image/jpeg')
        self.assertNotEqual(code, 0)
        self.assertEqual(result['error'], 'media_type_mismatch')

    def test_size_pixels_invalid_and_path_limits(self):
        oversized = self.root / 'large.bin'
        oversized.write_bytes(b'x' * (4 * 1024 * 1024 + 1))
        self.assertEqual(self.call(oversized)[1]['error'], 'invalid_media_size')
        malformed = self.root / 'bad.png'
        malformed.write_bytes(b'not an image')
        self.assertEqual(self.call(malformed)[1]['error'], 'invalid_image')
        pixels = self.root / 'pixels.png'
        Image.new('RGB', (4000, 2100)).save(pixels)
        self.assertNotEqual(self.call(pixels)[0], 0)
        outside = Path(self.temp.name).parent / 'definitely-not-a-summon-file'
        # The worker must fail without exposing filesystem details.
        self.assertNotEqual(self.call(outside)[0], 0)
        target = self.root / 'symlink.png'
        target.symlink_to(malformed)
        self.assertNotEqual(self.call(target)[0], 0)

    def test_no_engine_autodownload_or_language_fallback(self):
        path = self.root / 'audio.wav'
        with wave.open(str(path), 'wb') as out:
            out.setnchannels(1); out.setsampwidth(2); out.setframerate(16000)
            out.writeframes(b'\0' * 32000)
        env = dict(os.environ)
        env.pop('SENSE_VOSK_MODEL', None)
        env.pop('SENSE_VOSK_LANGUAGE', None)
        code, result = self.call(path, 'hearing', 'audio/wav', env=env)
        self.assertNotEqual(code, 0)
        self.assertIn(result['error'], ['speech_model_missing', 'speech_language_not_configured', 'speech_engine_missing'])

    @unittest.skipUnless(os.environ.get('SENSE_VOSK_MODEL'), 'configure a local Vosk model for bounded audio tests')
    def test_long_audio_is_rejected_before_recognition(self):
        path = self.root / 'long.wav'
        with wave.open(str(path), 'wb') as out:
            out.setnchannels(1); out.setsampwidth(2); out.setframerate(16000)
            out.writeframes(b'\0' * 32000 * 16)
        language = os.environ.get('SENSE_TEST_LANGUAGE', 'zh')
        code, result = self.call(path, 'hearing', 'audio/wav', language)
        self.assertNotEqual(code, 0)
        self.assertEqual(result['error'], 'audio_duration_out_of_range')

    @unittest.skipUnless(os.environ.get('SENSE_TEST_AUDIO'), 'provide a public/local permitted speech fixture')
    def test_real_speech_fixture(self):
        original = Path(os.environ['SENSE_TEST_AUDIO'])
        path = self.root / 'speech.wav'
        path.write_bytes(original.read_bytes())
        language = os.environ.get('SENSE_TEST_LANGUAGE', 'zh')
        code, result = self.call(path, 'hearing', 'audio/wav', language)
        self.assertEqual(code, 0, result)
        self.assertEqual(result['engine'], 'vosk')
        self.assertTrue(result['realProcessing'])
        self.assertTrue(result['text'])
        self.assertLessEqual(result['durationSeconds'], 15)
        if os.environ.get('SENSE_TEST_EXPECT'):
            self.assertIn(os.environ['SENSE_TEST_EXPECT'], result['text'])


if __name__ == '__main__':
    unittest.main()
