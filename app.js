/* WorkFlow Recorder -- record a meeting on this phone, transcribe it on this
 * phone, and send the transcript to WorkFlow. Audio never leaves the phone. */
import * as S from './storage.js';
import { Recording, importAudioFile, readRange, nextCut, RATE } from './audio.js';
import { MODELS, MODES, resolveMode, modelOnPhone, deleteModels, Engine, MockEngine } from './engine.js';

const $ = (sel) => document.querySelector(sel);
const state = {
  pairing: null, context: null, current: null, recording: null, engine: null, engineKey: '',
  wakeLock: null, tick: null, transcribing: false, cancel: false, progress: null, notice: '', busy: ''
};
window.__recorder = state; // for the test suite

// ---------------------------------------------------------------- helpers
const pad = (n) => String(n).padStart(2, '0');
function clock(sec) {
  sec = Math.max(0, Math.round(sec || 0));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return (h ? h + ':' + pad(m) : m) + ':' + pad(sec % 60);
}
const ymd = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
const hhmm = (d) => pad(d.getHours()) + ':' + pad(d.getMinutes());
const newId = () => 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const escapeHtml = (s) => String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const STATUS = { recording: 'Recording', recorded: 'Recorded', transcribing: 'Transcribing', done: 'Transcribed', sent: 'Sent to WorkFlow', error: 'Needs attention' };

function prettyDate(s) {
  const p = String(s || '').split('-');
  if (p.length !== 3) return '';
  const d = new Date(+p[0], +p[1] - 1, +p[2]);
  const today = ymd(new Date());
  if (s === today) return 'Today';
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

function transcriptText(session) {
  return (session.transcript || []).map((t) => '[' + clock(t.start) + '] ' + t.text).join('\n\n');
}

function notice(msg) {
  state.notice = msg;
  render();
}

// Only send transcripts to a WorkFlow web app on Google's own domain.
function validWorkFlowUrl(u) {
  try {
    const url = new URL(u);
    if (url.protocol === 'https:' && url.hostname === 'script.google.com' && /\/exec$/.test(url.pathname)) return true;
    return location.hostname === 'localhost' && url.hostname === 'localhost'; // test suite only
  } catch (e) {
    return false;
  }
}

// ---------------------------------------------------------------- links from WorkFlow
// WorkFlow opens the Recorder with #m=<meeting>&t=<title>&d=<date>&k=<pairing code>&wf=<WorkFlow address>.
async function readLink() {
  const h = new URLSearchParams(location.hash.slice(1));
  if (h.get('k') && h.get('wf') && validWorkFlowUrl(h.get('wf'))) {
    await S.put('kv', { token: h.get('k'), wf: h.get('wf') }, 'pairing');
  }
  if (h.get('m') || h.get('t')) {
    sessionStorage.setItem('wf-context', JSON.stringify({ meetingId: h.get('m') || '', title: h.get('t') || '', date: h.get('d') || '' }));
  }
  if (location.hash) history.replaceState(null, '', location.pathname + location.search);
  state.pairing = (await S.get('kv', 'pairing')) || null;
  try { state.context = JSON.parse(sessionStorage.getItem('wf-context') || 'null'); } catch (e) { state.context = null; }
}

// ---------------------------------------------------------------- keep the screen on
async function holdScreen() {
  try { if ('wakeLock' in navigator && !state.wakeLock) state.wakeLock = await navigator.wakeLock.request('screen'); } catch (e) { state.wakeLock = null; }
}
function releaseScreen() {
  try { if (state.wakeLock) state.wakeLock.release(); } catch (e) { /* released */ }
  state.wakeLock = null;
}

// ---------------------------------------------------------------- recording
async function startRecording() {
  if (state.recording || state.transcribing) return;
  const now = new Date();
  const ctx = state.context || {};
  const session = {
    id: newId(), meetingId: ctx.meetingId || '', title: ctx.title || $('#title').value.trim(),
    date: ymd(now), startTime: hhmm(now), startedAt: now.getTime(), status: 'recording', source: 'recorded',
    pcmChunks: 0, audioChunks: 0, sampleCount: 0, durationSec: 0, transcript: [], doneSamples: 0
  };
  await S.put('sessions', session);
  const rec = new Recording(session, { onLevel: showLevel });
  try {
    await rec.start();
  } catch (e) {
    await S.deleteSession(session.id);
    notice(e && e.name === 'NotAllowedError'
      ? 'WorkFlow Recorder needs the microphone. Allow it in Chrome\u2019s site settings, then try again.'
      : 'The microphone couldn\u2019t start: ' + (e.message || e));
    return;
  }
  state.recording = rec;
  state.current = session;
  state.notice = '';
  await holdScreen();
  clearInterval(state.tick);
  state.tick = setInterval(() => {
    if (!state.recording) return;
    $('#clock').textContent = clock(state.recording.seconds);
    if (state.recording.ended) stopRecording('The microphone stopped (another app may have taken it). Everything up to then is saved.');
  }, 500);
  render();
}

function togglePause() {
  const rec = state.recording;
  if (!rec) return;
  if (rec.paused) rec.resume(); else rec.pause();
  render();
}

async function stopRecording(message) {
  const rec = state.recording;
  if (!rec) return;
  state.recording = null;
  clearInterval(state.tick);
  state.busy = 'saving';
  render();
  const session = await rec.stop();
  releaseScreen();
  state.busy = '';
  state.current = session;
  state.notice = message || '';
  render();
  if (session.sampleCount < RATE) {
    notice('That recording was under a second long, so there\u2019s nothing to transcribe.');
    return;
  }
  if (await S.setting('autoTranscribe', true)) transcribe(session);
}

function showLevel(level) {
  const el = $('#level');
  if (el) el.style.transform = 'scaleX(' + Math.min(1, Math.sqrt(level) * 3).toFixed(3) + ')';
}

// ---------------------------------------------------------------- bringing in a recording
async function importFile(file) {
  if (!file || state.recording || state.transcribing) return;
  const ctx = state.context || {};
  const modified = new Date(file.lastModified || Date.now());
  const session = {
    id: newId(), meetingId: ctx.meetingId || '', title: ctx.title || file.name.replace(/\.[a-z0-9]+$/i, ''),
    date: ymd(modified), startTime: '', startedAt: Date.now(), status: 'recorded', source: 'imported',
    pcmChunks: 0, audioChunks: 0, sampleCount: 0, durationSec: 0, transcript: [], doneSamples: 0, fileName: file.name
  };
  state.current = session;
  state.busy = 'importing';
  state.progress = { label: 'Opening ' + file.name, pct: 0 };
  render();
  try {
    await importAudioFile(file, session, (p) => { state.progress = { label: 'Opening ' + file.name, pct: Math.round(p * 100) }; render(); });
    // The file's time is usually when the recording ended.
    const started = new Date(modified.getTime() - session.durationSec * 1000);
    session.date = ymd(started);
    session.startTime = hhmm(started);
    await S.put('sessions', session);
    state.busy = '';
    state.progress = null;
    render();
    if (await S.setting('autoTranscribe', true)) transcribe(session);
  } catch (e) {
    await S.deleteSession(session.id);
    state.current = null;
    state.busy = '';
    state.progress = null;
    notice(e.message || String(e));
  }
}

// ---------------------------------------------------------------- transcription
async function ensureEngine() {
  const modelKey = await S.setting('model', 'parakeet-tdt-0.6b-v2');
  const pref = await S.setting('mode', 'auto');
  let mode = await resolveMode(pref);
  const mock = new URLSearchParams(location.search).get('engine') === 'mock' || (await S.setting('engine', '')) === 'mock';
  if (state.engine && state.engineKey === modelKey + '|' + mode + (mock ? '|mock' : '')) return;
  if (state.engine) state.engine.terminate();
  state.engine = null;
  const onDisk = mock || (await modelOnPhone(modelKey, mode));
  if (!onDisk && navigator.connection && navigator.connection.type === 'cellular' &&
      !confirm('The speech model is a one-time download of ' + MODES[mode].size + '. You\u2019re on cellular data. Download now?')) {
    throw new Error('Waiting for Wi-Fi to download the speech model. Tap Transcribe when you\u2019re on Wi-Fi.');
  }
  if (!onDisk) { try { await navigator.storage.persist(); } catch (e) { /* not supported */ } }
  const label = onDisk ? 'Starting the speech engine' : 'Downloading the speech model (one time, ' + MODES[mode].size + ')';
  const onProgress = (p) => {
    state.progress = { label, pct: p.total ? Math.round(p.loaded / p.total * 100) : null, detail: p.total ? Math.round(p.loaded / 1048576) + ' of ' + Math.round(p.total / 1048576) + ' MB' + (p.file ? ' (' + String(p.file).replace(/\.onnx.*$/, '') + ')' : '') : '' };
    render();
  };
  state.progress = { label, pct: null };
  render();
  let engine = mock ? new MockEngine() : new Engine();
  try {
    await engine.load({ modelKey, mode }, onProgress);
  } catch (e) {
    engine.terminate();
    if (mock || mode !== 'fast' || pref === 'fast') throw new Error('The speech model couldn\u2019t load: ' + (e.message || e));
    // Fast mode didn't work on this phone: fall back to the processor.
    mode = 'compatible';
    engine = new Engine();
    await engine.load({ modelKey, mode }, onProgress);
  }
  state.engine = engine;
  state.engineKey = modelKey + '|' + mode + (mock ? '|mock' : '');
  state.engineLabel = MODELS[modelKey].label + ', ' + MODES[mode].label.toLowerCase();
}

async function transcribe(session) {
  if (state.transcribing || !session) return;
  state.transcribing = true;
  state.cancel = false;
  state.current = session;
  session.status = 'transcribing';
  session.error = '';
  await S.put('sessions', session);
  await holdScreen();
  render();
  try {
    await ensureEngine();
    const startedAt = performance.now();
    let processed = 0;
    while (session.doneSamples < session.sampleCount && !state.cancel) {
      const from = session.doneSamples;
      const to = await nextCut(session, from);
      const pcm = await readRange(session, from, to);
      const text = (await state.engine.transcribe(pcm, from / RATE)).trim();
      if (text) session.transcript.push({ start: from / RATE, end: to / RATE, text });
      session.doneSamples = to;
      await S.put('sessions', session); // a crash now loses nothing already transcribed
      processed += (to - from) / RATE;
      const elapsed = (performance.now() - startedAt) / 1000;
      const remainingAudio = (session.sampleCount - session.doneSamples) / RATE;
      const eta = processed > 0 ? remainingAudio * elapsed / processed : null;
      state.progress = {
        label: 'Transcribing on this phone',
        pct: Math.round(session.doneSamples / session.sampleCount * 100),
        detail: clock(session.doneSamples / RATE) + ' of ' + clock(session.sampleCount / RATE) + (eta !== null && remainingAudio > 0 ? ', about ' + Math.max(1, Math.round(eta / 60)) + ' min left' : '')
      };
      render();
    }
    if (!state.cancel) {
      session.status = 'done';
      session.engine = state.engineLabel || '';
      if (!session.transcript.length) session.error = 'No speech was found in this recording.';
    } else {
      session.status = 'recorded';
    }
  } catch (e) {
    session.status = 'error';
    session.error = e.message || String(e);
  }
  await S.put('sessions', session);
  state.transcribing = false;
  state.progress = null;
  releaseScreen();
  render();
}

// ---------------------------------------------------------------- sending to WorkFlow
async function sendToWorkFlow(session) {
  if (!state.pairing) { notice('Open WorkFlow Recorder from a meeting in WorkFlow once (Record on this phone), so it knows where to send.'); return; }
  const text = transcriptText(session);
  if (!text) return;
  const fields = {
    action: 'recorder', k: state.pairing.token, m: session.meetingId || '', title: session.title || '',
    date: session.date || '', start: session.startTime || '', duration: String(Math.round(session.durationSec || 0)),
    engine: session.engine || '', transcript: text
  };
  // The audio stays for a few days after sending (see cleanUpSentAudio), in case the send didn't go through.
  session.status = 'sent';
  session.sentAt = Date.now();
  await S.put('sessions', session);
  const form = document.createElement('form');
  form.method = 'POST';
  form.action = state.pairing.wf;
  form.acceptCharset = 'UTF-8';
  form.style.display = 'none';
  Object.keys(fields).forEach((k) => {
    const input = document.createElement(k === 'transcript' ? 'textarea' : 'input');
    input.name = k;
    input.value = fields[k];
    form.appendChild(input);
  });
  document.body.appendChild(form);
  form.submit();
}

const KEEP_SENT_AUDIO_DAYS = 3;

/** Audio of recordings sent more than a few days ago is removed from the phone (transcripts stay). */
async function cleanUpSentAudio() {
  if (!(await S.setting('deleteAudioAfterSend', true))) return;
  const cutoff = Date.now() - KEEP_SENT_AUDIO_DAYS * 86400000;
  for (const x of await S.all('sessions')) {
    if (x.status === 'sent' && x.sentAt && x.sentAt < cutoff && !x.audioDeleted) {
      await S.deleteAudio(x.id);
      x.audioDeleted = true;
      await S.put('sessions', x);
    }
  }
}

/** File names carry the meeting, so a transcript saved to WorkFlow > Inbox in Drive lands on the right meeting. */
function fileBase(session) {
  return [(session.title || 'Recording'), session.date || '', (session.startTime || '').replace(':', '-')].filter(Boolean).join(' ')
    + (session.meetingId ? ' [WF ' + session.meetingId + ']' : '');
}

async function copyTranscript(session) {
  try { await navigator.clipboard.writeText(transcriptText(session)); notice('Transcript copied.'); }
  catch (e) { notice('Copying isn\u2019t allowed here. Use Share instead.'); }
}

async function shareTranscript(session) {
  const file = new File([transcriptText(session)], fileBase(session) + '.txt', { type: 'text/plain' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: session.title || 'Transcript' }); } catch (e) { /* cancelled */ }
  } else {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(file);
    a.download = file.name;
    a.click();
  }
}

async function shareAudio(session) {
  const blob = await S.audioBlob(session.id);
  if (!blob) { notice('The audio for this recording isn\u2019t on the phone any more.'); return; }
  const ext = /mp4|m4a|aac/.test(blob.type) ? 'm4a' : (/wav/.test(blob.type) ? 'wav' : 'webm');
  const file = new File([blob], fileBase(session) + '.' + ext, { type: blob.type || 'audio/webm' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file] }); } catch (e) { /* cancelled */ }
  } else {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(file);
    a.download = file.name;
    a.click();
  }
}

async function deleteRecording(session) {
  if (!confirm('Delete this recording and its transcript from the phone?')) return;
  await S.deleteSession(session.id);
  if (state.current && state.current.id === session.id) state.current = null;
  render();
}

// ---------------------------------------------------------------- settings
async function downloadModelNow() {
  try { await ensureEngine(); state.progress = null; notice('The speech model is on this phone. Transcription now works offline.'); }
  catch (e) { state.progress = null; notice(e.message || String(e)); }
}

async function removeModel() {
  if (!confirm('Remove the downloaded speech model? You\u2019d download it again before the next transcription.')) return;
  if (state.engine) state.engine.terminate();
  state.engine = null;
  state.engineKey = '';
  await deleteModels();
  notice('Speech model removed.');
}

// ---------------------------------------------------------------- rendering
async function render() {
  const s = state.current;
  const rec = state.recording;
  $('#pair').hidden = !!state.pairing;
  $('#paired').hidden = !state.pairing;
  $('#notice').hidden = !state.notice;
  $('#notice-text').textContent = state.notice;

  // Which meeting this is for
  const ctx = state.context;
  $('#for-meeting').hidden = !ctx;
  $('#title-field').hidden = !!ctx;
  if (ctx) {
    $('#meeting-title').textContent = ctx.title || 'Meeting';
    $('#meeting-date').textContent = ctx.date ? prettyDate(ctx.date) : '';
  }

  // Record controls
  const recording = !!rec;
  $('#record').hidden = recording || state.transcribing || !!state.busy;
  $('#recording').hidden = !recording;
  if (recording) {
    $('#rec-state').textContent = rec.paused ? 'Paused' : 'Recording';
    $('#recording').classList.toggle('paused', rec.paused);
    $('#pause').textContent = rec.paused ? 'Resume' : 'Pause';
    $('#clock').textContent = clock(rec.seconds);
  }

  // The current recording
  const card = $('#current');
  card.hidden = !s || recording;
  if (s && !recording) {
    $('#cur-title').textContent = s.title || 'Recording';
    $('#cur-meta').textContent = [prettyDate(s.date), s.startTime ? s.startTime : '', clock(s.durationSec), STATUS[s.status] || s.status].filter(Boolean).join('  \u00b7  ');
    const prog = state.progress;
    $('#progress').hidden = !prog;
    if (prog) {
      $('#progress-label').textContent = prog.label;
      $('#progress-detail').textContent = prog.detail || '';
      const bar = $('#progress-bar');
      bar.classList.toggle('indeterminate', prog.pct === null || prog.pct === undefined);
      bar.style.width = prog.pct === null || prog.pct === undefined ? '30%' : prog.pct + '%';
    }
    $('#cur-error').hidden = !s.error;
    $('#cur-error').textContent = s.error || '';
    const text = transcriptText(s);
    $('#transcript').hidden = !text;
    $('#transcript').textContent = text;
    $('#act-transcribe').hidden = state.transcribing || !!state.busy || s.status === 'done' || s.status === 'sent' || !s.sampleCount || s.audioDeleted;
    $('#act-transcribe').textContent = s.doneSamples > 0 && s.doneSamples < s.sampleCount ? 'Continue transcribing' : 'Transcribe';
    $('#act-cancel').hidden = !state.transcribing;
    const hasText = !!text && !state.transcribing;
    $('#act-send').hidden = !(hasText && (s.status === 'done' || s.status === 'sent'));
    $('#act-send').textContent = s.status === 'sent' ? 'Send to WorkFlow again' : 'Send to WorkFlow';
    $('#act-copy').hidden = !hasText;
    $('#act-share').hidden = !hasText;
    $('#act-audio').hidden = state.transcribing || s.audioDeleted || !s.audioChunks;
    $('#act-delete').hidden = state.transcribing;
    $('#sent-note').hidden = s.status !== 'sent';
  }

  // Earlier recordings
  const list = (await S.all('sessions')).filter((x) => !s || x.id !== s.id).sort((a, b) => b.startedAt - a.startedAt);
  $('#history').hidden = !list.length;
  $('#history-list').innerHTML = list.map((x) =>
    '<li><button class="row" data-open="' + x.id + '"><span class="grow"><b>' + escapeHtml(x.title || 'Recording') + '</b><span class="muted small">' +
    escapeHtml([prettyDate(x.date), x.startTime, clock(x.durationSec)].filter(Boolean).join(' \u00b7 ')) + '</span></span><span class="chip">' + escapeHtml(STATUS[x.status] || x.status) + '</span></button></li>'
  ).join('');
}

async function renderSettings() {
  const modelKey = await S.setting('model', 'parakeet-tdt-0.6b-v2');
  const pref = await S.setting('mode', 'auto');
  const mode = await resolveMode(pref);
  $('#set-model').value = modelKey;
  $('#set-mode').value = pref;
  $('#set-mode-auto').textContent = 'Automatic (this phone: ' + MODES[mode].label.toLowerCase() + ', ' + MODES[mode].size + ')';
  $('#set-delete').checked = await S.setting('deleteAudioAfterSend', true);
  $('#set-auto').checked = await S.setting('autoTranscribe', true);
  const onPhone = await modelOnPhone(modelKey, mode);
  $('#model-status').textContent = onPhone ? 'The speech model is on this phone. Transcription works offline.' : 'The speech model isn\u2019t downloaded yet (' + MODES[mode].size + ', one time). It downloads the first time you transcribe, or now:';
  $('#model-download').hidden = onPhone;
  $('#model-remove').hidden = !onPhone;
  try {
    const est = await navigator.storage.estimate();
    $('#storage').textContent = 'WorkFlow Recorder is using ' + Math.round((est.usage || 0) / 1048576) + ' MB on this phone.';
  } catch (e) { $('#storage').textContent = ''; }
}

// ---------------------------------------------------------------- start-up
async function recoverInterrupted() {
  const sessions = await S.all('sessions');
  let message = '';
  for (const x of sessions) {
    if (x.status === 'recording') {
      x.status = 'recorded';
      await S.put('sessions', x);
      state.current = x;
      message = 'A recording was interrupted. The first ' + clock(x.durationSec) + ' were saved and can be transcribed.';
    } else if (x.status === 'transcribing') {
      x.status = 'recorded';
      await S.put('sessions', x);
      state.current = state.current || x;
      message = message || 'Transcription was interrupted. Tap Continue transcribing to pick up where it stopped.';
    }
  }
  if (message) state.notice = message;
}

async function takeSharedFile() {
  if (!new URLSearchParams(location.search).has('shared')) return;
  history.replaceState(null, '', location.pathname);
  const shared = await S.get('kv', 'shared');
  await S.del('kv', 'shared');
  if (shared && shared.file) await importFile(shared.file);
  else notice('Nothing came through from the other app. Try sharing the recording again.');
}

function wire() {
  $('#record').addEventListener('click', startRecording);
  $('#pause').addEventListener('click', togglePause);
  $('#stop').addEventListener('click', () => stopRecording());
  $('#notice-close').addEventListener('click', () => notice(''));
  $('#not-this').addEventListener('click', () => { sessionStorage.removeItem('wf-context'); state.context = null; render(); });
  $('#act-transcribe').addEventListener('click', () => transcribe(state.current));
  $('#act-cancel').addEventListener('click', () => { state.cancel = true; });
  $('#act-send').addEventListener('click', () => sendToWorkFlow(state.current));
  $('#act-copy').addEventListener('click', () => copyTranscript(state.current));
  $('#act-share').addEventListener('click', () => shareTranscript(state.current));
  $('#act-audio').addEventListener('click', () => shareAudio(state.current));
  $('#act-delete').addEventListener('click', () => deleteRecording(state.current));
  $('#import').addEventListener('change', (e) => { const f = e.target.files && e.target.files[0]; e.target.value = ''; importFile(f); });
  $('#history-list').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-open]');
    if (!b || state.recording || state.transcribing) return;
    state.current = await S.get('sessions', b.getAttribute('data-open'));
    state.notice = '';
    render();
    window.scrollTo(0, 0);
  });
  $('#settings').addEventListener('toggle', (e) => { if (e.target.open) renderSettings(); });
  $('#set-model').addEventListener('change', async (e) => { await S.setSetting('model', e.target.value); renderSettings(); });
  $('#set-mode').addEventListener('change', async (e) => { await S.setSetting('mode', e.target.value); renderSettings(); });
  $('#set-delete').addEventListener('change', (e) => S.setSetting('deleteAudioAfterSend', e.target.checked));
  $('#set-auto').addEventListener('change', (e) => S.setSetting('autoTranscribe', e.target.checked));
  $('#model-download').addEventListener('click', async () => { $('#settings').open = false; await downloadModelNow(); });
  $('#model-remove').addEventListener('click', async () => { await removeModel(); renderSettings(); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (state.recording && state.recording.ended) stopRecording('Recording stopped while WorkFlow Recorder was in the background. Everything up to then is saved.');
    else if (state.recording || state.transcribing) { state.wakeLock = null; holdScreen(); }
  });
  // Tapping Record on this phone while the Recorder is already open only changes the #part of the address.
  window.addEventListener('hashchange', async () => {
    if (state.recording || state.transcribing) { history.replaceState(null, '', location.pathname + location.search); return; }
    await readLink();
    render();
  });
  window.addEventListener('beforeunload', (e) => { if (state.recording || state.transcribing) { e.preventDefault(); e.returnValue = ''; } });
}

async function main() {
  // The service worker makes the app work offline and turns on the faster multi-threaded engine.
  if ('serviceWorker' in navigator) {
    try {
      await navigator.serviceWorker.register('./sw.js');
      if (!window.crossOriginIsolated && !sessionStorage.getItem('wf-coi-reload')) {
        await navigator.serviceWorker.ready;
        if (!navigator.serviceWorker.controller || !window.crossOriginIsolated) {
          sessionStorage.setItem('wf-coi-reload', '1');
          location.reload();
          return;
        }
      }
    } catch (e) { /* works without it, just slower and not offline */ }
  }
  await readLink();
  wire();
  await recoverInterrupted();
  await cleanUpSentAudio();
  if (!state.current) {
    const latest = (await S.all('sessions')).sort((a, b) => b.startedAt - a.startedAt)[0];
    if (latest && latest.status !== 'sent') state.current = latest;
  }
  await render();
  await takeSharedFile();
  document.body.classList.add('ready');
}

main();
