// Zip-Recovery (GitHub Pages / client-side).
//
// Everything runs in your browser. The archive and wordlist are read with the
// File API and never leave your machine. The decryption libraries load from a
// CDN (zip.js for .zip, a 7-Zip WebAssembly build for .7z).

import { generate, loadWords, parseRange } from "./engine.js";

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
const progressEl = $("progress");
const progressFill = $("progress-fill");

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

// The archive the user has chosen, so the commands reference their real file.
function archiveInfo() {
  const inp = $("archive");
  const f = inp && inp.files && inp.files[0];
  const name = f ? f.name : "YOUR_ARCHIVE.7z";
  const ext = name.toLowerCase().endsWith(".zip") ? "zip" : "7z";
  return { name, ext };
}

// Exact clone-and-run commands for a list too big to run in the browser.
function commandsFor(entry) {
  const { name, ext } = archiveInfo();
  const q = /\s/.test(name) ? `"${name}"` : name;
  const john = ext === "zip" ? "zip2john" : "7z2john";
  const mode = ext === "zip" ? "13600" : "11600";
  const modeNote = ext === "zip" ? "   # WinZip AES; check zip2john output for the right -m" : "";
  const L = [
    "# 1. get the tool",
    "git clone https://github.com/PseudoSyntax/Zip-Recovery.git",
    "cd Zip-Recovery",
    "pip install -r requirements.txt",
    "",
  ];
  if (entry.id === "rockyou") {
    L.push(
      "# 2. get rockyou (~134 MB)",
      "curl -L -o rockyou.txt.tar.gz \\",
      "  " + entry.download_url,
      "tar -xzf rockyou.txt.tar.gz        # -> rockyou.txt",
      "",
      "# 3. run against your file",
      `python recall.py ${q} -w rockyou.txt`,
      "",
      "# much faster (GPU brute force) instead of step 3:",
      `${john} ${q} > hash.txt`,
      `hashcat -m ${mode} hash.txt rockyou.txt${modeNote}`,
    );
  } else {
    L.push(
      `# 2. download a list from ${entry.download_url}`,
      "#    and save it as wordlist.txt in this folder",
      "",
      "# 3. run against your file",
      `python recall.py ${q} -w wordlist.txt`,
      "",
      "# much faster (GPU brute force):",
      `${john} ${q} > hash.txt`,
      `hashcat -m ${mode} hash.txt wordlist.txt${modeNote}`,
    );
  }
  return L.join("\n");
}

function renderWlInfo() {
  const sel = $("wordlist_id"), info = $("wl-info");
  const e = catalog.find((x) => x.id === sel.value);
  info.innerHTML = "";
  if (!e) { info.hidden = true; return; }

  const est = e.lines ? `rough est ${fmtDuration(e.lines / rate)}` : "";
  const desc = document.createElement("div");
  desc.textContent = `${e.description} (${(e.lines || 0).toLocaleString()} lines, ${e.size}${est ? "; " + est : ""})`;
  info.appendChild(desc);

  if (!e.fetchable) {
    const note = document.createElement("div");
    note.className = "cmd-note";
    note.textContent = "Too big to run in the browser. Clone the tool and run it against your file:";
    info.appendChild(note);
    const pre = document.createElement("pre");
    pre.className = "cmds";
    pre.textContent = commandsFor(e);
    info.appendChild(pre);
    const copy = document.createElement("button");
    copy.type = "button"; copy.className = "copy"; copy.textContent = "Copy commands";
    copy.addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(pre.textContent); copy.textContent = "Copied"; }
      catch { copy.textContent = "Copy failed"; }
      setTimeout(() => { copy.textContent = "Copy commands"; }, 1500);
    });
    info.appendChild(copy);
  }
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

// Rough number of candidates a word count produces, for the progress bar.
// It is an upper-ish estimate (dedup trims the real total), which is fine for a bar.
function estimateTotal(numWords, opts) {
  const kits = new Set(opts.kits);
  const digits = parseRange(opts.digits).length;
  const years = parseRange(opts.years).length;
  let perWord = 0;
  if (kits.has("base")) perWord += 1;
  if (kits.has("case")) perWord += 5;
  if (kits.has("affix")) perWord += 18 + digits + years * 3 + 3;
  if (kits.has("leet")) perWord += opts.leetCap;
  if (kits.has("dup")) perWord += 3;
  let total = numWords * perWord;
  if (kits.has("combo") && opts.combo) total += numWords * Math.max(0, numWords - 1) * opts.comboSeps.length;
  return Math.max(1, total);
}

function setProgress(tried, total) {
  const pct = Math.min(99.5, (tried / total) * 100);
  progressFill.style.width = pct.toFixed(1) + "%";
}

// Run the generator over one word set, testing each candidate. Returns a result
// object; carries the running "tried" count across lists via ctx.baseTried.
async function testLoop(tester, words, opts, ctx) {
  let tried = ctx.baseTried;
  for (const pw of generate(words, opts)) {
    if (cancelFlag) return { state: "cancelled", tried };
    let ok;
    try { ok = await tester(pw); }
    catch (err) { return { state: "error", tried, err }; }
    tried++;
    if (ok) return { state: "found", tried, password: pw };

    if (tried % 100 === 0) {
      const secs = (performance.now() - ctx.start) / 1000;
      rate = Math.max(1, (tried - ctx.startedTried) / secs);
      const where = ctx.count > 1 ? `  [list ${ctx.idx + 1}/${ctx.count}: ${ctx.label}]` : "";
      metaEl.textContent = `${tried.toLocaleString()} tried, ${rate.toFixed(0)}/s (full speed)${where}`;
      logEl.textContent = "last candidate: " + pw.slice(0, 48);
      setProgress(tried, ctx.total);
      await new Promise((r) => setTimeout(r, 0));
      if (opts.maxAttempts && tried >= opts.maxAttempts) return { state: "capped", tried };
      if (opts.maxSeconds && secs >= opts.maxSeconds) return { state: "capped", tried };
    }
  }
  return { state: "exhausted", tried };
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
  resultEl.className = "";
  stateEl.textContent = "preparing";
  stateEl.className = "badge";
  logEl.textContent = "";
  metaEl.textContent = "";
  progressEl.hidden = false;
  progressFill.style.width = "0%";

  const opts = optsFromForm(fd);

  // Build the ordered list of sources to try.
  // Uploaded file wins; else "try all lists"; else the single pick; else hints only.
  let sources;
  const allLists = fd.get("all_lists");
  const wlFile = fd.get("wordlist");
  const wlId = fd.get("wordlist_id");
  if (wlFile && wlFile.name) {
    let t; try { t = await wlFile.text(); } catch (err) { return fail("reading your wordlist file", err); }
    sources = [{ label: wlFile.name, text: t, lines: t.split("\n").length }];
  } else if (allLists) {
    sources = catalog.filter((x) => x.fetchable && x.url)
      .map((x) => ({ id: x.id, label: x.name, lines: x.lines }));
    if (!sources.length) sources = [{ label: "your words", text: "", lines: 0 }];
  } else if (wlId && wlId !== "none") {
    const picked = catalog.find((x) => x.id === wlId);
    if (!picked) return fail("selecting a wordlist", new Error("unknown wordlist id " + wlId));
    if (!picked.fetchable || !picked.url) {
      return finish("error", { error: `"${picked.name}" is too large to run in the browser. ` +
        `Use the clone-and-run commands shown under the list, or pick a smaller list.` });
    }
    sources = [{ id: picked.id, label: picked.name, lines: picked.lines }];
  } else {
    sources = [{ label: "your words", text: "", lines: 0 }];
  }

  // Estimate the grand total for the progress bar (hints count once).
  let total = 0;
  for (let i = 0; i < sources.length; i++) {
    const nWords = (sources[i].lines || 0) + (i === 0 ? hints.length : 0);
    total += estimateTotal(Math.max(1, nWords), opts);
  }

  stateEl.textContent = "starting engine";
  let tester;
  try { tester = await pickTester(archive); }
  catch (err) { return fail("starting the decryption engine", err); }

  const start = performance.now();
  let tried = 0, anyWords = false;

  for (let i = 0; i < sources.length; i++) {
    if (cancelFlag) return finish("cancelled", { tried, start });
    const src = sources[i];
    let text = src.text;
    if (text === undefined && src.id) {
      stateEl.textContent = `loading ${src.label} (${i + 1}/${sources.length})`;
      try { text = await fetchCatalogList(catalog.find((c) => c.id === src.id)); }
      catch (err) { return fail(`loading the wordlist ${src.label}`, err, { tried, start }); }
    }
    const words = loadWords(text || "", i === 0 ? hints : []);
    if (words.length) anyWords = true;
    stateEl.textContent = "running";
    const res = await testLoop(tester, words, opts,
      { start, startedTried: tried, baseTried: tried, total, label: src.label, idx: i, count: sources.length });
    tried = res.tried;
    if (res.state === "found") return finish("found", { password: res.password, tried, start, source: sources.length > 1 ? src.label : null });
    if (res.state === "cancelled") return finish("cancelled", { tried, start });
    if (res.state === "error") return fail("testing a password", res.err, { tried, start });
    if (res.state === "capped") return finish("capped", { tried, start });
    // exhausted this source: on to the next
  }

  if (!anyWords) return finish("error", { error: "no candidates: pick a wordlist, upload one, or add some hint words" });
  finish("exhausted", { tried, start });
}

function finish(state, info) {
  goBtn.disabled = false;
  cancelBtn.hidden = true;
  stateEl.textContent = state === "capped" ? "stopped at limit" : state;
  stateEl.className = "badge " + (state === "found" ? "ok" : "err");
  resultEl.hidden = false;
  resultEl.className = "";
  if (info.start) {
    const secs = ((performance.now() - info.start) / 1000).toFixed(1);
    metaEl.textContent = `${(info.tried || 0).toLocaleString()} tried in ${secs}s`;
  }

  if (state === "found") {
    progressFill.style.width = "100%";
    resultEl.className = "found-box";
    resultEl.innerHTML =
      '<div class="found-head">✓ Password found</div>' +
      '<div class="found-pw"><code class="pw"></code>' +
      '<button type="button" class="copy" id="copy-pw">Copy</button></div>' +
      '<div class="found-src"></div>';
    resultEl.querySelector(".pw").textContent = info.password;
    if (info.source) resultEl.querySelector(".found-src").textContent = "found in list: " + info.source;
    const btn = resultEl.querySelector("#copy-pw");
    btn.addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(info.password); btn.textContent = "Copied"; }
      catch { btn.textContent = "Copy failed"; }
      setTimeout(() => { btn.textContent = "Copy"; }, 1500);
    });
    return;
  }

  progressEl.hidden = true;
  if (state === "exhausted") {
    resultEl.textContent =
      "No match across the whole candidate set. Add more words, enable more kits, widen the ranges, or try the 'all lists' option.";
  } else if (state === "capped") {
    resultEl.textContent = "Stopped at the attempt/time limit you set before finding a match.";
  } else if (state === "cancelled") {
    resultEl.textContent = "Stopped.";
  } else {
    resultEl.textContent = "Error: " + (info.error || "unknown") + "  (full detail in the browser console)";
  }
}

form.addEventListener("submit", run);
cancelBtn.addEventListener("click", () => { cancelFlag = true; });

const allEl = $("all_lists");
if (allEl) allEl.addEventListener("change", () => {
  const sel = $("wordlist_id");
  sel.disabled = allEl.checked;
  sel.style.opacity = allEl.checked ? "0.5" : "1";
  if (allEl.checked) renderWlInfo();
});

// re-render the command block with the real filename once an archive is chosen
const archiveEl = $("archive");
if (archiveEl) archiveEl.addEventListener("change", () => {
  const sel = $("wordlist_id");
  const e = catalog.find((x) => x.id === sel.value);
  if (e && !e.fetchable) renderWlInfo();
});
