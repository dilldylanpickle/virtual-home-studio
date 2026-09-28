"""Disposable audio fixtures, independent of personal music files."""
from contextlib import contextmanager
import math
from pathlib import Path
import struct
import tempfile
import wave


@contextmanager
def generated_long_record():
    """Provide an audible 11½-minute WAV and remove it after the test run."""
    sample_rate = 24000
    second = b''.join(
        struct.pack('<h', round(9000 * math.sin(2 * math.pi * 440 * i / sample_rate)))
        for i in range(sample_rate)
    )
    with tempfile.TemporaryDirectory(prefix='turntable-fixture-') as directory:
        path = Path(directory) / 'generated-long-tone.wav'
        with wave.open(str(path), 'wb') as wav:
            wav.setparams((1, 2, sample_rate, 0, 'NONE', 'not compressed'))
            for _ in range(690):
                wav.writeframesraw(second)
        yield path
