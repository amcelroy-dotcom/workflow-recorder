/* WorkFlow Recorder -- runs on the browser's audio thread.
 * Takes the microphone at whatever rate the phone uses, turns it into 16 kHz
 * mono (what the speech model expects), and sends it to the page in small
 * batches together with a loudness level for the meter. */
class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / 16000; // input samples per output sample
    this.pos = 0;                    // fractional read position into the carried input
    this.carry = new Float32Array(0);
    this.out = [];
    this.outLen = 0;
    this.levelSum = 0;
    this.levelN = 0;
    this.paused = false;
    this.port.onmessage = (e) => { if (e.data && typeof e.data.paused === 'boolean') this.paused = e.data.paused; };
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input.length || this.paused) return true;
    // Mix channels to mono
    const n = input[0].length;
    const mono = new Float32Array(n);
    for (let c = 0; c < input.length; c++) {
      const ch = input[c];
      for (let i = 0; i < n; i++) mono[i] += ch[i] / input.length;
    }
    for (let i = 0; i < n; i++) { this.levelSum += mono[i] * mono[i]; this.levelN++; }

    // Linear-interpolation resample to 16 kHz
    const buf = new Float32Array(this.carry.length + n);
    buf.set(this.carry, 0);
    buf.set(mono, this.carry.length);
    const produced = [];
    let p = this.pos;
    while (p + 1 < buf.length) {
      const i = Math.floor(p);
      const f = p - i;
      produced.push(buf[i] * (1 - f) + buf[i + 1] * f);
      p += this.ratio;
    }
    const keepFrom = Math.floor(p);
    this.carry = buf.slice(keepFrom);
    this.pos = p - keepFrom;
    if (produced.length) {
      this.out.push(Float32Array.from(produced));
      this.outLen += produced.length;
    }
    // About every 0.1 s, hand the samples and a level to the page
    if (this.outLen >= 1600) {
      const merged = new Float32Array(this.outLen);
      let o = 0;
      for (const part of this.out) { merged.set(part, o); o += part.length; }
      this.out = [];
      this.outLen = 0;
      const rms = Math.sqrt(this.levelSum / Math.max(1, this.levelN));
      this.levelSum = 0;
      this.levelN = 0;
      this.port.postMessage({ samples: merged, level: rms }, [merged.buffer]);
    }
    return true;
  }
}
registerProcessor('pcm-capture', PcmCapture);
