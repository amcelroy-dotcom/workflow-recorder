/* WorkFlow Recorder: the page's side of the speech engine. */
export const MODELS = {
  'parakeet-tdt-0.6b-v2': { label: 'English', repoId: 'ysdede/parakeet-tdt-0.6b-v2-onnx' },
  'parakeet-tdt-0.6b-v3': { label: 'English + 24 more languages (Spanish, French\u2026)', repoId: 'ysdede/parakeet-tdt-0.6b-v3-onnx' }
};

// Approximate one-time downloads. "Fast" uses the phone's graphics chip and needs bigger files.
export const MODES = {
  fast: { backend: 'webgpu', encoderQuant: 'fp16', size: 'about 1.2 GB', label: 'Fast (graphics chip)' },
  compatible: { backend: 'wasm', encoderQuant: 'int8', size: 'about 650 MB', label: 'Compatible (processor)' }
};

/** Fast mode needs WebGPU with 16-bit support; otherwise use the processor. */
export async function detectMode() {
  try {
    if (!navigator.gpu) return 'compatible';
    const adapter = await navigator.gpu.requestAdapter();
    if (adapter && adapter.features && adapter.features.has('shader-f16')) return 'fast';
  } catch (e) { /* fall through */ }
  return 'compatible';
}

export async function resolveMode(pref) {
  if (pref === 'fast' || pref === 'compatible') return pref;
  return detectMode();
}

/** Is this model already on the phone (in parakeet.js's own cache)? */
export async function modelOnPhone(modelKey, mode) {
  const repoId = MODELS[modelKey].repoId;
  const want = MODES[mode].encoderQuant;
  return new Promise((resolve) => {
    let req;
    try { req = indexedDB.open('parakeet-cache-db', 1); } catch (e) { resolve(false); return; }
    req.onupgradeneeded = () => { try { req.result.createObjectStore('file-store'); } catch (e) { /* exists */ } };
    req.onerror = () => resolve(false);
    req.onsuccess = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains('file-store')) { d.close(); resolve(false); return; }
      const keysReq = d.transaction('file-store', 'readonly').objectStore('file-store').getAllKeys();
      keysReq.onsuccess = () => {
        const keys = (keysReq.result || []).map(String);
        d.close();
        resolve(keys.some((k) => k.indexOf(repoId) !== -1 && k.indexOf('encoder') !== -1 && (want === 'int8' ? k.indexOf('int8') !== -1 : k.indexOf(want) !== -1)));
      };
      keysReq.onerror = () => { d.close(); resolve(false); };
    };
  });
}

export function deleteModels() {
  return new Promise((resolve) => {
    const req = indexedDB.deleteDatabase('parakeet-cache-db');
    req.onsuccess = req.onerror = req.onblocked = () => resolve();
  });
}

/** Runs the model in a background worker. */
export class Engine {
  constructor() {
    this.worker = null;
    this.waiting = new Map();
    this.seq = 0;
  }

  load({ modelKey, mode }, onProgress) {
    const m = MODES[mode];
    this.worker = new Worker(new URL('./vendor/engine-worker.js', import.meta.url), { type: 'module' });
    return new Promise((resolve, reject) => {
      this.worker.onmessage = (e) => {
        const d = e.data || {};
        if (d.type === 'progress' && onProgress) onProgress(d);
        else if (d.type === 'loaded') { this.worker.onmessage = (ev) => this.onResult(ev.data || {}); resolve(); }
        else if (d.type === 'error') reject(new Error(d.message));
      };
      this.worker.onerror = (e) => reject(new Error(e.message || 'The speech engine couldn\u2019t start.'));
      this.worker.postMessage({
        type: 'load', modelKey, backend: m.backend, encoderQuant: m.encoderQuant,
        wasmPaths: new URL('./vendor/ort/', location.href).href
      });
    });
  }

  onResult(d) {
    const w = this.waiting.get(d.id);
    if (!w) return;
    this.waiting.delete(d.id);
    if (d.type === 'error') w.reject(new Error(d.message)); else w.resolve(d.text);
  }

  transcribe(pcm, offsetSec) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      this.worker.postMessage({ type: 'transcribe', id, pcm, offset: offsetSec }, [pcm.buffer]);
    });
  }

  terminate() {
    if (this.worker) this.worker.terminate();
    this.worker = null;
  }
}

/** For trying the app without the model: returns placeholder text. Turned on with ?engine=mock. */
export class MockEngine {
  async load(opts, onProgress) {
    for (let i = 1; i <= 4; i++) { onProgress && onProgress({ loaded: i * 25, total: 100, file: 'mock-model' }); await new Promise((r) => setTimeout(r, 40)); }
  }
  async transcribe(pcm, offsetSec) {
    await new Promise((r) => setTimeout(r, 60));
    const secs = pcm.length / 16000;
    return 'Test transcript from ' + Math.round(offsetSec) + ' to ' + Math.round(offsetSec + secs) + ' seconds. Okafur said the boces form is due Friday.';
  }
  terminate() {}
}
