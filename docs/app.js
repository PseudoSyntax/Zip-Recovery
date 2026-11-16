// Zip-Recovery (GitHub Pages / client-side).
//
// Everything runs in your browser. The archive and wordlist are read with the
// File API and never sent anywhere. The only network requests this page makes
// are for the two decryption libraries below, loaded from a CDN. Vendor them
// into this folder if you want a fully offline, no-CDN deployment.

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

// --------------------------------------------------------------------------- //
// Wordlist catalog (descriptions + time estimates)
// --------------------------------------------------------------------------- //

function fmtDuration(sec) {
  if (!isFinite(sec) || sec <= 0) return "instant";
  for (const [name, s] of [["day", 86400], ["hour", 3600], ["min", 60], ["sec", 1]]) {
    if (sec >= s) { const n = Math.round(sec / s); return `${n} ${name}${n !== 1 ? "s" : ""}`; }
  }
  return "<1 sec";
}

function renderWlInfo() {
  const sel = $("wordlist_id"), info = $("wl-info"), rateEl = $("rate");
  const e = catalog.find((x) => x.id === sel.value);
  if (!e) { info.hidden = true; return; }
  const rate = Math.max(1, parseInt(rateEl.value || "50", 10));
  const est = e.lines ? `~${fmtDuration(e.lines / rate)} at ${rate}/s` : "n/a";
  let line = `${e.description} (${(e.lines || 0).toLocaleString()} lines, ${e.size}; est ${est})`;
  if (!e.fetchable) line += ` — too big for the browser; download: ${e.download_url}`;
  info.textContent = line;
  info.hidden = false;
}

async function fetchCatalogList(entry) {
  const r = await fetch(entry.url);
  if (!r.ok) throw new Error("HTTP " + r.status);
  return await r.text();
}

fetch("./wordlists.json").then((r) => r.json()).then((data) => {
  catalog = data.lists || [];
  const sel = $("wordlist_id"), rateEl = $("rate");
  rateEl.value = data.default_rate || 50;
  for (const e of catalog) {
    const o = document.createElement("option");
    o.value = e.id;
    o.textContent = e.name + (e.fetchable ? "" : "  (download / hashcat)");
    sel.appendChild(o);
  }
  sel.addEventListener("change", renderWlInfo);
  rateEl.addEventListener("input", renderWlInfo);
}).catch(() => {});

// --------------------------------------------------------------------------- //
// In-browser password testers. Each returns async (pw) => bool.
// --------------------------------------------------------------------------- //

async function makeZipTester(file) {
  const zip = await import(ZIPJS);
  zip.configure({ useWebWorkers: true });
  // find the smallest file entry once, to make each test cheap
  const probe = new zip.ZipReader(new zip.BlobReader(file));
  const entries = (await probe.getEntries()).filter((e) => !e.directory);
  await probe.close();
  if (!entries.length) throw new Error("this zip has no files to test against");
  entries.sort((a, b) => (a.compressedSize || 0) - (b.compressedSize || 0));
  const targetName = entries[0].filename;

  return async (pw) => {
    const reader = new zip.ZipReader(new zip.BlobReader(file), { password: pw });
    try {
      const es = await reader.getEntries();
      const t = es.find((e) => e.filename === targetName);
      await t.getData(new zip.Uint8ArrayWriter());
      await reader.close();
      return true; // decrypted + CRC/HMAC checked out
    } catch {
      try { await reader.close(); } catch {}
      return false;
    }
  };
}

async function make7zTester(file) {
  const factory = (await import(SEVENZIP)).default;
  const bytes = new Uint8Array(await file.arrayBuffer());
  let out = "";
  const sevenZip = await factory({
    print: (s) => { out += s + "\n"; },
    printErr: (s) => { out += s + "\n"; },
  });
  sevenZip.FS.writeFile("archive.7z", bytes);

  return async (pw) => {
    out = "";
    try {
      // test the archive with this password; silent, assume-yes
      sevenZip.callMain(["t", "archive.7z", "-p" + pw, "-y", "-bso0"]);
    } catch {
      // emscripten raises ExitStatus on non-zero exit; the text in `out` decides
    }
    return /Everything is Ok/.test(out) && !/Wrong password|Can not|ERROR/i.test(out);
  };
}

function pickTester(file) {
  const ext = file.name.toLowerCase().slice(file.name.lastIndexOf("."));
  if (ext === ".zip") return makeZipTester(file);
  if (ext === ".7z") return make7zTester(file);
  throw new Error("only .7z and .zip are supported");
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

async function run(e) {
  e.preventDefault();
  cancelFlag = false;
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

  // where the wordlist comes from: uploaded file wins, else a catalog pick
  let wordlistText = "";
  const wlFile = fd.get("wordlist");
  const wlId = fd.get("wordlist_id");
  if (wlFile && wlFile.name) {
    wordlistText = await wlFile.text();
  } else if (wlId && wlId !== "none") {
    const e = catalog.find((x) => x.id === wlId);
    if (!e) { finish("error", { error: "unknown wordlist" }); return; }
    if (!e.fetchable || !e.url) {
      finish("error", { error: `"${e.name}" is too large for the browser. ` +
        `Download it (${e.download_url}) and use recall.py, or upload a smaller list.` });
      return;
    }
    stateEl.textContent = "downloading wordlist";
    try { wordlistText = await fetchCatalogList(e); }
    catch (err) { finish("error", { error: "could not download wordlist: " + err.message }); return; }
  }

  const words = loadWords(wordlistText, hints);
  if (!words.length) { finish("error", { error: "pick a wordlist, upload one, or add hint words" }); return; }

  const opts = optsFromForm(fd);
  stateEl.textContent = "loading engine";

  let tester;
  try {
    tester = await pickTester(archive);
  } catch (err) {
    finish("error", { error: err.message });
    return;
  }

  stateEl.textContent = "running";
  const start = performance.now();
  let tried = 0;
  const unlimited = opts.maxAttempts === 0 && opts.maxSeconds === 0;

  for (const pw of generate(words, opts)) {
    if (cancelFlag) { finish("cancelled", { tried, start }); return; }
    let ok = false;
    try { ok = await tester(pw); } catch (err) {
      finish("error", { error: err.message, tried, start }); return;
    }
    tried++;
    if (ok) { finish("found", { password: pw, tried, start }); return; }

    if (tried % 25 === 0) {
      const secs = (performance.now() - start) / 1000;
      metaEl.textContent = `${tried} tried at ${(tried / secs).toFixed(0)}/s` +
        (unlimited ? " (unlimited)" : "");
      logEl.textContent = "last candidate: " + pw.slice(0, 40);
      await new Promise((r) => setTimeout(r, 0)); // keep the page responsive
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
    metaEl.textContent = `${info.tried || 0} tried in ${secs}s`;
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
    resultEl.textContent = "Error: " + (info.error || "unknown");
  }
}

form.addEventListener("submit", run);
cancelBtn.addEventListener("click", () => { cancelFlag = true; });
