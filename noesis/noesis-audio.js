'use strict';
// Replaces the ScriptProcessorNode that SDL2's Emscripten audio backend uses
// with an AudioWorklet-backed queue.
//
// SDL2 mixes on the main thread inside `onaudioprocess`; any main-thread task
// longer than one block (image decode, transitions, GC) drops audio. Here the
// main thread mixes ahead into a queue that the audio thread drains, so short
// stalls are absorbed. No SharedArrayBuffer is needed, so this works on hosts
// that cannot send COOP/COEP headers (GitHub Pages).

(() => {
  const WORKLET_SRC = `
class NoesisPCM extends AudioWorkletProcessor {
  constructor() {
    super();
    this.q = [];
    this.off = 0;
    this.consumed = 0;
    this.underruns = 0;
    this.ticks = 0;
    this.ch = 2;
    this.primed = false;
    this.port.onmessage = (e) => {
      const d = e.data;
      if (d.pcm) this.q.push(d.pcm);
      else if (d.ch) this.ch = d.ch;
      else if (d.clear) { this.q = []; this.off = 0; this.primed = false; }
    };
  }
  process(_inputs, outputs) {
    const out = outputs[0];
    const L = out[0], R = out[1];
    const frames = L.length, ch = this.ch;
    let i = 0;
    while (i < frames && this.q.length) {
      const b = this.q[0];
      const avail = b.length / ch - this.off;
      const take = Math.min(avail, frames - i);
      let s = this.off * ch;
      for (let k = 0; k < take; k++, s += ch) {
        L[i + k] = b[s];
        if (R) R[i + k] = ch > 1 ? b[s + 1] : b[s];
      }
      i += take;
      this.off += take;
      this.consumed += take;
      if (this.off * ch >= b.length) { this.q.shift(); this.off = 0; }
    }
    if (i > 0) this.primed = true;
    if (i < frames) {
      L.fill(0, i);
      if (R) R.fill(0, i);
      if (this.primed) { this.underruns++; this.primed = false; }
    }
    if ((++this.ticks & 3) === 0) this.port.postMessage([this.consumed, this.underruns]);
    return true;
  }
}
registerProcessor('noesis-pcm', NoesisPCM);
`;

  const MIN_AHEAD_SEC = 0.12;
  const MAX_AHEAD_SEC = 0.5;

  let ctx = null;
  const NativeAudioContext = window.AudioContext || window.webkitAudioContext;

  function makeQueueNode(ctx, bufferSize, outCh) {
    const node = new AudioWorkletNode(ctx, 'noesis-pcm', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    });
    node.port.postMessage({ ch: outCh });

    const chans = Array.from({ length: outCh }, () => new Float32Array(bufferSize));
    const fakeBuffer = {
      numberOfChannels: outCh,
      length: bufferSize,
      sampleRate: ctx.sampleRate,
      duration: bufferSize / ctx.sampleRate,
      getChannelData: (c) => chans[c],
    };
    const fakeEvent = { outputBuffer: fakeBuffer };

    let sent = 0, consumed = 0, underruns = 0;
    let ahead = Math.round(MIN_AHEAD_SEC * ctx.sampleRate);
    const maxAhead = Math.round(MAX_AHEAD_SEC * ctx.sampleRate);
    let running = false, timer = 0;

    const shim = {
      onaudioprocess: null,
      bufferSize,
      connect() {
        node.connect(ctx.destination);
        running = true;
        // SDL calls connect() from inside SDL_OpenAudio; mixing must only
        // start from a fresh task, never re-entrantly while the device is
        // half-initialised.
        timer = setInterval(pump, 15);
      },
      disconnect() {
        running = false;
        clearInterval(timer);
        node.port.postMessage({ clear: true });
        try { node.disconnect(); } catch (e) { /* not connected */ }
      },
      get stats() { return { queuedMs: Math.round((sent - consumed) / ctx.sampleRate * 1000), aheadMs: Math.round(ahead / ctx.sampleRate * 1000), underruns }; },
    };

    function pump() {
      if (!running || typeof shim.onaudioprocess !== 'function') return;
      if (ctx.state !== 'running') return;
      // The worklet keeps consuming silence on underrun; never count it twice.
      if (sent < consumed) sent = consumed;
      for (let n = 0; n < 16 && sent - consumed < ahead; n++) {
        shim.onaudioprocess(fakeEvent);
        const pcm = new Float32Array(bufferSize * outCh);
        for (let c = 0; c < outCh; c++) {
          const src = chans[c];
          for (let j = 0, k = c; j < bufferSize; j++, k += outCh) pcm[k] = src[j];
        }
        node.port.postMessage({ pcm }, [pcm.buffer]);
        sent += bufferSize;
      }
    }

    node.port.onmessage = (e) => {
      const [c, u] = e.data;
      consumed = c;
      if (u > underruns) {
        underruns = u;
        // Grow the queue when this machine stalls longer than we assumed.
        ahead = Math.min(maxAhead, ahead + bufferSize);
      }
      // Worklet messages are not throttled in background tabs, timers are.
      pump();
    };

    window.noesisAudio = shim;
    return shim;
  }

  async function install() {
    if (!NativeAudioContext || !window.AudioWorkletNode) return false;
    try {
      try {
        // All game audio is 44.1 kHz; let the browser resample natively.
        ctx = new NativeAudioContext({ sampleRate: 44100, latencyHint: 'playback' });
      } catch (e) {
        ctx = new NativeAudioContext({ latencyHint: 'playback' });
      }
      const url = URL.createObjectURL(new Blob([WORKLET_SRC], { type: 'application/javascript' }));
      await ctx.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);
      ctx.resume();
    } catch (e) {
      console.warn('[noesis] AudioWorklet unavailable, using SDL default audio', e);
      if (ctx) ctx.close();
      ctx = null;
      return false;
    }

    const native = ctx.createScriptProcessor;
    ctx.createScriptProcessor = function (bufferSize, inCh, outCh) {
      if (inCh) return native.apply(ctx, arguments); // capture path, unused
      return makeQueueNode(ctx, bufferSize, outCh);
    };
    // SDL calls `new AudioContext()`; hand it the prepared context.
    const shared = function () { return ctx; };
    window.AudioContext = shared;
    if (window.webkitAudioContext) window.webkitAudioContext = shared;

    const resume = () => { if (ctx.state === 'suspended') ctx.resume(); };
    ['pointerdown', 'keydown', 'touchend'].forEach((t) => window.addEventListener(t, resume, true));
    return true;
  }

  window.NoesisAudio = { install, get context() { return ctx; } };
})();
