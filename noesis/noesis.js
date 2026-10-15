'use strict';
// Browser shell for the ONScripter-Yuri wasm build of NOeSIS01.
// Everything is relative to this page, so it works from any static host
// sub-path (e.g. https://user.github.io/repo/).

(() => {
  const GAME_DIR = '/game';
  const SAVE_DIR = '/save';
  const ASSET_BASE = 'game/';
  const ENGINE_BASE = 'engine/';
  const CACHE_NAME = 'noesis01-assets';
  // MEMFS keeps fetched files in JS memory; old ones are dropped past this.
  // Dropping is safe even while open: MEMFS streams hold their own node ref.
  const MEMFS_BUDGET = 128 * 1024 * 1024;
  const PREFETCH_CONCURRENCY = 2;
  const SCREEN_W = 800, SCREEN_H = 600;

  const $ = (id) => document.getElementById(id);
  const canvas = $('canvas');
  let manifest = null;
  let cache = null;
  let Module = null;

  // ---------------------------------------------------------------- UI utils
  function setProgress(frac, text) {
    $('load-bar').style.width = `${Math.round(frac * 100)}%`;
    if (text) $('load-text').textContent = text;
  }

  let toastTimer = 0;
  function toast(msg, ms = 3000) {
    const el = $('toast');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, ms);
  }

  const mb = (n) => (n / 1048576).toFixed(1);

  const logRing = [];
  function log(level, args) {
    logRing.push(`${level} ${Array.from(args).join(' ')}`);
    if (logRing.length > 300) logRing.shift();
  }
  window.addEventListener('error', (e) => log('E', [e.message, e.filename + ':' + e.lineno]));
  window.addEventListener('unhandledrejection', (e) => log('E', ['unhandled', e.reason && (e.reason.stack || e.reason)]));

  // Called from the engine (ONScripter.cpp) once the screen size is known.
  window.scale_full = function (el, ratio) {
    const w = window.innerWidth, h = window.innerHeight;
    const r = ratio || SCREEN_W / SCREEN_H;
    const cw = w / h > r ? h * r : w;
    el.style.width = `${Math.floor(cw)}px`;
    el.style.height = `${Math.floor(cw / r)}px`;
  };
  const fit = () => window.scale_full(canvas, SCREEN_W / SCREEN_H);
  window.addEventListener('resize', fit);
  fit();

  // ----------------------------------------------------------- asset access
  function assetURL(rel) {
    const ent = manifest.files[rel];
    return `${ASSET_BASE}${rel.split('/').map(encodeURIComponent).join('/')}?h=${ent[1]}`;
  }

  async function openCache() {
    try {
      if (!('caches' in window)) return null;
      return await caches.open(CACHE_NAME);
    } catch (e) {
      return null; // file:// or private mode
    }
  }

  const cachedKeys = new Set();
  async function scanCache() {
    if (!cache) return;
    const valid = new Set(manifest.prefetch.concat(manifest.preload).map(absURL));
    for (const req of await cache.keys()) {
      if (valid.has(req.url)) cachedKeys.add(req.url);
      else cache.delete(req); // asset from an older release
    }
  }

  const inflight = new Map();
  const warming = new Map();
  let demandCount = 0;

  async function fetchRetry(url) {
    let err;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const resp = await fetch(url);
        if (resp.ok) return resp;
        err = new Error(`HTTP ${resp.status}`);
      } catch (e) { err = e; }
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
    }
    throw err;
  }

  const absURL = (rel) => new URL(assetURL(rel), location.href).href;

  async function fetchBytes(rel, { demand = false } = {}) {
    const url = absURL(rel);
    if (inflight.has(url)) return inflight.get(url);
    const p = (async () => {
      if (demand) demandCount++;
      try {
        if (warming.has(url)) await warming.get(url).catch(() => {});
        if (cache) {
          const hit = await cache.match(url);
          if (hit) return new Uint8Array(await hit.arrayBuffer());
        }
        const resp = await fetchRetry(url);
        if (cache) {
          // clone() tees the body stream; nothing is copied on the main thread.
          cache.put(url, resp.clone()).then(() => cachedKeys.add(url), () => {});
        }
        return new Uint8Array(await resp.arrayBuffer());
      } finally {
        if (demand) demandCount--;
        inflight.delete(url);
      }
    })();
    inflight.set(url, p);
    return p;
  }

  // Background prefetch: the response body streams into Cache Storage
  // without ever being materialised in JS memory.
  function warm(rel) {
    const url = absURL(rel);
    if (cachedKeys.has(url) || inflight.has(url)) return Promise.resolve();
    if (warming.has(url)) return warming.get(url);
    const p = fetchRetry(url)
      .then((resp) => cache.put(url, resp))
      .then(() => { cachedKeys.add(url); })
      .finally(() => warming.delete(url));
    warming.set(url, p);
    return p;
  }

  // ------------------------------------------------------ MEMFS residency
  const resident = new Map(); // rel -> size, insertion order = age
  let residentBytes = 0;
  const pinned = new Set();

  function mkdirs(FS, dir) {
    let cur = '';
    for (const part of dir.split('/')) {
      if (!part) continue;
      cur += '/' + part;
      try { FS.mkdir(cur); } catch (e) { /* exists */ }
    }
  }

  function placeFile(rel, bytes) {
    const FS = Module.FS;
    const path = `${GAME_DIR}/${rel}`;
    FS.writeFile(path, bytes);
    resident.set(rel, bytes.length);
    residentBytes += bytes.length;
    for (const [old, size] of resident) {
      if (residentBytes <= MEMFS_BUDGET) break;
      if (pinned.has(old) || old === rel) continue;
      try { FS.unlink(`${GAME_DIR}/${old}`); } catch (e) { /* gone */ }
      resident.delete(old);
      residentBytes -= size;
    }
  }

  // Awaited by the engine through EM_ASYNC_JS whenever fopen() misses.
  async function noesisFetch(path) {
    if (!path.startsWith(GAME_DIR + '/')) return 0;
    const rel = path.slice(GAME_DIR.length + 1).replace(/\\/g, '/').replace(/\/+/g, '/').toLowerCase();
    if (!manifest.files[rel]) return 0;
    if (resident.has(rel)) return 1;
    try {
      const bytes = await fetchBytes(rel, { demand: true });
      if (!resident.has(rel)) placeFile(rel, bytes);
      return 1;
    } catch (e) {
      console.error('[noesis] failed to load', rel, e);
      toast(`资源加载失败：${rel}（请检查网络）`, 6000);
      return 0;
    }
  }

  // ---------------------------------------------------- background prefetch
  let prefetchStarted = false;
  async function prefetchAll() {
    if (prefetchStarted || !cache) return;
    prefetchStarted = true;
    const conn = navigator.connection;
    if (conn && conn.saveData) return;
    const queue = manifest.prefetch.filter((rel) => !cachedKeys.has(absURL(rel)));
    const worker = async () => {
      while (queue.length) {
        // On-demand loads from the engine always win the bandwidth.
        while (demandCount > 0) await new Promise((r) => setTimeout(r, 100));
        try { await warm(queue.shift()); } catch (e) { /* retried on demand */ }
      }
    };
    await Promise.all(Array.from({ length: PREFETCH_CONCURRENCY }, worker));
  }

  // ------------------------------------------------------------ save data
  let syncing = false, syncAgain = false, syncTimer = 0;

  function syncNow() {
    if (!Module) return;
    if (syncing) { syncAgain = true; return; }
    syncing = true;
    Module.FS.syncfs(false, (err) => {
      syncing = false;
      if (err) console.error('[noesis] save sync failed', err);
      if (syncAgain) { syncAgain = false; syncNow(); }
    });
  }

  function scheduleSync() {
    clearTimeout(syncTimer);
    syncTimer = setTimeout(syncNow, 300);
  }
  // The engine calls this after writing a save slot.
  window.flush_save = scheduleSync;

  function hookSaveWrites(FS) {
    // gloval.sav, kidoku.dat, envdata, NScr*log.dat are written outside
    // saveSaveFile(), so watch every writable close inside the save dir.
    const close = FS.close;
    FS.close = function (stream) {
      const writable = (stream.flags & 3) !== 0;
      const path = stream.path || '';
      const r = close.apply(this, arguments);
      if (writable && path.startsWith(SAVE_DIR + '/')) scheduleSync();
      return r;
    };
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') { clearTimeout(syncTimer); syncNow(); }
  });
  window.addEventListener('pagehide', () => { clearTimeout(syncTimer); syncNow(); });

  function listSaveFiles() {
    const FS = Module.FS;
    return FS.readdir(SAVE_DIR)
      .filter((n) => n !== '.' && n !== '..')
      .filter((n) => FS.isFile(FS.stat(`${SAVE_DIR}/${n}`).mode));
  }

  // --- minimal zip (store on write; store/deflate on read), no dependencies
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      t[i] = c >>> 0;
    }
    return t;
  })();
  function crc32(buf) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  function makeZip(entries) {
    const enc = new TextEncoder();
    const parts = [], central = [];
    let offset = 0;
    for (const { name, data } of entries) {
      const nameBytes = enc.encode(name);
      const crc = crc32(data);
      const local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, 0x04034b50, true);
      local.setUint16(4, 20, true);
      local.setUint16(6, 0x0800, true); // UTF-8 names
      local.setUint32(14, crc, true);
      local.setUint32(18, data.length, true);
      local.setUint32(22, data.length, true);
      local.setUint16(26, nameBytes.length, true);
      parts.push(new Uint8Array(local.buffer), nameBytes, data);
      const cen = new DataView(new ArrayBuffer(46));
      cen.setUint32(0, 0x02014b50, true);
      cen.setUint16(4, 20, true);
      cen.setUint16(6, 20, true);
      cen.setUint16(8, 0x0800, true);
      cen.setUint32(16, crc, true);
      cen.setUint32(20, data.length, true);
      cen.setUint32(24, data.length, true);
      cen.setUint16(28, nameBytes.length, true);
      cen.setUint32(42, offset, true);
      central.push(new Uint8Array(cen.buffer), nameBytes);
      offset += 30 + nameBytes.length + data.length;
    }
    const cenSize = central.reduce((n, a) => n + a.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, entries.length, true);
    end.setUint16(10, entries.length, true);
    end.setUint32(12, cenSize, true);
    end.setUint32(16, offset, true);
    return new Blob([...parts, ...central, new Uint8Array(end.buffer)], { type: 'application/zip' });
  }

  async function readZip(buf) {
    const u8 = new Uint8Array(buf);
    const dv = new DataView(buf);
    let eocd = -1;
    for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('不是有效的 zip 文件');
    const count = dv.getUint16(eocd + 10, true);
    let p = dv.getUint32(eocd + 16, true);
    const dec = new TextDecoder();
    const out = [];
    for (let i = 0; i < count; i++) {
      const method = dv.getUint16(p + 10, true);
      const csize = dv.getUint32(p + 20, true);
      const nlen = dv.getUint16(p + 28, true);
      const xlen = dv.getUint16(p + 30, true);
      const clen = dv.getUint16(p + 32, true);
      const lofs = dv.getUint32(p + 42, true);
      const name = dec.decode(u8.subarray(p + 46, p + 46 + nlen));
      p += 46 + nlen + xlen + clen;
      if (name.endsWith('/')) continue;
      const dataStart = lofs + 30 + dv.getUint16(lofs + 26, true) + dv.getUint16(lofs + 28, true);
      const raw = u8.subarray(dataStart, dataStart + csize);
      let data;
      if (method === 0) data = raw.slice();
      else if (method === 8) {
        const ds = new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
        data = new Uint8Array(await new Response(ds).arrayBuffer());
      } else throw new Error(`不支持的压缩方式 ${method}：${name}`);
      out.push({ name, data });
    }
    return out;
  }

  function download(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  }

  function exportSaves() {
    const files = listSaveFiles();
    if (!files.length) { toast('还没有存档'); return; }
    const entries = files.map((n) => ({ name: `save/${n}`, data: Module.FS.readFile(`${SAVE_DIR}/${n}`) }));
    const d = new Date();
    const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    download(makeZip(entries), `NOeSIS01-save-${stamp}.zip`);
  }

  const SAVE_NAME_RE = /^(save\d+\.(dat|bmp)|gloval\.sav|kidoku\.dat|envdata|nscr[fl]log\.dat)$/i;

  async function importSaves(fileList) {
    const incoming = [];
    for (const f of fileList) {
      const buf = await f.arrayBuffer();
      if (/\.zip$/i.test(f.name)) incoming.push(...await readZip(buf));
      else incoming.push({ name: f.name, data: new Uint8Array(buf) });
    }
    let n = 0;
    for (const { name, data } of incoming) {
      const base = name.split(/[\\/]/).pop();
      if (!SAVE_NAME_RE.test(base)) continue;
      Module.FS.writeFile(`${SAVE_DIR}/${base}`, data);
      n++;
    }
    if (!n) { toast('没有找到可导入的存档文件'); return; }
    await new Promise((res) => Module.FS.syncfs(false, res));
    toast(`已导入 ${n} 个文件，正在重新载入…`);
    // The engine caches global variables and read-flags at boot.
    setTimeout(() => location.reload(), 1200);
  }

  // ------------------------------------------------------------ input glue
  function sendKey(type, key, code, keyCode) {
    const ev = new KeyboardEvent(type, { key, code, bubbles: true, cancelable: true });
    // Chrome ignores keyCode in the init dict; SDL2 reads it for keycodes.
    Object.defineProperty(ev, 'keyCode', { get: () => keyCode });
    Object.defineProperty(ev, 'which', { get: () => keyCode });
    window.dispatchEvent(ev);
  }

  function tapKey(key, code, keyCode) {
    sendKey('keydown', key, code, keyCode);
    setTimeout(() => sendKey('keyup', key, code, keyCode), 60);
  }

  function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen({ navigationUI: 'hide' }).catch(() => {});
  }

  function bindUI() {
    const tb = $('toolbar');
    const more = $('more-menu');
    tb.hidden = false;

    let idleTimer = 0;
    const wake = () => {
      tb.classList.add('awake');
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => tb.classList.remove('awake'), 2500);
    };
    window.addEventListener('pointermove', wake, { passive: true });
    window.addEventListener('pointerdown', (e) => {
      if (e.pointerType !== 'mouse') wake();
      if (!more.hidden && !more.contains(e.target) && !e.target.closest('[data-act="more"]')) closeMore();
    }, true);

    const openMore = () => { more.hidden = false; tb.classList.add('menu-open'); };
    function closeMore() { more.hidden = true; tb.classList.remove('menu-open'); }

    tb.addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;
      switch (btn.dataset.act) {
        case 'menu': tapKey('Escape', 'Escape', 27); break;
        case 'fullscreen': toggleFullscreen(); break;
        case 'more': more.hidden ? openMore() : closeMore(); return;
        case 'export': closeMore(); exportSaves(); break;
        case 'import': closeMore(); $('import-input').click(); break;
      }
      btn.blur();
      canvas.focus();
    });
    $('import-input').addEventListener('change', (e) => {
      if (e.target.files.length) importSaves(e.target.files).catch((err) => toast(String(err.message || err)));
      e.target.value = '';
    });
    window.addEventListener('keydown', (e) => {
      if (e.key === 'F11') { e.preventDefault(); toggleFullscreen(); }
      if (e.key === 'Escape' && !more.hidden) { e.stopImmediatePropagation(); closeMore(); }
    }, true);
    document.addEventListener('fullscreenchange', () => {
      fit();
      document.body.classList.toggle('is-fullscreen', !!document.fullscreenElement);
    });
    wake();
  }

  // --------------------------------------------------------------- boot
  function loadScript(src) {
    return new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = res;
      s.onerror = () => rej(new Error(`无法加载 ${src}`));
      document.body.appendChild(s);
    });
  }

  async function boot() {
    const mres = await fetch('game/manifest.json', { cache: 'no-cache' });
    if (!mres.ok) throw new Error('找不到 game/manifest.json，请先运行资源处理脚本');
    manifest = await mres.json();
    cache = await openCache();
    await scanCache();

    // Preload the script and font while the engine compiles.
    const preloadTotal = manifest.preload.reduce((n, r) => n + manifest.files[r][0], 0);
    let preloadDone = 0;
    setProgress(0, '正在载入脚本与字体…');
    const preloadPromise = Promise.all(manifest.preload.map(async (rel) => {
      const bytes = await fetchBytes(rel);
      preloadDone += manifest.files[rel][0];
      setProgress(preloadDone / preloadTotal * 0.8, `正在载入脚本与字体… ${mb(preloadDone)} / ${mb(preloadTotal)} MB`);
      return [rel, bytes];
    }));

    const engineV = manifest.engine || manifest.version;
    await loadScript(`${ENGINE_BASE}onsyuri.js?v=${engineV}`);

    Module = {
      canvas,
      noesisFetch,
      locateFile: (p) => `${ENGINE_BASE}${p}?v=${engineV}`,
      print: (t) => { log('I', [t]); console.log('[ons]', t); },
      printErr: (t) => { log('W', [t]); console.warn('[ons]', t); },
      preRun: [() => {
        const FS = Module.FS;
        mkdirs(FS, GAME_DIR);
        const dirs = new Set();
        for (const rel of Object.keys(manifest.files)) {
          const i = rel.lastIndexOf('/');
          if (i > 0) dirs.add(rel.slice(0, i));
        }
        for (const d of dirs) mkdirs(FS, `${GAME_DIR}/${d}`);
        mkdirs(FS, SAVE_DIR);
        FS.mount(Module.IDBFS, {}, SAVE_DIR);
        Module.addRunDependency('noesis-save');
        FS.syncfs(true, (err) => {
          if (err) console.error('[noesis] failed to restore saves', err);
          Module.removeRunDependency('noesis-save');
        });
        hookSaveWrites(FS);
      }],
    };

    const [instance, preloaded] = await Promise.all([window.onsyuri(Module), preloadPromise]);
    Module = instance;
    for (const [rel, bytes] of preloaded) {
      pinned.add(rel);
      placeFile(rel, bytes);
    }
    setProgress(1, '准备完成');
    const btn = $('start-btn');
    btn.disabled = false;
    btn.focus();
    // A user gesture before SDL creates its AudioContext keeps audio unlocked.
    await new Promise((res) => btn.addEventListener('click', res, { once: true }));
    await start();
  }

  async function start() {
    const audio = window.NoesisAudio ? window.NoesisAudio.install() : Promise.resolve(false);
    $('start-btn').disabled = true;
    await audio;
    $('splash').remove();
    bindUI();
    fit();
    canvas.focus();
    window.addEventListener('message', (e) => {
      if (e.data === 'onsinit') prefetchAll();
    });
    setTimeout(prefetchAll, 15000); // in case the init message is missed
    Module.callMain([
      '--root', GAME_DIR,
      '--save-dir', SAVE_DIR,
      '--font', `${GAME_DIR}/default.ttf`,
    ]);
  }

  // Diagnostics for bug reports: `noesis.stats()` in the devtools console.
  window.noesis = {
    get module() { return Module; },
    log: () => logRing.join('\n'),
    stats: () => ({
      residentFiles: resident.size,
      residentMB: +mb(residentBytes),
      cached: cachedKeys.size,
      audio: window.noesisAudio ? window.noesisAudio.stats : 'sdl-default',
      total: manifest ? Object.keys(manifest.files).length : 0,
      inflight: inflight.size,
      saves: Module && Module.FS ? listSaveFiles() : [],
    }),
  };

  // Block keys that would scroll or navigate the page while playing.
  window.addEventListener('keydown', (e) => {
    if ([' ', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Backspace'].includes(e.key)
      && e.target === document.body) e.preventDefault();
  });

  boot().catch((err) => {
    console.error(err);
    setProgress(0, `启动失败：${err.message || err}`);
  });
})();
