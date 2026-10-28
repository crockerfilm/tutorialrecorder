// Tutorial Recorder — screen + mic + optional webcam bubble, composited and recorded in the browser.
// Chrome/Edge recommended: uses MediaStreamTrackProcessor/Generator so recording keeps running
// while this tab is in the background, and Document Picture-in-Picture for floating controls.

const $ = s => document.querySelector(s);
const FPS = 30;
const MAX_W = 2560; // cap output width; retina screens otherwise produce huge files

const ui = {
  mode: $('#mode'), mic: $('#micSelect'), cam: $('#camSelect'), size: $('#bubbleSize'), mock: $('#mock'), bubble: $('#bubble'), bubbleVideo: $('#bubbleVideo'), previewHint: $('#previewHint'),
  sysAudio: $('#sysAudio'), sync: $('#sync'), syncVal: $('#syncVal'), countdown: $('#countdown'), startBtn: $('#startBtn'), testBtn: $('#testBtn'),
  hint: $('#hint'), camPreview: $('#camPreview'), meter: $('#meterFill'),
  setup: $('#setup'), recording: $('#recording'), review: $('#review'),
  timer: $('#timer'), pauseBtn: $('#pauseBtn'), stopBtn: $('#stopBtn'), stage: $('#stage'),
  result: $('#result'), fileName: $('#fileName'), fileExt: $('#fileExt'), fileInfo: $('#fileInfo'),
  againBtn: $('#againBtn'), downloadBtn: $('#downloadBtn'),
  countOverlay: $('#countOverlay'), countNum: $('#countNum'), installBtn: $('#installBtn'),
};

let previewCam = null, previewMic = null, meterCtx = null;
let rec = null;     // active recording session
let pending = null; // session being set up / counting down, before recording starts
const setup = { cam: 'prompt', mic: 'prompt', camErr: null, micErr: null, screenErr: null, open: null, hasCam: null }; // checklist state
let previewGen = 0; // bumps on every preview change so stale getUserMedia results get discarded
let bubblePos = loadBubblePos(); // bubble centre as 0-1 of the frame; 0 or 1 = snug against that edge

// ---------- Device setup ----------

async function listDevices() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  const mics = devices.filter(d => d.kind === 'audioinput');
  const cams = devices.filter(d => d.kind === 'videoinput');
  const labelled = devices.some(d => d.label);
  setup.hasCam = cams.length > 0;

  const keep = (sel, v) => v != null && [...sel.options].some(o => o.value === v) ? (sel.value = v, true) : false;
  const prevMic = ui.mic.options.length > 1 ? ui.mic.value : localStorage.getItem('mic'), prevCam = ui.cam.value || localStorage.getItem('cam');
  // Before permission is granted, device ids are blank; "default" lets the browser pick (and prompt) at record time.
  ui.mic.innerHTML = '<option value="">No microphone</option>' + (labelled ? mics.map((d, i) =>
    `<option value="${d.deviceId}">${esc(d.label || 'Microphone ' + (i + 1))}</option>`).join('') : mics.length ? '<option value="default">Default microphone</option>' : '');
  ui.cam.innerHTML = cams.map((d, i) => `<option value="${d.deviceId}">${esc(d.label || 'Camera ' + (i + 1))}</option>`).join('');
  if (!keep(ui.mic, prevMic) && ui.mic.options.length > 1) ui.mic.selectedIndex = 1;
  keep(ui.cam, prevCam);
}

async function askPermission() {
  try {
    stopStream(await navigator.mediaDevices.getUserMedia({ audio: true, video: setup.hasCam !== false }));
  } catch (e) { setup.camErr = setup.micErr = e; renderChecklist(); }
  await listDevices();
  refreshPreview();
}

const camConstraints = () => ({ deviceId: ui.cam.value ? { exact: ui.cam.value } : undefined, width: { ideal: 1280 }, height: { ideal: 720 } });
const micConstraints = () => ({ deviceId: ui.mic.value === 'default' ? undefined : { exact: ui.mic.value }, echoCancellation: true, noiseSuppression: true, autoGainControl: true });

function stopPreview() {
  previewGen++;
  stopStream(previewCam); stopStream(previewMic); previewCam = previewMic = null;
  if (meterCtx) { meterCtx.close(); meterCtx = null; }
  ui.meter.style.width = '0';
}

async function refreshPreview() {
  stopPreview();
  const gen = previewGen, stale = st => gen !== previewGen && (stopStream(st), true);
  const mode = ui.mode.value;
  ui.mock.hidden = mode === 'cam'; ui.bubble.hidden = mode !== 'screen+cam'; ui.camPreview.hidden = mode !== 'cam';
  ui.previewHint.textContent = mode === 'screen+cam' ? 'Drag the bubble to where you want it on screen' : mode === 'cam' ? 'Camera preview & mic level' : 'Mic level';
  layoutBubble();
  document.querySelectorAll('.camOpt').forEach(el => el.hidden = mode === 'screen');
  document.querySelectorAll('.bubbleOpt').forEach(el => el.hidden = mode !== 'screen+cam');
  document.querySelectorAll('.screenOpt').forEach(el => el.hidden = mode === 'cam');
  localStorage.setItem('mic', ui.mic.value); localStorage.setItem('cam', ui.cam.value);

  if (mode !== 'screen') {
    try {
      const st = await navigator.mediaDevices.getUserMedia({ video: camConstraints() });
      if (stale(st)) return;
      previewCam = st; setup.camErr = null;
    } catch (e) { setup.camErr = e; }
  }
  ui.camPreview.srcObject = ui.bubbleVideo.srcObject = previewCam;
  renderChecklist();
  if (ui.mic.value) {
    try {
      const st = await navigator.mediaDevices.getUserMedia({ audio: micConstraints() });
      if (stale(st)) return;
      previewMic = st; setup.micErr = null;
      const mctx = meterCtx = new AudioContext();
      const an = mctx.createAnalyser(); an.fftSize = 512;
      mctx.createMediaStreamSource(previewMic).connect(an);
      const buf = new Float32Array(an.fftSize);
      const tick = () => {
        if (mctx.state === 'closed') return;
        an.getFloatTimeDomainData(buf);
        const rms = Math.sqrt(buf.reduce((a, v) => a + v * v, 0) / buf.length);
        ui.meter.style.width = Math.min(100, rms * 400) + '%';
        requestAnimationFrame(tick);
      };
      tick();
    } catch (e) { setup.micErr = e; }
  }
}

// ---------- Frame sources ----------
// Reads frames from a video track. Track processors keep delivering while the tab is hidden;
// the <video> fallback can stall in background tabs on some browsers.

class FrameSource {
  constructor(track) {
    this.track = track; this.frame = null; this.video = null;
    if ('MediaStreamTrackProcessor' in window) {
      this.reader = new MediaStreamTrackProcessor({ track }).readable.getReader();
      this.pump();
    } else {
      this.video = Object.assign(document.createElement('video'), { muted: true, playsInline: true, srcObject: new MediaStream([track]) });
      this.video.play().catch(() => {});
    }
  }
  async pump() {
    while (true) {
      const { value, done } = await this.reader.read().catch(() => ({ done: true }));
      if (done) break;
      if (this.closed) { value.close(); break; }
      this.frame?.close(); this.frame = value;
    }
  }
  get image() { return this.frame || (this.video?.readyState >= 2 ? this.video : null); }
  get width() { return this.frame?.displayWidth || this.video?.videoWidth || 0; }
  get height() { return this.frame?.displayHeight || this.video?.videoHeight || 0; }
  close() { this.closed = true; this.reader?.cancel(); this.frame?.close(); this.frame = null; if (this.video) this.video.srcObject = null; }
}

// A worker-based clock: main-thread timers get throttled in background tabs, worker messages don't.
function makeTicker(fps, fn) {
  const src = `let id;onmessage=e=>{clearInterval(id);if(e.data)id=setInterval(()=>postMessage(0),${1000 / fps})}`;
  const w = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
  w.onmessage = fn; w.postMessage(1);
  return () => { w.postMessage(0); w.terminate(); };
}

// ---------- Recording ----------

const TEST_SECONDS = 5;

async function start(test = false) {
  if (rec || pending) return;
  const mode = ui.mode.value;
  ui.startBtn.disabled = ui.testBtn.disabled = true; ui.hint.textContent = ''; ui.hint.className = 'hint';
  stopPreview();

  // Open the floating window first — it needs the click's user activation.
  // Camera shows in the floating window only for camera-only mode; otherwise it would be captured twice in full-screen recordings.
  const s = { mode, test, pip: null, streams: [], stopTicker: null, chunks: [], paused: false, elapsed: 0, lastResume: 0 };
  pending = s;
  const pip = s.pip = await openPip(mode === 'cam').catch(() => null);
  let phase = 'screen';
  try {
    if (mode !== 'cam') {
      const screen = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: FPS }, audio: ui.sysAudio.checked,
        selfBrowserSurface: 'exclude', surfaceSwitching: 'include', systemAudio: 'include', monitorTypeSurfaces: 'include',
      });
      s.streams.push(screen);
      s.screen = new FrameSource(screen.getVideoTracks()[0]);
      screen.getVideoTracks()[0].addEventListener('ended', () => rec === s ? stop() : pending === s && cancelPending());
      markScreenOk();
    }
    phase = 'camera';
    if (mode !== 'screen') {
      const cam = await navigator.mediaDevices.getUserMedia({ video: camConstraints() });
      s.streams.push(cam); s.cam = new FrameSource(cam.getVideoTracks()[0]);
      if (pip) pip.video.srcObject = cam;
    }
    phase = 'microphone';
    if (ui.mic.value) s.streams.push(await navigator.mediaDevices.getUserMedia({ audio: micConstraints() }));
  } catch (e) {
    if (s.cancelled) return cleanup(s); // user already cancelled; drop anything acquired since
    cancelPending();
    showStartError(e, phase);
    return;
  }
  if (s.cancelled) return cleanup(s); // cancelled while a picker/permission prompt was open

  // Output size: screen's native size (capped), or 720p for camera-only.
  await waitFor(() => (s.screen || s.cam).width > 0);
  if (s.cancelled) return cleanup(s);
  const src = s.screen || s.cam, srcW = src.width || 1920, srcH = src.height || 1080;
  const scale = Math.min(1, MAX_W / srcW);
  const W = even(mode === 'cam' ? 1280 : srcW * scale), H = even(mode === 'cam' ? 720 : srcH * scale);
  const canvas = ui.stage; canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d', { alpha: false });

  // Video output track
  let videoTrack, writer;
  if ('MediaStreamTrackGenerator' in window) {
    const gen = new MediaStreamTrackGenerator({ kind: 'video' });
    writer = gen.writable.getWriter(); videoTrack = gen;
    s.videoTrack = gen;
  } else {
    videoTrack = canvas.captureStream(FPS).getVideoTracks()[0];
  }

  // A/V sync offset (ms): negative delays video, positive delays audio. On MacBook Pros audio lands
  // ~230ms behind the camera in the recorded file (measured with synctest.html), hence the default.
  const sync = +ui.sync.value, videoDelay = Math.max(0, -sync), audioDelay = Math.max(0, sync);

  // Audio mix: mic + optional system audio
  const audioTracks = s.streams.flatMap(st => st.getAudioTracks());
  let outAudio = [];
  if (audioTracks.length) {
    s.audioCtx = new AudioContext();
    s.audioCtx.resume();
    const dest = s.audioCtx.createMediaStreamDestination();
    const delay = s.audioCtx.createDelay(1);
    delay.delayTime.value = audioDelay / 1000;
    delay.connect(dest);
    audioTracks.forEach(t => s.audioCtx.createMediaStreamSource(new MediaStream([t])).connect(delay));
    outAudio = dest.stream.getAudioTracks();
  }

  const pos = { ...bubblePos }, bubbleFrac = +ui.size.value;
  const draw = () => {
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
    if (mode === 'cam') return s.cam.image && drawCover(ctx, s.cam, 0, 0, W, H, true);
    if (s.screen.image) drawContain(ctx, s.screen, W, H);
    if (mode === 'screen+cam' && s.cam.image) drawBubble(ctx, s.cam, W, H, pos, bubbleFrac);
  };

  showView('recording');
  // Video delay: queue composited frames and always write the newest one at least videoDelay old.
  // Writes stay continuous from the start, so the delay shifts content rather than the track start.
  s.queue = [];
  s.stopTicker = makeTicker(FPS, () => {
    try { draw(); } catch { return; } // a source frame closed mid-teardown
    if (writer) {
      const now = performance.now(), q = s.queue;
      q.push({ t: now, f: new VideoFrame(canvas, { timestamp: now * 1000 }) });
      while (q.length > 1 && now - q[1].t >= videoDelay) q.shift().f.close();
      if (writer.desiredSize > 0) { const vf = new VideoFrame(q[0].f, { timestamp: now * 1000 }); writer.write(vf).catch(() => vf.close()); }
    }
    updateTimer(s);
  });

  if (ui.countdown.checked && !test) await countdown(s);
  if (s.cancelled) return;

  const mime = pickMime();
  s.mime = mime;
  try {
    s.recorder = new MediaRecorder(new MediaStream([videoTrack, ...outAudio]), {
      mimeType: mime, videoBitsPerSecond: Math.round(W * H * FPS * 0.12), audioBitsPerSecond: 160000,
    });
  } catch (e) {
    cancelPending();
    ui.hint.className = 'hint err'; ui.hint.textContent = 'This browser can\'t record video here — use an up-to-date Chrome or Edge.';
    return;
  }
  s.recorder.ondataavailable = e => e.data.size && s.chunks.push(e.data);
  s.recorder.onstop = () => finish(s);
  s.recorder.onerror = () => rec === s && stop();
  s.recorder.start(1000);
  s.lastResume = performance.now();
  pending = null; rec = s;
  if (test) makeOnce(TEST_SECONDS * 1000, () => rec === s && stop());
}

function stop() {
  const s = rec;
  if (!s) return;
  rec = null;
  if (s.recorder.state !== 'inactive') s.recorder.stop();
}

function togglePause() {
  const s = rec; if (!s) return;
  if (s.paused) { s.recorder.resume(); s.lastResume = performance.now(); }
  else { s.recorder.pause(); s.elapsed += performance.now() - s.lastResume; }
  s.paused = !s.paused;
  const label = s.paused ? 'Resume' : 'Pause';
  ui.pauseBtn.textContent = label; ui.recording.classList.toggle('paused', s.paused);
  if (s.pip) { s.pip.pause.textContent = label; s.pip.doc.body.classList.toggle('paused', s.paused); }
}

function finish(s) {
  if (rec === s) rec = null; // recorder can stop on its own (e.g. all tracks ended)
  cleanup(s);
  const blob = new Blob(s.chunks, { type: s.mime.split(';')[0] });
  const ext = s.mime.startsWith('video/mp4') ? 'mp4' : 'webm';
  const url = URL.createObjectURL(blob);
  ui.result.src = url;
  ui.fileName.value = 'Recording ' + new Date().toLocaleString('sv').slice(0, 16).replace(':', '.');
  ui.fileExt.textContent = '.' + ext;
  ui.fileInfo.textContent = `${ui.stage.width}×${ui.stage.height} · ${fmt(s.elapsed)} · ${(blob.size / 1e6).toFixed(1)} MB` +
    (ext === 'webm' ? ' · WebM (this browser can\'t record MP4 — update Chrome for MP4 output)' : '');
  ui.downloadBtn.onclick = () => {
    const a = Object.assign(document.createElement('a'), { href: url, download: `${ui.fileName.value.trim() || 'Recording'}.${ext}` });
    a.click();
  };
  $('#testReview').hidden = !s.test; $('#saveRow').hidden = $('#saveNote').hidden = s.test;
  if (s.test) ui.result.play().catch(() => {});
  showView('review');
  ui.recording.classList.remove('paused'); ui.pauseBtn.textContent = 'Pause';
}

function cleanup(s) {
  if (!s.paused && s.lastResume) s.elapsed += performance.now() - s.lastResume;
  s.stopTicker?.();
  s.queue?.forEach(x => x.f.close());
  s.screen?.close(); s.cam?.close();
  s.streams.forEach(stopStream);
  s.videoTrack?.stop();
  if (s.audioCtx?.state !== 'closed') s.audioCtx?.close();
  s.pip?.win.close();
}

function updateTimer(s) {
  if (!s.recorder) return;
  const t = s.elapsed + (s.paused ? 0 : performance.now() - s.lastResume);
  const txt = s.test ? `Test · ${Math.max(0, Math.ceil(TEST_SECONDS - t / 1000))}s left` : fmt(t);
  if (ui.timer.textContent !== txt) { ui.timer.textContent = txt; if (s.pip) s.pip.timer.textContent = txt; }
}

async function countdown(s) {
  ui.countOverlay.hidden = false;
  for (let n = 3; n > 0; n--) {
    ui.countNum.textContent = n;
    if (s.pip) s.pip.timer.textContent = `Starting in ${n}…`;
    await new Promise(r => makeOnce(1000, r));
    if (s.cancelled) break;
  }
  ui.countOverlay.hidden = true;
  if (s.pip) s.pip.timer.textContent = '00:00';
}
// one-shot timer that isn't throttled in background tabs
function makeOnce(ms, fn) { const stop = makeTicker(1000 / ms, () => { stop(); fn(); }); }

// ---------- Floating controls (Document Picture-in-Picture) ----------

async function openPip(withCam) {
  if (!('documentPictureInPicture' in window)) return null;
  const win = await documentPictureInPicture.requestWindow({ width: 260, height: withCam ? 300 : 90 });
  const doc = win.document;
  doc.head.innerHTML = `<style>
    body{margin:0;background:#111116;color:#fff;font:600 14px -apple-system,sans-serif;display:flex;flex-direction:column;height:100vh}
    video{flex:1;min-height:0;width:100%;object-fit:cover;transform:scaleX(-1);background:#000}
    .bar{display:flex;gap:8px;align-items:center;padding:10px}
    .t{flex:1;font-variant-numeric:tabular-nums;display:flex;align-items:center;gap:8px}
    .t:before{content:"";width:10px;height:10px;border-radius:50%;background:#ff3b4e}
    .paused .t:before{background:#888}
    button{font:inherit;border:0;border-radius:6px;padding:7px 12px;cursor:pointer;background:#2c2c36;color:#fff}
    button.stop{background:#ff3b4e}
  </style>`;
  doc.body.innerHTML = `${withCam ? '<video autoplay muted playsinline></video>' : ''}
    <div class="bar"><span class="t">Starting…</span><button class="pause">Pause</button><button class="stop">■ Stop</button></div>`;
  const p = { win, doc, video: doc.querySelector('video') || {}, timer: doc.querySelector('.t'), pause: doc.querySelector('.pause') };
  doc.querySelector('.stop').onclick = () => rec ? stop() : cancelPending();
  p.pause.onclick = togglePause;
  win.addEventListener('pagehide', () => { if (rec?.pip === p) rec.pip = null; });
  return p;
}

function showView(name) {
  ui.setup.hidden = name !== 'setup'; ui.recording.hidden = name !== 'recording'; ui.review.hidden = name !== 'review';
  $('#checklist').hidden = name !== 'setup';
}

// Stop pressed (or screen share ended) before recording actually started
function cancelPending() {
  const s = pending; if (!s) return;
  pending = null; s.cancelled = true;
  cleanup(s);
  ui.countOverlay.hidden = true; showView('setup'); ui.startBtn.disabled = ui.testBtn.disabled = false;
  refreshPreview();
}

// ---------- Drawing helpers ----------

function drawContain(ctx, src, W, H) {
  const s = Math.min(W / src.width, H / src.height), w = src.width * s, h = src.height * s;
  ctx.drawImage(src.image, (W - w) / 2, (H - h) / 2, w, h);
}

function drawCover(ctx, src, x, y, w, h, mirror) {
  const s = Math.max(w / src.width, h / src.height), sw = w / s, sh = h / s;
  const sx = (src.width - sw) / 2, sy = (src.height - sh) / 2;
  ctx.save();
  if (mirror) { ctx.translate(x * 2 + w, 0); ctx.scale(-1, 1); }
  ctx.drawImage(src.image, sx, sy, sw, sh, x, y, w, h);
  ctx.restore();
}

// Bubble square for a W×H frame: diameter from the size setting, centre from pos, kept inside a margin.
function bubbleRect(W, H, frac, pos) {
  const d = Math.round(Math.min(W, H) * frac * 1.6), m = Math.round(Math.min(W, H) * 0.03);
  const cx = clamp(pos.x * W, m + d / 2, W - m - d / 2), cy = clamp(pos.y * H, m + d / 2, H - m - d / 2);
  return { x: Math.round(cx - d / 2), y: Math.round(cy - d / 2), d, m };
}

function drawBubble(ctx, cam, W, H, pos, frac) {
  const { x, y, d } = bubbleRect(W, H, frac, pos);
  const cx = x + d / 2, cy = y + d / 2, r = d / 2;
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,.35)'; ctx.shadowBlur = d * 0.08;
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fillStyle = '#000'; ctx.fill();
  ctx.restore();
  ctx.save();
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.clip();
  drawCover(ctx, cam, x, y, d, d, true);
  ctx.restore();
  ctx.lineWidth = Math.max(3, d * 0.025); ctx.strokeStyle = '#fff';
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
}

// ---------- Bubble placement on the mock screen ----------

function loadBubblePos() {
  try { const p = JSON.parse(localStorage.getItem('bubblePos')); if (p && isFinite(p.x) && isFinite(p.y)) return p; } catch {}
  return { x: 1, y: 1 }; // bottom right
}

function layoutBubble() {
  const W = ui.mock.clientWidth, H = ui.mock.clientHeight;
  if (!W) return;
  const b = bubbleRect(W, H, +ui.size.value, bubblePos);
  Object.assign(ui.bubble.style, { left: b.x + 'px', top: b.y + 'px', width: b.d + 'px', height: b.d + 'px' });
}

ui.mock.addEventListener('pointerdown', e => {
  if (ui.bubble.hidden || e.button !== 0) return;
  e.preventDefault();
  ui.mock.setPointerCapture(e.pointerId); ui.mock.classList.add('dragging');
  const r = ui.mock.getBoundingClientRect(), br = ui.bubble.getBoundingClientRect();
  // Grabbing the bubble keeps the grab point under the cursor; clicking empty space jumps it there.
  const off = e.target.closest('#bubble') ? { x: e.clientX - (br.left + br.width / 2), y: e.clientY - (br.top + br.height / 2) } : { x: 0, y: 0 };
  const move = ev => {
    const want = { x: (ev.clientX - off.x - r.left) / r.width, y: (ev.clientY - off.y - r.top) / r.height };
    const b = bubbleRect(r.width, r.height, +ui.size.value, want);
    // Store edges as exactly 0/1 so a snug corner stays snug on screens with a different aspect ratio.
    const norm = (v, lo, hi, full) => v <= lo + 1 ? 0 : v >= hi - 1 ? 1 : (v + b.d / 2) / full;
    bubblePos = { x: norm(b.x, b.m, r.width - b.m - b.d, r.width), y: norm(b.y, b.m, r.height - b.m - b.d, r.height) };
    layoutBubble();
  };
  move(e);
  ui.mock.onpointermove = move;
  ui.mock.onpointerup = ui.mock.onpointercancel = () => {
    ui.mock.onpointermove = ui.mock.onpointerup = ui.mock.onpointercancel = null;
    ui.mock.classList.remove('dragging');
    localStorage.setItem('bubblePos', JSON.stringify(bubblePos));
  };
});
new ResizeObserver(layoutBubble).observe(ui.mock);
ui.size.addEventListener('change', layoutBubble);

// ---------- Setup checklist ----------
// The three things a new user needs, checked live. Kept short on purpose — extras live under Advanced.

const MAC_SETTINGS = {
  screen: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
  camera: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Camera',
  microphone: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
};
const isMac = /Mac/.test(navigator.platform);
const browserName = () => navigator.userAgentData?.brands?.some(b => b.brand === 'Microsoft Edge') ? 'Microsoft Edge' : 'Google Chrome';
const blockedBySystem = e => e && e.name === 'NotAllowedError' && /system/i.test(e.message);

async function initChecklist() {
  for (const name of ['camera', 'microphone']) {
    try {
      const st = await navigator.permissions.query({ name });
      const key = name === 'camera' ? 'cam' : 'mic';
      setup[key] = st.state;
      st.onchange = () => { setup[key] = st.state; if (st.state === 'granted') listDevices().then(refreshPreview); renderChecklist(); };
    } catch {}
  }
  renderChecklist();
}

function markScreenOk() { localStorage.setItem('screenOk', '1'); setup.screenErr = null; renderChecklist(); }

function macSteps(pane, what) {
  const app = browserName();
  return `<ol><li>Open <b>System Settings → Privacy &amp; Security → ${what}</b> (button below).</li>
    <li>Turn on <b>${app}</b>. If it isn't listed, click <b>+</b> and add it from Applications.</li>
    ${pane === 'screen' ? `<li>Quit ${app} completely (<b>⌘Q</b>) and reopen it. macOS only applies this after a restart.</li>` : ''}</ol>`;
}

function siteSteps() {
  return `<ol><li>Click the <b>settings icon</b> at the left end of the address bar.</li>
    <li>Set <b>Camera</b> and <b>Microphone</b> to <b>Allow</b>, then reload this page.</li></ol>`;
}

function checklistItems() {
  const items = [];
  const chromium = navigator.userAgentData?.brands?.some(b => /Chrome|Chromium|Edge/.test(b.brand));
  const capable = !!navigator.mediaDevices?.getDisplayMedia && 'MediaStreamTrackProcessor' in window && 'MediaStreamTrackGenerator' in window;
  const mp4 = typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported('video/mp4');

  // 1. Browser
  if (!window.isSecureContext) {
    items.push({ status: 'bad', title: 'Open the shared https:// link', body: '<p>Screen recording only works from a secure (https) address. Use the link you were sent rather than a saved file.</p>' });
  } else if (!chromium || !capable) {
    items.push({ status: 'bad', title: 'Use Google Chrome or Microsoft Edge', body: '<p>This browser can\'t record reliably. Open this page in Chrome or Edge on a computer.</p>',
      actions: [{ label: 'Copy page link', fn: e => navigator.clipboard.writeText(location.href.split('?')[0]).then(() => e.target.textContent = 'Copied ✓') }] });
  } else if (!mp4) {
    items.push({ status: 'todo', title: 'Update your browser', body: `<p>${browserName()} is out of date, so videos will save as WebM instead of MP4. Update via the ⋮ menu → Help → About, then relaunch.</p>` });
  } else {
    items.push({ status: 'ok', title: `Browser: ${browserName()}`, body: '' });
  }

  // 2. Camera & mic
  const camMicErr = setup.micErr || setup.camErr;
  if (blockedBySystem(camMicErr)) {
    const which = setup.micErr && blockedBySystem(setup.micErr) ? 'microphone' : 'camera';
    items.push({ status: 'bad', title: `macOS is blocking the ${which}`, body: macSteps(which, which === 'camera' ? 'Camera' : 'Microphone'),
      actions: [{ label: 'Open System Settings', href: MAC_SETTINGS[which] }, { label: 'Check again', fn: () => refreshPreview() }] });
  } else if (setup.cam === 'denied' || setup.mic === 'denied') {
    items.push({ status: 'bad', title: 'Camera / microphone blocked for this site', body: siteSteps(), actions: [{ label: 'Reload', fn: () => location.reload() }] });
  } else if (camMicErr?.name === 'NotReadableError') {
    items.push({ status: 'bad', title: 'Camera or mic is busy', body: '<p>Another app (Zoom, Teams, FaceTime, Photo Booth…) is using it. Close that app, then check again.</p>',
      actions: [{ label: 'Check again', fn: () => refreshPreview() }] });
  } else if (setup.mic === 'granted' && (setup.cam === 'granted' || setup.hasCam === false)) {
    items.push({ status: 'ok', title: setup.hasCam === false ? 'Microphone allowed (no camera found)' : 'Camera & microphone allowed', body: '' });
  } else {
    items.push({ status: 'todo', title: 'Allow camera & microphone', body: '<p>Your browser will ask once. Needed for narration and the camera bubble.</p>',
      actions: [{ label: 'Allow camera & mic', primary: true, fn: askPermission }] });
  }

  // 3. Test recording — also the only way to find out whether macOS allows screen capture
  if (blockedBySystem(setup.screenErr)) {
    items.push({ status: 'bad', title: 'macOS is blocking screen recording', body: macSteps('screen', isMac ? 'Screen &amp; System Audio Recording' : 'Screen Recording'),
      actions: [{ label: 'Open System Settings', href: MAC_SETTINGS.screen }, { label: 'Try the test again', fn: () => start(true) }] });
  } else if (localStorage.getItem('screenOk')) {
    items.push({ status: 'ok', title: 'Screen recording works', body: '' });
  } else {
    items.push({ status: 'todo', title: 'Make a 5-second test recording', body: '<p>Pick a screen or window in the popup and click <b>Share</b>. You\'ll get to watch it back right away.</p>',
      actions: [{ label: 'Start test', primary: true, fn: () => start(true) }] });
  }
  return items;
}

function renderChecklist() {
  const items = checklistItems(), required = items;
  const left = required.filter(i => i.status !== 'ok').length, blocked = required.some(i => i.status === 'bad');
  if (setup.open === null) setup.open = left > 0; // collapsed by default once everything's set up
  if (setup.left > 0 && left === 0) setup.open = false; // just finished setup: fold it away
  setup.left = left;
  if (left > 0 && blocked) setup.open = true;

  $('#clIcon').className = 'cl-icon ' + (left ? (blocked ? 'bad' : 'todo') : 'ok');
  $('#clIcon').textContent = left ? '!' : '✓';
  $('#clTitle').textContent = left ? (blocked ? 'Setup needs attention' : `${left} quick setup step${left > 1 ? 's' : ''} before your first recording`) : 'Ready to record';
  $('#clSub').textContent = left ? 'One-time setup — about a minute.' : 'Everything is set up on this computer.';
  $('#clToggle').textContent = setup.open ? 'Hide' : 'Setup & help';
  $('#clItems').hidden = !setup.open;

  const list = $('#clItems'); list.innerHTML = '';
  for (const it of items) {
    const li = document.createElement('li');
    li.innerHTML = `<span class="st ${it.status}">${{ ok: '✓', bad: '✕', todo: '!', info: 'i' }[it.status]}</span>
      <div><strong>${it.title}</strong>${it.body}<div class="acts"></div></div>`;
    for (const a of it.actions || []) {
      const el = a.href ? Object.assign(document.createElement('a'), { href: a.href, target: a.newTab ? '_blank' : '' }) : document.createElement('button');
      el.textContent = a.label;
      if (a.href) el.className = 'btnlink'; else { el.className = a.primary ? 'primary small' : 'ghost small'; el.onclick = a.fn; }
      li.querySelector('.acts').append(el);
    }
    list.append(li);
  }
}
$('#clToggle').onclick = () => { setup.open = !setup.open; renderChecklist(); };

function showStartError(e, phase) {
  ui.hint.className = 'hint err';
  if (phase === 'screen') {
    if (blockedBySystem(e)) { setup.screenErr = e; localStorage.removeItem('screenOk'); ui.hint.textContent = 'macOS is blocking screen recording — follow the steps in Setup above.'; }
    else if (e.name === 'NotAllowedError') { ui.hint.className = 'hint'; ui.hint.textContent = 'Recording cancelled.'; }
    else ui.hint.textContent = 'Couldn\'t start screen sharing: ' + e.message;
  } else {
    if (phase === 'camera') setup.camErr = e; else setup.micErr = e;
    ui.hint.textContent = e.name === 'NotReadableError' ? `Your ${phase} is in use by another app. Close it and try again.`
      : e.name === 'NotFoundError' || e.name === 'OverconstrainedError' ? `The selected ${phase} isn't connected. Pick another one.`
      : `Couldn't use the ${phase} — see Setup above.`;
  }
  setup.open = true; renderChecklist();
  if (ui.hint.className.includes('err')) $('#checklist').scrollIntoView({ behavior: 'smooth' });
}

// ---------- Utils ----------

function pickMime() {
  return ['video/mp4;codecs=avc1.640033,mp4a.40.2', 'video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4',
    'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'].find(m => MediaRecorder.isTypeSupported(m));
}
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const even = n => Math.round(n / 2) * 2;
const fmt = ms => { const t = Math.floor(ms / 1000); return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`; };
const esc = s => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const stopStream = st => st?.getTracks().forEach(t => t.stop());
const waitFor = (cond, ms = 5000) => new Promise(res => {
  const t0 = performance.now(), check = () => (cond() || performance.now() - t0 > ms) ? res() : setTimeout(check, 30);
  check();
});

// ---------- Wire up ----------

ui.startBtn.onclick = () => start();
ui.testBtn.onclick = () => start(true);
ui.stopBtn.onclick = () => rec ? stop() : cancelPending();
ui.pauseBtn.onclick = togglePause;
function backToSetup() {
  ui.result.pause(); URL.revokeObjectURL(ui.result.src); ui.result.removeAttribute('src');
  showView('setup'); ui.startBtn.disabled = ui.testBtn.disabled = false;
  refreshPreview();
}
ui.againBtn.onclick = backToSetup;
ui.testAdjustBtn = $('#testAdjustBtn'); ui.testAdjustBtn.onclick = backToSetup;
// Straight into the real recording; this click is the user activation the floating window needs.
$('#testGoBtn').onclick = () => { backToSetup(); start(); };
[ui.mode, ui.mic, ui.cam].forEach(el => el.onchange = refreshPreview);
for (const [k, key] of [['mode', 'mode'], ['size', 'size'], ['sync', 'avsync']]) {
  const el = ui[k], v = localStorage.getItem(key);
  if (v && (el.type === 'range' || [...el.options].some(o => o.value === v))) el.value = v;
  el.addEventListener('change', () => localStorage.setItem(key, el.value));
}
const showSync = () => ui.syncVal.textContent = ui.sync.value + ' ms';
ui.sync.addEventListener('input', showSync); showSync();
navigator.mediaDevices?.addEventListener('devicechange', listDevices);
// The mic meter's AudioContext may start suspended until the page has been clicked.
addEventListener('pointerdown', () => meterCtx?.state === 'suspended' && meterCtx.resume());
addEventListener('beforeunload', e => { if (rec || pending) e.preventDefault(); });

let installPrompt;
addEventListener('beforeinstallprompt', e => { e.preventDefault(); installPrompt = e; ui.installBtn.hidden = false; });
addEventListener('appinstalled', () => { installPrompt = null; ui.installBtn.hidden = true; });
ui.installBtn.onclick = () => installPrompt?.prompt();
initChecklist();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {}); // offline cache is a nice-to-have

if (navigator.mediaDevices) listDevices().then(refreshPreview);
