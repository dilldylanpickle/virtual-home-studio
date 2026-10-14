/** Offline tempo analysis off the main thread: one request per loaded record. */
import { analyzeTempo } from './tempo-analysis.js';

self.onmessage = ({ data }) => {
  const { id, mono, sampleRate } = data;
  try { self.postMessage({ id, result: analyzeTempo(mono, sampleRate) }); }
  catch (error) { self.postMessage({ id, error: String(error?.message ?? error) }); }
};
