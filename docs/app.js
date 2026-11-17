// Zip-Recovery (GitHub Pages / client-side).
//
// Everything runs in your browser. The archive and wordlist are read with the
// File API and never leave your machine. The decryption libraries load from a
// CDN (zip.js for .zip, a 7-Zip WebAssembly build for .7z).

import { generate, loadWords } from "./engine.js";

const ZIPJS = "https://cdn.jsdelivr.net/npm/@zip.js/zip.js@2.7.52/index.js";
const SEVENZIP = "https://cdn.jsdelivr.net/npm/7z-wasm@1.2.0/7zz.es6.js";

const $ = (id) => document.getElementById(id);
const form = $("form");
const panel = $("panel");
const stateEl = $("state");
const metaEl = $("meta");
const logEl = $("log");
const resultEl = $("result");
const goBtn = $("go");
const cancelBtn = $("cancel");

let cancelFlag = false;
let catalog = [];
let rate = 50; // tries/sec, only used for the rough estimate; self-calibrates

// --------------------------------------------------------------------------- //
// Error reporting: make every failure specific and log the full detail.
// --------------------------------------------------------------------------- //

function describeError(err) {
  if (err == null) return "unknown error";
  if (typeof err === "string") return err;
  const name = err.name || "Error";
  const msg = err.message || String(err);
  return name && name !== "Error" ? `${name}: ${msg}` : msg;
}

// Capture stray errors a try/catch can miss (e.g. a WASM module calling abort()).
let lastStray = "";
addEventListener("error", (e) => {
  lastStray = describeError(e.error || e.message);
  console.error("[zip-recovery] window error:", e.error || e.message);
});
addEventListener("unhandledrejection", (e) => {
  lastStray = describeError(e.reason);
  console.error("[zip-recovery] unhandled rejection:", e.reason);
});

// --------------------------------------------------------------------------- //
// Wordlist catalog (descriptions + rough time estimates)
// --------------------------------------------------------------------------- //

function fmtDuration(sec) {
  if (!isFinite(sec) || sec <= 0) return "instant";
  for (const [name, s] of [["day", 86400], ["hour", 3600], ["min", 60], ["sec", 1]]) {
    if (sec >= s) { const n = Math.round(sec / s); return `${n} ${name}${n !== 1 ? "s" : ""}`; }
  }
  return "<1 sec";
}

function renderWlInfo() {
  const sel = $("wordlist_id"), info = $("wl-info");
  const e = catalog.find((x) => x.id === sel.value);
  if (!e) { info.hidden = true; return; }
  const est = e.lines ? `rough est ${fmtDuration(e.lines / rate)}` : "";
  let line = `${e.description} (${(e.lines || 0).toLocaleString()} lines, ${e.size}${est ? "; " + est : ""})`;
  if (!e.fetchable) line += ` — too big for the browser; download: ${e.download_url}`;
  info.textContent = line;
  info.hidden = false;
}

async function fetchCatalogList(entry) {
  const r = await fetch(entry.url);
  if (!r.ok) throw new Error(`fetching ${entry.url} returned HTTP ${r.status}`);
  return await r.text();
}

fetch("./wordlists.json").then((r) => r.json()).then((data) => {
  catalog = data.lists || [];
  rate = data.default_rate || 50;
  const sel = $("wordlist_id");
  for (const e of catalog) {
    const o = document.createElement("option");
    o.value = e.id;
    o.textContent = e.name + (e.fetchable ? "" : "  (download / hashcat)");
    sel.appendChild(o);
  }
  sel.addEventListener("change", renderWlInfo);
}).catch((err) => console.error("[zip-recovery] catalog load failed:", err));

// --------------------------------------------------------------------------- //
// In-browser password testers. Each returns async (pw) => bool.
// --------------------------------------------------------------------------- //

async function loadLib(url, label) {
  try {
    return await import(url);
  } catch (err) {
    throw new Error(
      `could not load the ${label} engine from the CDN (${describeError(err)}). ` +
      `Your network or browser may be blocking ${new URL(url).host}. ` +
      `For .7z, the desktop app (recall.exe) or the command line avoids this.`);
  }
}

async function makeZipTester(file) {
  const zip = await loadLib(ZIPJS, "zip.js");
  try { zip.configure({ useWebWorkers: true }); } catch { /* non-fatal */ }

  let entries;
  try {
    const probe = new zip.ZipReader(new zip.BlobReader(file));
    entries = (await probe.getEntries()).filter((e) => !e.directory);
    await probe.close();
  } catch (err) {
    throw new Error(`could not read the zip structure (${describeError(err)}). Is this a valid .zip file?`);
  }
  if (!entries.length) throw new Error("this zip has no files inside to test a password against");
  entries.sort((a, b) => (a.compressedSize || 0) - (b.compressedSize || 0));
  if (entries[0].encrypted === false) {
    throw new Error("this zip is not password-protected, so there is nothing to recover");
  }
  const targetName = entries[0].filename;

  return async (pw) => {
    const reader = new zip.ZipReader(new zip.BlobReader(file), { password: pw });
    try {
      const es = await reader.getEntries();
      const t = es.find((e) => e.filename === targetName);
      await t.getData(new zip.Uint8ArrayWriter());
      await reader.close();
      return true; // decrypted and CRC/HMAC verified
    } catch {
      try { await reader.close(); } catch { /* ignore */ }
      return false; // wrong password
    }
  };
}

async function make7zTester(file) {
  const mod = await loadLib(SEVENZIP, "7-Zip");
  const factory = mod.default;
  if (typeof factory !== "function") {
    throw new Error("the 7-Zip engine loaded but exposed no entry point (unexpected module shape)");
  }
  const bytes = new Uint8Array(await file.arrayBuffer());

  // The Emscripten 7-Zip build aborts if its main() runs more than once per
  // instance (this is the "operation aborted" people hit). So create a fresh
  // instance for each password test. This is correct but slower than .zip; for
  // large .7z wordlists the desktop recall.exe is much faster.
  return async (pw) => {
    let out = "";
    let sevenZip;
    try {
      sevenZip = await factory({
        print: (s) => { out += s + "\n"; },
        printErr: (s) => { out += s + "\n"; },
      });
    } catch (err) {
      throw new Error(`the 7-Zip engine failed to start (${describeError(err)})`);
    }
    try {
      sevenZip.FS.writeFile("a.7z", bytes);
      sevenZip.callMain(["t", "a.7z", "-p" + pw, "-y", "-bso0"]);
    } catch (err) {
      // A non-zero exit throws Emscripten's ExitStatus, which is the normal
      // "wrong password" signal. A real abort with no output is a failure.
      const m = describeError(err);
      if (/abort/i.test(m) && !out) throw new Error(`7-Zip aborted while testing a password (${m})`);
    }
    return /Everything is Ok/.test(out) && !/Wrong password|Can not open|ERROR/i.test(out);
  };
}

function pickTester(file) {
  const dot = file.name.lastIndexOf(".");
  const ext = dot >= 0 ? file.name.slice(dot).toLowerCase() : "";
  if (ext === ".zip") return makeZipTester(file);
  if (ext === ".7z") return make7zTester(file);
  throw new Error(`unsupported file type "${ext || file.name}". Only .zip and .7z are supported.`);
}

// --------------------------------------------------------------------------- //

function optsFromForm(fd) {
  const kits = fd.getAll("kits");
  return {
    kits: kits.length ? kits : ["base", "case", "affix", "leet"],
    years: fd.get("years") || "2015-2026",
    digits: fd.get("digits") || "0-99",
    leetCap: parseInt(fd.get("leet_cap") || "64", 10) || 64,
    combo: kits.includes("combo"),
    comboSeps: (fd.get("combo_sep") || "-,_,").split(","),
    maxAttempts: parseInt(fd.get("max_attempts") || "0", 10) || 0,
    maxSeconds: parseInt(fd.get("max_seconds") || "0", 10) || 0,
  };
}

function fail(stage, err, extra) {
  const base = describeError(err);
  const stray = lastStray && !base.includes(lastStray) ? ` [also saw: ${lastStray}]` : "";
  console.error(`[zip-recovery] failed while ${stage}:`, err);
  finish("error", Object.assign({ error: `while ${stage}: ${base}${stray}` }, extra || {}));
}

async function run(e) {
  e.preventDefault();
  cancelFlag = false;
  lastStray = "";
  const fd = new FormData(form);
  const archive = fd.get("archive");
  if (!archive || !archive.name) { alert("Choose an archive first."); return; }

  const hints = (fd.get("hints") || "").split("\n").map((s) => s.trim()).filter(Boolean);

  goBtn.disabled = true;
  cancelBtn.hidden = false;
  panel.hidden = false;
  resultEl.hidden = true;
  stateEl.textContent = "preparing";
  stateEl.className = "badge";
  logEl.textContent = "";
  metaEl.textContent = "";

  // wordlist source: uploaded file wins, else a catalog pick
  let wordlistText = "";
  const wlFile = fd.get("wordlist");
  const wlId = fd.get("wordlist_id");
  if (wlFile && wlFile.name) {
    try { wordlistText = await wlFile.text(); }
    catch (err) { return fail("reading your wordlist file", err); }
  } else if (wlId && wlId !== "none") {
    const picked = catalog.find((x) => x.id === wlId);
    if (!picked) return fail("selecting a wordlist", new Error("unknown wordlist id " + wlId));
    if (!picked.fetchable || !picked.url) {
      return finish("error", { error: `"${picked.name}" is too large for the browser. ` +
        `Download it (${picked.download_url}) and use recall.exe, or pick a smaller list.` });
    }
    stateEl.textContent = "loading wordlist";
    try { wordlistText = await fetchCatalogList(picked); }
    catch (err) { return fail("loading the wordlist", err); }
  }

  const words = loadWords(wordlistText, hints);
  if (!words.length) {
    return finish("error", { error: "no candidates: pick a wordlist, upload one, or add some hint words" });
  }

  const opts = optsFromForm(fd);
  stateEl.textContent = "starting engine";

  let tester;
  try {
    tester = await pickTester(archive);
  } catch (err) {
    return fail("starting the decryption engine", err);
  }

  stateEl.textContent = "running";
  const start = performance.now();
  let tried = 0;

  for (const pw of generate(words, opts)) {
    if (cancelFlag) return finish("cancelled", { tried, start });
    let ok = false;
    try {
      ok = await tester(pw);
    } catch (err) {
      return fail("testing a password", err, { tried, start });
    }
    tried++;
    if (ok) return finish("found", { password: pw, tried, start });

    if (tried % 100 === 0) {
      const secs = (performance.now() - start) / 1000;
      rate = Math.max(1, tried / secs); // self-calibrate the estimate
      metaEl.textContent = `${tried.toLocaleString()} tried, ${rate.toFixed(0)}/s (full speed)`;
      logEl.textContent = "last candidate: " + pw.slice(0, 48);
      await new Promise((r) => setTimeout(r, 0)); // let the page breathe
      if (opts.maxAttempts && tried >= opts.maxAttempts) break;
      if (opts.maxSeconds && secs >= opts.maxSeconds) break;
    }
  }
  finish("exhausted", { tried, start });
}

function finish(state, info) {
  goBtn.disabled = false;
  cancelBtn.hidden = true;
  stateEl.textContent = state;
  stateEl.className = "badge " + (state === "found" ? "ok" : "err");
  resultEl.hidden = false;
  if (info.start) {
    const secs = ((performance.now() - info.start) / 1000).toFixed(1);
    metaEl.textContent = `${(info.tried || 0).toLocaleString()} tried in ${secs}s`;
  }
  if (state === "found") {
    resultEl.innerHTML = 'Password found: <code class="pw"></code>';
    resultEl.querySelector(".pw").textContent = info.password;
  } else if (state === "exhausted") {
    resultEl.textContent =
      "No match across the whole candidate set. Add more words, enable more kits, or widen the ranges.";
  } else if (state === "cancelled") {
    resultEl.textContent = "Stopped.";
  } else {
    resultEl.textContent = "Error: " + (info.error || "unknown") + "  (full detail in the browser console)";
  }
}

form.addEventListener("submit", run);
cancelBtn.addEventListener("click", () => { cancelFlag = true; });
