# Audio fixture

`short-record.wav` is an original synthetic 4.2725-second mono PCM signal (24 kHz, 16-bit), with 1.3 seconds of silence followed by faded 440 Hz and 660 Hz tones. It contains no sampled music or third-party recording. This small fixture is bundled so the browser tests need no personal audio files.

Regenerate it with `uv run python tests/fixtures/audio/generate.py`.

Long recordings and other test tones are generated in temporary directories during tests and cleaned up automatically. Browser screenshots and JSON reports go to the ignored `artifacts/` directory.
