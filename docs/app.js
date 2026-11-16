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

  const wlFile = fd.get("wordlist");
  const wordlistText = wlFile && wlFile.name ? await wlFile.text() : "";
  const hints = (fd.get("hints") || "").split("\n").map((s) => s.trim()).filter(Boolean);
  const words = loadWords(wordlistText, hints);
  if (!words.length) { alert("Add some hint words or upload a wordlist."); return; }

  const opts = optsFromForm(fd);
  goBtn.disabled = true;
  cancelBtn.hidden = false;
  panel.hidden = false;
  resultEl.hidden = true;
  stateEl.textContent = "loading engine";
  stateEl.className = "badge";
  logEl.textContent = "";
  metaEl.textContent = "";

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
