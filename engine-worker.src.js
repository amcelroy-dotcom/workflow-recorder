/* WorkFlow Recorder engine -- runs NVIDIA Parakeet on this phone in a
 * background worker (bundled with parakeet.js and ONNX Runtime Web by
 * tools/build_recorder.js). Audio comes in, text goes out; nothing is sent
 * anywhere. The model files are downloaded once from Hugging Face and kept in
 * this app's storage on the phone. */
import { fromHub } from 'parakeet.js';

let model = null;

self.onmessage = async (event) => {
  const msg = event.data || {};
  try {
    if (msg.type === 'load') {
      model = await fromHub(msg.modelKey, {
        backend: msg.backend,
        encoderQuant: msg.encoderQuant,
        decoderQuant: 'int8',
        preprocessorBackend: 'js',
        wasmPaths: msg.wasmPaths,
        progress: (p) => self.postMessage({ type: 'progress', loaded: p.loaded, total: p.total, file: p.file })
      });
      self.postMessage({ type: 'loaded' });
    } else if (msg.type === 'transcribe') {
      if (!model) throw new Error('The speech model isn\u2019t loaded.');
      const result = await model.transcribe(msg.pcm, 16000, { returnTimestamps: false, timeOffset: msg.offset || 0 });
      self.postMessage({ type: 'result', id: msg.id, text: (result && result.utterance_text) || '' });
    }
  } catch (err) {
    self.postMessage({ type: 'error', id: msg.id, message: String((err && err.message) || err) });
  }
};
