/* WorkFlow Recorder audio: recording from the microphone, bringing in a file
 * shared from another app (Pixel Recorder, Files), and reading the saved audio
 * back in windows for transcription. */
import * as S from './storage.js';

export const RATE = 16000;
export const CHUNK_SAMPLES = RATE * 5; // audio is saved in 5-second pieces

function floatToInt16(f32) {
  const out = new Int16Array(f32.length);
  for (let i = 0; i < f32.length; i++) {
    const s = Math.max(-1, Math.min(1, f32[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

/**
 * One recording in progress. Audio is written to the phone every 5 seconds,
 * so if the app is closed or the phone dies, everything up to then is kept.
 */
export class Recording {
  constructor(session, { onLevel, onSaved } = {}) {
    this.session = session;
    this.onLevel = onLevel || (() => {});
    this.onSaved = onSaved || (() => {});
    this.pending = [];
    this.pendingLen = 0;
    this.chunkIndex = session.pcmChunks || 0;
    this.audioIndex = session.audioChunks || 0;
    this.writes = Promise.resolve();
    this.paused = false;
  }

  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: true }
    });
    this.ctx = new AudioContext();
    await this.ctx.audioWorklet.addModule('./recorder-worklet.js');
    this.source = this.ctx.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.ctx, 'pcm-capture');
    this.mute = this.ctx.createGain();
    this.mute.gain.value = 0;
    this.source.connect(this.node);
    this.node.connect(this.mute);
    this.mute.connect(this.ctx.destination);
    this.node.port.onmessage = (e) => this.take(e.data);
    // A compressed copy too, so the recording can be shared or kept as audio.
    try {
      const type = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : '';
      this.media = new MediaRecorder(this.stream, type ? { mimeType: type } : undefined);
      this.media.ondataavailable = (e) => {
        if (!e.data || !e.data.size) return;
        const i = this.audioIndex++;
        this.writes = this.writes.then(() => S.put('audio', e.data, [this.session.id, i]));
      };
      this.media.start(5000);
    } catch (e) {
      this.media = null;
    }
    this.track = this.stream.getAudioTracks()[0];
  }

  take(msg) {
    if (!msg || !msg.samples) return;
    this.onLevel(msg.level || 0);
    this.pending.push(msg.samples);
    this.pendingLen += msg.samples.length;
    if (this.pendingLen >= CHUNK_SAMPLES) this.flush(false);
  }

  /** Writes whole 5-second pieces (or everything, at the end) to the phone. */
  flush(all) {
    if (!this.pendingLen) return this.writes;
    const merged = new Float32Array(this.pendingLen);
    let o = 0;
    for (const p of this.pending) { merged.set(p, o); o += p.length; }
    let start = 0;
    const pieces = [];
    while (merged.length - start >= CHUNK_SAMPLES || (all && start < merged.length)) {
      const end = Math.min(merged.length, start + CHUNK_SAMPLES);
      pieces.push(merged.subarray(start, end));
      start = end;
    }
    const rest = merged.slice(start);
    this.pending = rest.length ? [rest] : [];
    this.pendingLen = rest.length;
    for (const piece of pieces) {
      const index = this.chunkIndex++;
      const int16 = floatToInt16(piece);
      this.session.pcmChunks = this.chunkIndex;
      this.session.sampleCount = (this.session.sampleCount || 0) + int16.length;
      this.session.durationSec = this.session.sampleCount / RATE;
      this.session.audioChunks = this.audioIndex;
      const snapshot = Object.assign({}, this.session);
      this.writes = this.writes.then(() => S.putPcm(this.session.id, index, int16)).then(() => S.put('sessions', snapshot)).then(() => this.onSaved(snapshot));
    }
    return this.writes;
  }

  pause() {
    this.paused = true;
    this.node.port.postMessage({ paused: true });
    if (this.media && this.media.state === 'recording') this.media.pause();
  }

  resume() {
    this.paused = false;
    this.node.port.postMessage({ paused: false });
    if (this.media && this.media.state === 'paused') this.media.resume();
  }

  get ended() {
    return !this.track || this.track.readyState === 'ended';
  }

  /** Recorded seconds so far, including what hasn't been written yet. */
  get seconds() {
    return ((this.session.sampleCount || 0) + this.pendingLen) / RATE;
  }

  async stop() {
    if (this.media && this.media.state !== 'inactive') {
      const done = new Promise((resolve) => { this.media.onstop = resolve; });
      this.media.stop();
      await done;
    }
    try { this.stream.getTracks().forEach((t) => t.stop()); } catch (e) { /* already stopped */ }
    try { await this.ctx.close(); } catch (e) { /* already closed */ }
    await this.flush(true);
    await this.writes;
    this.session.audioChunks = this.audioIndex;
    this.session.status = 'recorded';
    await S.put('sessions', this.session);
    return this.session;
  }
}

/**
 * A recording shared in from another app, or picked from Files: decoded to
 * 16 kHz mono and saved in the same 5-second pieces as a live recording.
 */
export async function importAudioFile(file, session, onProgress) {
  const progress = onProgress || (() => {});
  progress(0.05);
  const buf = await file.arrayBuffer();
  const ctx = new OfflineAudioContext(1, RATE, RATE);
  let decoded;
  try {
    decoded = await ctx.decodeAudioData(buf);
  } catch (e) {
    throw new Error('This phone couldn\u2019t open that audio file. Try sharing it from Recorder as an audio file (.m4a).');
  }
  progress(0.4);
  const channels = [];
  for (let c = 0; c < decoded.numberOfChannels; c++) channels.push(decoded.getChannelData(c));
  const len = decoded.length;
  let index = 0;
  for (let start = 0; start < len; start += CHUNK_SAMPLES, index++) {
    const end = Math.min(len, start + CHUNK_SAMPLES);
    const mono = new Float32Array(end - start);
    for (const ch of channels) for (let i = start; i < end; i++) mono[i - start] += ch[i] / channels.length;
    await S.putPcm(session.id, index, floatToInt16(mono));
    if (index % 12 === 0) progress(0.4 + 0.55 * (end / len));
  }
  await S.put('audio', file, [session.id, 0]);
  session.pcmChunks = index;
  session.audioChunks = 1;
  session.sampleCount = len;
  session.durationSec = len / RATE;
  session.status = 'recorded';
  await S.put('sessions', session);
  progress(1);
  return session;
}

/** Reads samples [from, to) of a session back as floating-point audio. */
export async function readRange(session, from, to) {
  const out = new Float32Array(Math.max(0, to - from));
  let i = Math.floor(from / CHUNK_SAMPLES);
  let pos = i * CHUNK_SAMPLES;
  while (pos < to && i < (session.pcmChunks || 0)) {
    const chunk = await S.getPcm(session.id, i);
    if (chunk) {
      const a = Math.max(from, pos);
      const b = Math.min(to, pos + chunk.length);
      for (let s = a; s < b; s++) out[s - from] = chunk[s - pos] / 0x8000;
      pos += chunk.length;
    } else {
      pos += CHUNK_SAMPLES;
    }
    i++;
  }
  return out;
}

/**
 * Where to end the next transcription window: aim for windowSec, but cut at
 * the quietest moment in the last few seconds, so no word is split in half.
 */
export async function nextCut(session, from, windowSec = 90, searchSec = 12) {
  const total = session.sampleCount || 0;
  const target = from + windowSec * RATE;
  if (target >= total) return total;
  const searchFrom = target - searchSec * RATE;
  const region = await readRange(session, searchFrom, target);
  const frame = 320; // 20 ms
  const energies = [];
  for (let f = 0; f + frame <= region.length; f += frame) {
    let e = 0;
    for (let i = f; i < f + frame; i++) e += region[i] * region[i];
    energies.push(e);
  }
  const span = 20; // 0.4 s of quiet
  let best = 0;
  let bestE = Infinity;
  for (let i = 0; i + span <= energies.length; i++) {
    let e = 0;
    for (let j = i; j < i + span; j++) e += energies[j];
    if (e < bestE) { bestE = e; best = i; }
  }
  return searchFrom + (best + span / 2) * frame;
}
