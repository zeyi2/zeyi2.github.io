"use strict";

const WASM_PAGE_SIZE = 64 * 1024;
const MAX_FILE_SIZE = 512 * 1024 * 1024;
const OUTPUT_SIZE = 192;
const STATS_COUNT = 9;
const ROW_HEIGHT = 20;
const OVERSCAN = 10;
const ELF_MACHINE_RISCV = 243;
const ELF_SHF_EXECINSTR = 0x4n;
const ELF_SHT_NOBITS = 8;

const STATUS = [
  "ok",
  "unknown instruction",
  "reserved encoding",
  "disabled extension",
  "need more bytes",
  "unsupported length",
  "invalid argument",
  "output buffer too small",
];

const elements = {
  runtimeDot: document.querySelector("#runtime-dot"),
  runtimeLabel: document.querySelector("#runtime-label"),
  openButton: document.querySelector("#open-button"),
  fileInput: document.querySelector("#file-input"),
  examplesSelect: document.querySelector("#examples-select"),
  xlen: document.querySelector("#xlen-select"),
  total: document.querySelector("#metric-total"),
  time: document.querySelector("#metric-time"),
  rate: document.querySelector("#metric-rate"),
  ok: document.querySelector("#metric-ok"),
  fileName: document.querySelector("#file-name"),
  fileDetail: document.querySelector("#file-detail"),
  summary: document.querySelector("#decode-summary"),
  dropZone: document.querySelector("#drop-zone"),
  headings: document.querySelector(".column-headings"),
  viewport: document.querySelector("#instruction-viewport"),
  spacer: document.querySelector("#instruction-spacer"),
  rows: document.querySelector("#instruction-rows"),
  empty: document.querySelector("#empty-state"),
};

const state = {
  wasm: null,
  memory: null,
  heapBase: 0,
  inputPtr: 0,
  statsPtr: 0,
  outputPtr: 0,
  corpus: new Uint8Array(),
  segments: [],
  records: [],
  decoded: new Map(),
  fileName: "",
  fileKind: "",
  xlen: 64,
  renderStart: -1,
  renderEnd: -1,
  scrollbarWidth: -1,
  examples: [],
};

const exampleCache = new Map();

function align(value, alignment) {
  return (value + alignment - 1) & ~(alignment - 1);
}

function formatCount(value) {
  return new Intl.NumberFormat("en-US").format(value);
}

function formatBytes(value) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KiB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MiB`;
  return `${(value / 1024 ** 3).toFixed(2)} GiB`;
}

function formatDuration(milliseconds) {
  if (milliseconds < 0.001) return `${(milliseconds * 1e6).toFixed(0)} ns`;
  if (milliseconds < 1) return `${(milliseconds * 1e3).toFixed(2)} µs`;
  return `${milliseconds.toFixed(milliseconds < 10 ? 3 : 2)} ms`;
}

function formatRate(rate) {
  if (!Number.isFinite(rate)) return "—";
  if (rate >= 1e9) return `${(rate / 1e9).toFixed(2)} G insn/s`;
  if (rate >= 1e6) return `${(rate / 1e6).toFixed(2)} M insn/s`;
  if (rate >= 1e3) return `${(rate / 1e3).toFixed(1)} k insn/s`;
  return `${rate.toFixed(0)} insn/s`;
}

function hex(value, width) {
  return value.toString(16).padStart(width, "0");
}

function setRuntimeStatus(kind, label) {
  elements.runtimeDot.className = `runtime-dot ${kind}`;
  elements.runtimeLabel.textContent = label;
}

function setControlsEnabled(enabled) {
  elements.fileInput.disabled = !enabled;
  elements.examplesSelect.disabled = !enabled;
  elements.xlen.disabled = !enabled;
  elements.openButton.classList.toggle("disabled", !enabled);
  elements.openButton.setAttribute("aria-disabled", String(!enabled));
}

function renderExamples() {
  const fragment = document.createDocumentFragment();
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "choose an example...";
  fragment.append(placeholder);
  for (const example of state.examples) {
    const option = document.createElement("option");
    option.value = example.id;
    option.textContent = `${example.title} (${example.architecture})`;
    fragment.append(option);
  }
  elements.examplesSelect.replaceChildren(fragment);
}

function decodeBase64(value) {
  const binary = atob(value.replace(/\s/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; ++index)
    bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function sha256(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (value) => hex(value, 2)).join("");
}

async function exampleBytes(example) {
  if (exampleCache.has(example.id)) return exampleCache.get(example.id);

  const response = await fetch(example.dataUrl);
  if (!response.ok)
    throw new Error(`${example.title}: could not load corpus (${response.status})`);

  const bytes = example.encoding === "base64"
    ? decodeBase64(await response.text())
    : new Uint8Array(await response.arrayBuffer());
  if (example.byteLength != null && bytes.length !== example.byteLength)
    throw new Error(`${example.title}: corpus length does not match the manifest`);
  if (example.sha256 && await sha256(bytes) !== example.sha256)
    throw new Error(`${example.title}: corpus checksum does not match the manifest`);

  exampleCache.set(example.id, bytes);
  return bytes;
}

async function loadExampleManifest() {
  const response = await fetch("examples/manifest.json");
  if (!response.ok)
    throw new Error(`could not load the example manifest (${response.status})`);

  const examples = await response.json();
  if (!Array.isArray(examples) || examples.length === 0)
    throw new Error("the example manifest is empty or invalid");

  state.examples = examples;
  renderExamples();
}

async function instantiateMachRV() {
  const response = await fetch("machrv.wasm");
  if (!response.ok) throw new Error(`could not load machrv.wasm (${response.status})`);

  let result;
  if (WebAssembly.instantiateStreaming) {
    try {
      result = await WebAssembly.instantiateStreaming(response.clone(), {});
    } catch (error) {
      console.warn("streaming WASM compilation unavailable; using ArrayBuffer", error);
    }
  }
  if (!result) result = await WebAssembly.instantiate(await response.arrayBuffer(), {});

  state.wasm = result.instance.exports;
  state.memory = state.wasm.memory;
  state.heapBase = Number(state.wasm.__heap_base.value);
  state.wasm.mrv_wasm_init();
  setRuntimeStatus("ready", "wasm ready");
}

function ensureMemory(byteLength) {
  state.inputPtr = align(state.heapBase, 16);
  state.statsPtr = align(state.inputPtr + byteLength, 16);
  state.outputPtr = align(state.statsPtr + STATS_COUNT * 4, 16);
  const required = state.outputPtr + OUTPUT_SIZE;
  if (required > state.memory.buffer.byteLength) {
    const pages = Math.ceil((required - state.memory.buffer.byteLength) / WASM_PAGE_SIZE);
    state.memory.grow(pages);
  }
  new Uint8Array(state.memory.buffer, state.inputPtr, byteLength).set(state.corpus);
}

function instructionLength(bytes, offset, end) {
  if (end - offset < 2) return 0;
  const parcel = bytes[offset] | (bytes[offset + 1] << 8);
  if ((parcel & 0x3) !== 0x3) return 2;
  if ((parcel & 0x1f) !== 0x1f) return end - offset >= 4 ? 4 : 0;
  if ((parcel & 0x3f) === 0x1f) return end - offset >= 6 ? 6 : 0;
  if ((parcel & 0x7f) === 0x3f) return end - offset >= 8 ? 8 : 0;
  const extra = (parcel >>> 12) & 0x7;
  if (extra === 7) return -1;
  const length = 10 + extra * 2;
  return end - offset >= length ? length : 0;
}

function buildRecords() {
  const records = [];
  for (const segment of state.segments) {
    const end = segment.corpusOffset + segment.size;
    let offset = segment.corpusOffset;
    while (offset < end) {
      const length = instructionLength(state.corpus, offset, end);
      if (length <= 0) {
        records.push({
          corpusOffset: offset,
          length: length < 0 ? 2 : end - offset,
          address: segment.address + BigInt(offset - segment.corpusOffset),
          section: segment.name,
          trailing: true,
          unsupported: length < 0,
        });
        break;
      }
      records.push({
        corpusOffset: offset,
        length,
        address: segment.address + BigInt(offset - segment.corpusOffset),
        section: segment.name,
        trailing: false,
        unsupported: false,
      });
      offset += length;
    }
  }
  state.records = records;
  state.decoded.clear();
  state.renderStart = -1;
  state.renderEnd = -1;
  elements.spacer.style.height = `${records.length * ROW_HEIGHT}px`;
  elements.viewport.scrollTop = 0;
  elements.empty.classList.toggle("visible", records.length === 0);
}

function runDecodePass() {
  const totals = new Uint32Array(STATS_COUNT);
  for (const segment of state.segments) {
    state.wasm.mrv_wasm_decode_all(
      state.inputPtr + segment.corpusOffset,
      segment.size,
      state.xlen,
      state.statsPtr,
    );
    const stats = new Uint32Array(state.memory.buffer, state.statsPtr, STATS_COUNT);
    for (let index = 0; index < STATS_COUNT; ++index) totals[index] += stats[index];
  }
  return totals;
}

function benchmarkDecode() {
  runDecodePass();
  let repetitions = 1;
  let elapsed = 0;

  while (true) {
    const start = performance.now();
    for (let index = 0; index < repetitions; ++index) runDecodePass();
    elapsed = performance.now() - start;
    if (elapsed >= 100 || repetitions >= 4096) break;
    repetitions *= Math.max(2, Math.min(16, Math.ceil(100 / Math.max(elapsed, 0.01))));
    repetitions = Math.min(repetitions, 4096);
  }

  const stats = runDecodePass();
  const passTime = elapsed / repetitions;
  const rate = stats[0] / (passTime / 1000);
  return { stats, passTime, rate, repetitions };
}

function decodeRecord(index) {
  if (state.decoded.has(index)) return state.decoded.get(index);
  const record = state.records[index];
  if (record.trailing) {
    const result = record.unsupported
      ? { text: "unsupported instruction length", status: 5 }
      : { text: "need more bytes", status: 4 };
    state.decoded.set(index, result);
    return result;
  }

  const packed = state.wasm.mrv_wasm_decode_one(
    state.inputPtr + record.corpusOffset,
    record.length,
    state.xlen,
    state.outputPtr,
    OUTPUT_SIZE,
  );
  const status = (packed >>> 8) & 0xff;
  const output = new Uint8Array(state.memory.buffer, state.outputPtr, OUTPUT_SIZE);
  const terminator = output.indexOf(0);
  let text = new TextDecoder().decode(output.subarray(0, terminator < 0 ? OUTPUT_SIZE : terminator));
  if (!text) text = STATUS[status] ?? `status ${status}`;
  const result = { text, status };
  state.decoded.set(index, result);
  return result;
}

function renderRows(force = false) {
  // Keep the headings aligned with the row columns: the viewport's vertical
  // scrollbar consumes row width, while the heading background stays full-width.
  const scrollbarWidth = elements.viewport.offsetWidth - elements.viewport.clientWidth;
  if (state.scrollbarWidth !== scrollbarWidth) {
    state.scrollbarWidth = scrollbarWidth;
    elements.headings.style.setProperty("--scrollbar-width", `${scrollbarWidth}px`);
  }
  if (!state.records.length) {
    elements.rows.replaceChildren();
    return;
  }
  const visible = Math.ceil(elements.viewport.clientHeight / ROW_HEIGHT);
  const start = Math.max(0, Math.floor(elements.viewport.scrollTop / ROW_HEIGHT) - OVERSCAN);
  const end = Math.min(state.records.length, start + visible + OVERSCAN * 2);
  if (!force && start === state.renderStart && end === state.renderEnd) return;

  const fragment = document.createDocumentFragment();
  for (let index = start; index < end; ++index) {
    const record = state.records[index];
    const decoded = decodeRecord(index);
    const row = document.createElement("div");
    row.className = "instruction-row";
    row.style.transform = `translateY(${index * ROW_HEIGHT}px)`;

    const encoded = document.createElement("div");
    encoded.className = "encoded";
    encoded.title = `${record.section} +0x${hex(BigInt(record.corpusOffset), 1)}`;
    const address = document.createElement("span");
    address.className = "address";
    address.textContent = `0x${hex(record.address, state.xlen === 64 ? 16 : 8)}`;
    const bytes = document.createElement("span");
    bytes.className = "bytes";
    bytes.textContent = Array.from(
      state.corpus.subarray(record.corpusOffset, record.corpusOffset + record.length),
      (value) => hex(value, 2),
    ).join(" ");
    encoded.append(address, bytes);

    const disassembly = document.createElement("div");
    disassembly.className = "decoded";
    if (decoded.status !== 0) {
      disassembly.classList.add(decoded.status === 4 ? "decode-warning" : "decode-error");
      disassembly.textContent = decoded.text;
    } else {
      const separator = decoded.text.indexOf(" ");
      const mnemonic = document.createElement("span");
      mnemonic.className = "mnemonic";
      mnemonic.textContent = separator < 0 ? decoded.text : decoded.text.slice(0, separator);
      disassembly.append(mnemonic);
      if (separator >= 0) disassembly.append(decoded.text.slice(separator));
    }
    row.append(encoded, disassembly);
    fragment.append(row);
  }
  elements.rows.replaceChildren(fragment);
  state.renderStart = start;
  state.renderEnd = end;
}

function updateMetrics(result) {
  const { stats, passTime, rate, repetitions } = result;
  elements.total.textContent = formatCount(stats[0]);
  elements.time.textContent = formatDuration(passTime);
  elements.rate.textContent = formatRate(rate);
  elements.ok.textContent = stats[0] ? `${((stats[1] / stats[0]) * 100).toFixed(1)}%` : "—";
  const failures = stats[2] + stats[3] + stats[4] + stats[5] + stats[6];
  elements.summary.textContent = failures
    ? `${formatCount(stats[1])} ok, ${formatCount(failures)} other, ${repetitions}x bench`
    : `${formatCount(stats[1])} decoded, ${repetitions}x bench`;
}

function decodeCurrentCorpus() {
  if (!state.wasm || !state.corpus.length) return;
  state.xlen = Number(elements.xlen.value);
  ensureMemory(state.corpus.length);
  buildRecords();
  const result = benchmarkDecode();
  updateMetrics(result);
  renderRows(true);
}

function readCString(bytes, offset) {
  if (offset < 0 || offset >= bytes.length) return "";
  let end = offset;
  while (end < bytes.length && bytes[end] !== 0) ++end;
  return new TextDecoder().decode(bytes.subarray(offset, end));
}

function checkedNumber(value, label) {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`${label} is too large for this browser`);
  }
  return Number(value);
}

function parseElf(bytes) {
  if (bytes.length < 52) throw new Error("truncated ELF header");
  const elfClass = bytes[4];
  const encoding = bytes[5];
  if (elfClass !== 1 && elfClass !== 2) throw new Error("unsupported ELF class");
  if (encoding !== 1) throw new Error("only little-endian RISC-V ELF is supported");

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint16(18, true) !== ELF_MACHINE_RISCV) {
    throw new Error("ELF file is not for RISC-V (e_machine != 243)");
  }

  const is64 = elfClass === 2;
  const minimumHeader = is64 ? 64 : 52;
  if (bytes.length < minimumHeader) throw new Error("truncated ELF header");
  const uintX = (offset) => is64 ? view.getBigUint64(offset, true) : BigInt(view.getUint32(offset, true));
  const sectionOffset = checkedNumber(uintX(is64 ? 40 : 32), "section table offset");
  const sectionEntrySize = view.getUint16(is64 ? 58 : 46, true);
  let sectionCount = view.getUint16(is64 ? 60 : 48, true);
  let stringIndex = view.getUint16(is64 ? 62 : 50, true);
  const minimumSection = is64 ? 64 : 40;

  if (!sectionOffset || sectionEntrySize < minimumSection) {
    throw new Error("ELF has no usable section table");
  }

  function sectionHeader(index) {
    const offset = sectionOffset + index * sectionEntrySize;
    if (offset < sectionOffset || offset + minimumSection > bytes.length) {
      throw new Error("section table extends beyond the file");
    }
    return {
      nameOffset: view.getUint32(offset, true),
      type: view.getUint32(offset + 4, true),
      flags: uintX(offset + 8),
      address: uintX(offset + (is64 ? 16 : 12)),
      fileOffset: checkedNumber(uintX(offset + (is64 ? 24 : 16)), "section offset"),
      size: checkedNumber(uintX(offset + (is64 ? 32 : 20)), "section size"),
      link: view.getUint32(offset + (is64 ? 40 : 24), true),
    };
  }

  const sectionZero = sectionHeader(0);
  if (sectionCount === 0) sectionCount = sectionZero.size;
  if (stringIndex === 0xffff) stringIndex = sectionZero.link;
  if (sectionCount > 1_000_000) throw new Error("unreasonable ELF section count");
  if (stringIndex >= sectionCount) throw new Error("invalid section-name table index");

  const stringSection = sectionHeader(stringIndex);
  if (stringSection.fileOffset + stringSection.size > bytes.length) {
    throw new Error("section-name table extends beyond the file");
  }
  const strings = bytes.subarray(stringSection.fileOffset, stringSection.fileOffset + stringSection.size);
  const executable = [];
  let totalSize = 0;
  for (let index = 0; index < sectionCount; ++index) {
    const section = sectionHeader(index);
    if (!(section.flags & ELF_SHF_EXECINSTR) || section.type === ELF_SHT_NOBITS || !section.size) continue;
    if (section.fileOffset + section.size > bytes.length) {
      throw new Error(`executable section ${index} extends beyond the file`);
    }
    executable.push({
      ...section,
      name: readCString(strings, section.nameOffset) || `<section ${index}>`,
      corpusOffset: totalSize,
    });
    totalSize += section.size;
  }
  if (!executable.length) throw new Error("RISC-V ELF contains no executable sections");

  const corpus = new Uint8Array(totalSize);
  for (const section of executable) {
    corpus.set(bytes.subarray(section.fileOffset, section.fileOffset + section.size), section.corpusOffset);
  }
  return {
    corpus,
    segments: executable.map(({ name, address, corpusOffset, size }) => ({
      name,
      address,
      corpusOffset,
      size,
    })),
    kind: `${is64 ? "ELF64" : "ELF32"}, ${executable.length} executable section${executable.length === 1 ? "" : "s"}`,
    xlen: is64 ? 64 : 32,
  };
}

function parseInput(bytes) {
  const isElf = bytes.length >= 4 && bytes[0] === 0x7f && bytes[1] === 0x45 &&
    bytes[2] === 0x4c && bytes[3] === 0x46;
  if (isElf) return parseElf(bytes);
  return {
    corpus: bytes,
    segments: [{ name: "raw", address: 0n, corpusOffset: 0, size: bytes.length }],
    kind: "raw little-endian stream",
    xlen: null,
  };
}

function loadBytes(bytes, name, options = {}) {
  if (!bytes.length) throw new Error("the selected file is empty");
  if (bytes.length > MAX_FILE_SIZE) throw new Error("files larger than 512 MiB are not supported");
  const parsed = parseInput(bytes);
  state.corpus = parsed.corpus;
  state.segments = parsed.segments;
  state.fileName = name;
  const kind = options.kind ?? parsed.kind;
  state.fileKind = kind;
  elements.fileName.textContent = name;
  elements.fileDetail.textContent = `${kind}, ${formatBytes(bytes.length)}`;
  const xlen = options.xlen ?? parsed.xlen;
  if (xlen) elements.xlen.value = String(xlen);
  elements.summary.textContent = options.summary ?? "decoding…";
  decodeCurrentCorpus();
}

async function loadFile(file) {
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    loadBytes(bytes, file.name);
    elements.examplesSelect.value = "";
  } catch (error) {
    showError(error);
  } finally {
    elements.fileInput.value = "";
  }
}

async function loadExample(id) {
  const example = state.examples.find((candidate) => candidate.id === id);
  if (!example) return;

  elements.examplesSelect.disabled = true;
  elements.fileName.textContent = example.title;
  elements.fileDetail.textContent = "loading complete .text…";
  elements.summary.textContent = "verifying corpus…";

  try {
    loadBytes(await exampleBytes(example), example.fileName, {
      kind: `${example.title}, ${example.architecture}`,
      xlen: example.xlen,
      summary: example.detail,
    });
    elements.examplesSelect.value = id;
  } catch (error) {
    elements.examplesSelect.value = "";
    showError(error);
  } finally {
    elements.examplesSelect.disabled = false;
  }
}

function showError(error) {
  console.error(error);
  elements.summary.textContent = error instanceof Error ? error.message : String(error);
  elements.summary.classList.add("decode-error");
  window.setTimeout(() => elements.summary.classList.remove("decode-error"), 3000);
}

function installEvents() {
  elements.fileInput.addEventListener("change", () => {
    if (elements.fileInput.files?.[0]) loadFile(elements.fileInput.files[0]);
  });
  elements.examplesSelect.addEventListener("change", () => {
    if (elements.examplesSelect.value) void loadExample(elements.examplesSelect.value);
  });
  elements.xlen.addEventListener("change", decodeCurrentCorpus);
  elements.viewport.addEventListener("scroll", () => renderRows());
  window.addEventListener("resize", () => renderRows(true));

  let dragDepth = 0;
  window.addEventListener("dragenter", (event) => {
    event.preventDefault();
    ++dragDepth;
    elements.dropZone.classList.add("dragging");
  });
  window.addEventListener("dragover", (event) => event.preventDefault());
  window.addEventListener("dragleave", (event) => {
    event.preventDefault();
    if (--dragDepth <= 0) {
      dragDepth = 0;
      elements.dropZone.classList.remove("dragging");
    }
  });
  window.addEventListener("drop", (event) => {
    event.preventDefault();
    dragDepth = 0;
    elements.dropZone.classList.remove("dragging");
    const file = event.dataTransfer?.files?.[0];
    if (file) loadFile(file);
  });
}

async function main() {
  installEvents();
  try {
    await Promise.all([instantiateMachRV(), loadExampleManifest()]);
    setControlsEnabled(true);
    await loadExample(state.examples[0].id);
  } catch (error) {
    setRuntimeStatus("failed", "wasm failed");
    showError(error);
    elements.fileDetail.textContent = "serve the build/web directory over HTTP";
    elements.empty.classList.add("visible");
  }
}

main();
