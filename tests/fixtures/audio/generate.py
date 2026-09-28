"""Regenerate the original short PCM fixture using only the Python standard library."""
import math
from pathlib import Path
import struct
import wave

RATE = 24000
FRAMES = 102540  # 4.2725 seconds, including a 1.3-second quiet lead.

def generate():
    with wave.open(str(Path(__file__).with_name('short-record.wav')), 'wb') as wav:
        wav.setparams((1, 2, RATE, 0, 'NONE', 'not compressed'))
        pcm = bytearray()
        for i in range(FRAMES):
            t = i / RATE
            gain = max(0, min(1, (t - 1.3) / .02, (FRAMES / RATE - t) / .02))
            sample = gain * (7000 * math.sin(2 * math.pi * 440 * t) + 2000 * math.sin(2 * math.pi * 660 * t))
            pcm.extend(struct.pack('<h', round(sample)))
        wav.writeframes(pcm)

if __name__ == '__main__':
    generate()
