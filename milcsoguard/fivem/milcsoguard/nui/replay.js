/* MilcsoGuard POV replay recorder.
 *
 * Keeps the last N seconds of this player's game view in memory and hands them to the game server
 * when the server asks (ban or admin request). Nothing is uploaded otherwise and nothing leaves the
 * game view: no desktop, no other windows, no microphone.
 *
 * How the game view is read: FiveM's CEF exposes the game's back buffer to WebGL. A 1x1 texture
 * that receives the TEXTURE_WRAP_T sequence CLAMP_TO_EDGE -> MIRRORED_REPEAT -> REPEAT right after
 * its upload is swapped for the game frame (same hook as CfxTexture in @citizenfx/three, used by
 * screenshot-basic). The frame is drawn into a small canvas, the canvas is captured as a stream
 * and encoded to WebM by MediaRecorder.
 *
 * The recorder restarts every `segmentSeconds`, so every segment is a self-contained WebM file and
 * old segments can simply be dropped. At capture time the kept segments plus the running one are
 * sent (oldest first): at least `seconds` and at most `seconds + segmentSeconds` of video.
 *
 * This runs on the player's PC and can be blocked by a cheat. A missing replay is not proof of
 * anything, and the server never waits for it longer than its timeout.
 */
(function () {
  'use strict';

  const RESOURCE = typeof GetParentResourceName === 'function' ? GetParentResourceName() : 'milcsoguard';
  const CHUNK_CHARS = 240 * 1024;
  const R = { cfg: null, gl: null, canvas: null, stream: null, recorder: null, mime: null, segments: [], current: null, rotateTimer: 0, raf: 0, lastDraw: 0, state: 'idle', capturing: false };

  function post(endpoint, body) {
    return fetch(`https://${RESOURCE}/${endpoint}`, { method: 'POST', headers: { 'Content-Type': 'application/json; charset=UTF-8' }, body: JSON.stringify(body || {}) }).catch(() => null);
  }

  function report(state, detail) {
    R.state = state;
    post('replayStatus', { state, detail: detail ? String(detail).slice(0, 200) : '' });
  }

  function pickMime() {
    if (typeof MediaRecorder === 'undefined') return null;
    for (const m of ['video/webm;codecs=vp8', 'video/webm;codecs=vp9', 'video/webm']) {
      if (MediaRecorder.isTypeSupported(m)) return m;
    }
    return null;
  }

  // ------------------------------------------------------------------ game view -> canvas
  function compile(gl, type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('shader: ' + gl.getShaderInfoLog(s));
    return s;
  }

  function setupGameView(width, height) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    // Must stay in the layout (display:none canvases may not produce frames), but invisible.
    canvas.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;pointer-events:none;z-index:-1';
    canvas.setAttribute('aria-hidden', 'true');
    document.body.appendChild(canvas);
    const gl = canvas.getContext('webgl', { alpha: false, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: false });
    if (!gl) throw new Error('WebGL unavailable');

    const program = gl.createProgram();
    gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, 'attribute vec2 a_pos; varying vec2 v_uv; void main() { v_uv = vec2((a_pos.x + 1.0) * 0.5, (a_pos.y + 1.0) * 0.5); gl_Position = vec4(a_pos, 0.0, 1.0); }'));
    gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, 'precision mediump float; varying vec2 v_uv; uniform sampler2D u_tex; void main() { gl_FragColor = vec4(texture2D(u_tex, v_uv).rgb, 1.0); }'));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error('program: ' + gl.getProgramInfoLog(program));
    gl.useProgram(program);

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(program, 'a_pos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

    // The game texture is bottom-up like any GL texture, so v_uv needs no flip here (screenshot-basic
    // flips because it reads the pixels back with readPixels; a canvas stream does not). Verified on a
    // real client: with the flip the recording was upside down.
    // Same calls, same order as @citizenfx/three uploads a CfxTexture.
    const tex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, 1, 1, 0, gl.RGB, gl.UNSIGNED_BYTE, new Uint8Array(3));
    gl.texParameterf(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameterf(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.MIRRORED_REPEAT);
    gl.texParameterf(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
    gl.uniform1i(gl.getUniformLocation(program, 'u_tex'), 0);
    gl.viewport(0, 0, width, height);

    R.canvas = canvas;
    R.gl = gl;
  }

  function draw(ts) {
    R.raf = requestAnimationFrame(draw);
    // Draw at the recording frame rate, not the game's (saves GPU and encoder work).
    if (ts - R.lastDraw < 1000 / R.cfg.fps - 2) return;
    R.lastDraw = ts;
    R.gl.drawArrays(R.gl.TRIANGLES, 0, 6);
  }

  // ------------------------------------------------------------------ segmented recording
  function startSegment() {
    const rec = new MediaRecorder(R.stream, { mimeType: R.mime, videoBitsPerSecond: R.cfg.bitrateKbps * 1000 });
    const seg = { rec, chunks: [], startedAt: performance.now(), done: null };
    seg.done = new Promise((resolve) => {
      rec.ondataavailable = (e) => { if (e.data && e.data.size) seg.chunks.push(e.data); };
      rec.onstop = () => resolve({ blob: new Blob(seg.chunks, { type: 'video/webm' }), durationMs: Math.round(performance.now() - seg.startedAt) });
      rec.onerror = () => resolve(null);
    });
    rec.start();
    return seg;
  }

  function keepSeconds() {
    // Keep the newest completed segments that together cover at least `seconds`.
    let total = 0;
    let keep = 0;
    for (let i = R.segments.length - 1; i >= 0; i--) {
      keep++;
      total += R.segments[i].durationMs;
      if (total >= R.cfg.seconds * 1000) break;
    }
    R.segments = R.segments.slice(R.segments.length - keep);
  }

  async function rotate() {
    if (R.capturing || !R.current) return;
    // Start the next segment before stopping the old one: no gap between files.
    const old = R.current;
    R.current = startSegment();
    old.rec.stop();
    const seg = await old.done;
    if (seg && seg.blob.size > 0) {
      R.segments.push(seg);
      keepSeconds();
    }
  }

  function start(cfg) {
    if (R.state === 'recording') return;
    R.cfg = cfg;
    try {
      R.mime = pickMime();
      if (!R.mime || !HTMLCanvasElement.prototype.captureStream) return report('unsupported', 'MediaRecorder/captureStream missing');
      setupGameView(cfg.width, cfg.height);
      R.raf = requestAnimationFrame(draw);
      R.stream = R.canvas.captureStream(cfg.fps);
      R.current = startSegment();
      R.rotateTimer = setInterval(() => { rotate().catch(() => undefined); }, cfg.segmentSeconds * 1000);
      report('recording', `${cfg.width}x${cfg.height}@${cfg.fps} ${R.mime}`);
    } catch (e) {
      report('error', e && e.message);
    }
  }

  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result).slice(String(fr.result).indexOf(',') + 1));
      fr.onerror = () => reject(fr.error);
      fr.readAsDataURL(blob);
    });
  }

  /** Freezes the buffer, sends it to the game server in chunks, then keeps recording. */
  async function capture(id) {
    if (R.state !== 'recording' || !R.current) {
      post('replayDone', { id, manifest: { parts: [], error: `recorder ${R.state}` } });
      return;
    }
    if (R.capturing) return;
    R.capturing = true;
    const running = R.current;
    R.current = null;
    running.rec.stop();
    const last = await running.done;
    const segments = R.segments.concat(last && last.blob.size ? [last] : []);
    R.segments = [];
    R.current = startSegment();
    R.capturing = false;

    const manifest = { parts: [], width: R.cfg.width, height: R.cfg.height, fps: R.cfg.fps };
    for (let idx = 0; idx < segments.length; idx++) {
      const b64 = await blobToBase64(segments[idx].blob);
      const chunks = Math.max(1, Math.ceil(b64.length / CHUNK_CHARS));
      manifest.parts.push({ chunks, durationMs: segments[idx].durationMs });
      for (let seq = 0; seq < chunks; seq++) {
        await post('replayChunk', { id, part: idx, seq, data: b64.slice(seq * CHUNK_CHARS, (seq + 1) * CHUNK_CHARS) });
      }
    }
    if (!manifest.parts.length) manifest.error = 'empty buffer';
    post('replayDone', { id, manifest });
  }

  window.addEventListener('message', (ev) => {
    const m = ev.data || {};
    if (m.type === 'replay:config' && m.config) start(m.config);
    else if (m.type === 'replay:capture' && typeof m.id === 'string') capture(m.id).catch((e) => post('replayDone', { id: m.id, manifest: { parts: [], error: String(e && e.message) } }));
  });

  // The config may have been sent before this page loaded.
  post('replayHello', {});

  window.MG_REPLAY = R; // for tests / debugging
})();
