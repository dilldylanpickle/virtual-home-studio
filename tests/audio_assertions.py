"""Assertions against the existing browser probe, including analog filter settling."""


def wait_for_silence(page, threshold, timeout=1000):
    """Keep strict signal limits while allowing a bounded cartridge-filter tail."""
    if timeout > 1000:
        raise ValueError('Silence must settle within one second')
    page.wait_for_function(
        """threshold => {
          const analyser = window.__probe?.analyser;
          if (!analyser) return false;
          const samples = new Float32Array(analyser.fftSize);
          analyser.getFloatTimeDomainData(samples);
          const rms = Math.sqrt(samples.reduce((sum, sample) => sum + sample * sample, 0) / samples.length);
          return Number.isFinite(rms) && rms < threshold;
        }""",
        arg=threshold,
        polling=16,
        timeout=timeout,
    )
