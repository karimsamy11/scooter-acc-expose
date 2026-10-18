// Engineering Lab page logic. Everything stays in this browser and the visitor's local Ollama.
import { AUTO_ENDPOINTS, DEFAULT_ENDPOINT, OllamaError, browserHint, chat, checkEndpoint, listModels } from "./ollama.js";
import { FIELDS, autoTitle, discussionUrl, emptyProposal, expansionPrompt, guardCriteria, missingRequired, parseExpansion, toMarkdown } from "./proposal.js";
import { renderMarkdown } from "./render.js";

// Fill in after enabling Discussions and installing the giscus app (values from https://giscus.app).
const GISCUS = { repo: "karimsamy11/scooter-acc-expose", repoId: "", category: "General", categoryId: "" };

const STORE_KEY = "scooter-lab.v1";
const MAX_HISTORY = 24; // messages sent to the model besides the system prompt
const MAX_HISTORY_CHARS = 24000;
const PREFERRED = [/^qwen2\.5/i, /^llama3/i, /^mistral/i, /^gemma/i, /^phi/i];

const $ = (id) => document.getElementById(id);
const log = (...a) => console.info("[lab]", ...a);
const warn = (...a) => console.warn("[lab]", ...a);

const state = {
  endpoint: DEFAULT_ENDPOINT,
  model: "",
  connected: false,
  busy: false,
  abort: null,
  system: "",
  messages: [], // {role: "user"|"assistant", content}
  proposal: emptyProposal(),
  draftedWith: "",
};

// ---------- storage (best effort; the page works without it) ----------
function load() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE_KEY) || "null");
    if (!s) return;
    if (typeof s.endpoint === "string") state.endpoint = s.endpoint;
    if (typeof s.model === "string") state.model = s.model;
    if (Array.isArray(s.messages)) {
      state.messages = s.messages
        .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
        .slice(-200);
    }
    if (s.proposal && typeof s.proposal === "object") {
      for (const k of Object.keys(state.proposal)) {
        if (typeof s.proposal[k] === typeof state.proposal[k]) state.proposal[k] = s.proposal[k];
      }
    }
    if (typeof s.draftedWith === "string") state.draftedWith = s.draftedWith;
  } catch (e) { warn("could not read saved state", e); }
}
let saveTimer = 0;
function flush() {
  clearTimeout(saveTimer);
  saveTimer = 0;
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({
      endpoint: state.endpoint, model: state.model, messages: state.messages,
      proposal: state.proposal, draftedWith: state.draftedWith,
    }));
  } catch (e) { warn("could not save state", e); }
}
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flush, 250);
}

// ---------- knowledge ----------
async function loadKnowledge() {
  const [rules, brief] = await Promise.all(
    ["knowledge/system-prompt.md", "knowledge/engineering-brief.md"].map(async (p) => {
      const r = await fetch(p, { cache: "no-cache" });
      if (!r.ok) throw new Error(`${p}: ${r.status}`);
      return r.text();
    })
  );
  state.system = `${rules.trim()}\n\nENGINEERING BRIEF:\n${brief.trim()}`;
}

// ---------- connection ----------
function setStatus(kind, text) {
  $("dot").className = "dot " + (kind || "");
  $("status-text").textContent = text;
}

function showHelp(err) {
  const help = $("help");
  help.replaceChildren();
  if (!err) { help.hidden = true; return; }
  const b = browserHint();
  const items = [];
  const title = document.createElement("p");
  title.textContent = err.message;
  title.style.fontWeight = "600";
  if (err.kind === "unreachable" || err.kind === "timeout") {
    if (b === "safari") {
      items.push("Safari blocks secure web pages from calling a local server. Use Chrome, Edge or Firefox, or run the lab from your own computer (see setup, last step).");
    } else if (b === "mobile") {
      items.push("The local AI needs Ollama running on this same device. On a phone, share your idea without AI below.");
    } else {
      items.push("Is the lab session running? Start it as shown in the setup steps (step 2) and keep its window open.");
      items.push("Check the session settings: OLLAMA_HOST must be 127.0.0.1:11435 and OLLAMA_ORIGINS exactly https://karimsamy11.github.io.");
      if (b === "chromium") items.push("Chrome and Edge ask before a website may talk to apps on your computer. If you blocked it, allow “Local network access” (or “Apps on device”) in the site settings: click the icon left of the address, then reload.");
      items.push("Still blocked? Run the lab from your own computer (see setup, last step).");
    }
  } else if (err.kind === "no-models") {
    items.push("Download a chat model in a terminal: ollama pull qwen2.5:7b (or qwen2.5:3b on smaller machines), then press Connect again.");
  } else if (err.kind === "bad-endpoint") {
    items.push("Use the default address http://127.0.0.1:11434 unless you changed Ollama's port.");
  } else if (err.kind === "http") {
    items.push("Ollama reported an error. Check that the selected model is fully downloaded: ollama list");
  }
  const ul = document.createElement("ul");
  for (const t of items) { const li = document.createElement("li"); li.textContent = t; ul.append(li); }
  help.append(title, ul);
  help.hidden = false;
  if (err.kind === "unreachable" || err.kind === "timeout") $("setup").open = true;
}

async function connect() {
  let endpoint;
  try {
    endpoint = checkEndpoint($("endpoint").value);
  } catch (e) {
    setStatus("bad", "Address not allowed.");
    showHelp(e);
    return;
  }
  setStatus("busy", "Looking for Ollama…");
  showHelp(null);
  $("connect").disabled = true;
  try {
    // With a default address, try the lab-session port first, then Ollama's normal port.
    const tries = AUTO_ENDPOINTS.includes(endpoint) ? [endpoint, ...AUTO_ENDPOINTS.filter((e) => e !== endpoint)] : [endpoint];
    let models = null;
    for (const [i, ep] of tries.entries()) {
      try {
        models = await listModels(ep);
        endpoint = ep;
        break;
      } catch (e) {
        if (!(e instanceof OllamaError) || !["unreachable", "timeout"].includes(e.kind) || i === tries.length - 1) throw e;
        log("not at", ep, e.kind);
      }
    }
    state.endpoint = endpoint;
    $("endpoint").value = endpoint;
    const sel = $("model");
    sel.replaceChildren();
    for (const m of models) {
      const o = document.createElement("option");
      o.value = m.name;
      o.textContent = m.size ? `${m.name} (${(m.size / 1e9).toFixed(1)} GB)` : m.name;
      sel.append(o);
    }
    const names = models.map((m) => m.name);
    let pick = names.includes(state.model) ? state.model : "";
    for (const re of PREFERRED) if (!pick) pick = names.find((n) => re.test(n)) || "";
    state.model = pick || names[0];
    sel.value = state.model;
    sel.disabled = false;
    state.connected = true;
    $("connect").textContent = "Reconnect";
    setStatus("ok", `Connected. ${models.length} model${models.length > 1 ? "s" : ""} available.`);
    log("connected", endpoint, names);
    save();
  } catch (e) {
    state.connected = false;
    const err = e instanceof OllamaError ? e : new OllamaError("unreachable", String(e));
    setStatus("bad", err.kind === "no-models" ? "Ollama found, but no model installed." : "Ollama not reachable.");
    showHelp(err);
    warn("connect failed", err.kind, err.message);
  } finally {
    $("connect").disabled = false;
    refresh();
  }
}

// ---------- chat ----------
function bubble(role, content) {
  const div = document.createElement("div");
  div.className = "msg " + role;
  const who = document.createElement("span");
  who.className = "who";
  who.textContent = role === "user" ? "You" : role === "assistant" ? `AI (${state.model || "local model"})` : "Error";
  const body = document.createElement("div");
  div.append(who, body);
  if (role === "user") {
    // keep the visitor's text exactly as typed
    for (const para of content.split(/\n{2,}/)) { const p = document.createElement("p"); p.textContent = para; p.style.whiteSpace = "pre-wrap"; body.append(p); }
  } else if (role === "assistant") {
    renderMarkdown(body, content);
  } else {
    const p = document.createElement("p"); p.textContent = content; body.append(p);
  }
  $("empty").hidden = true;
  $("log").append(div);
  return body;
}

function renderLog() {
  for (const el of [...$("log").querySelectorAll(".msg")]) el.remove();
  $("empty").hidden = state.messages.length > 0;
  for (const m of state.messages) bubble(m.role, m.content);
  scrollLog();
}
function scrollLog() { const l = $("log"); l.scrollTop = l.scrollHeight; }

function history(extraUser) {
  let msgs = state.messages.slice(-MAX_HISTORY);
  while (msgs.length > 2 && msgs.reduce((n, m) => n + m.content.length, 0) > MAX_HISTORY_CHARS) msgs = msgs.slice(2);
  const out = [{ role: "system", content: state.system }, ...msgs];
  if (extraUser) out.push({ role: "user", content: extraUser });
  return out;
}

function setBusy(on) {
  state.busy = on;
  $("stop").hidden = !on;
  refresh();
}

async function stream(messages, onText) {
  state.abort = new AbortController();
  setBusy(true);
  try {
    return await chat(state.endpoint, { model: state.model, messages, signal: state.abort.signal, onToken: onText });
  } finally {
    state.abort = null;
    setBusy(false);
  }
}

async function send(text) {
  state.messages.push({ role: "user", content: text });
  bubble("user", text);
  save();
  const body = bubble("assistant", "");
  let acc = "";
  let frame = 0;
  const paint = () => { frame = 0; renderMarkdown(body, acc); scrollLog(); };
  try {
    const full = await stream(history(), (piece) => { acc += piece; if (!frame) frame = requestAnimationFrame(paint); });
    acc = full;
    paint();
    state.messages.push({ role: "assistant", content: full || "(empty answer)" });
  } catch (e) {
    if (e.kind === "aborted") {
      acc = (e.partial || acc) + "\n\n_(stopped)_";
      paint();
      state.messages.push({ role: "assistant", content: acc });
    } else {
      body.parentElement.remove();
      bubble("error", `${e.message || e} Your message is kept; press Send again after fixing the connection.`);
      $("msg").value = text;
      state.messages.pop(); // the unanswered question goes back into the input box
      if (e.kind === "unreachable") { state.connected = false; setStatus("bad", "Connection lost."); showHelp(e); }
      warn("chat failed", e.kind, e.message);
    }
  } finally {
    save();
    refresh();
  }
}

// ---------- proposal ----------
function buildFields() {
  const box = $("fields");
  box.replaceChildren();
  for (const f of FIELDS) {
    const label = document.createElement("label");
    label.htmlFor = "p-" + f.id;
    label.textContent = f.label + " ";
    const tag = document.createElement("span");
    tag.className = f.required ? "req" : "opt";
    tag.textContent = f.required ? "*" : "(optional)";
    if (f.required) tag.setAttribute("aria-hidden", "true");
    label.append(tag);
    const hint = document.createElement("span");
    hint.className = "field-hint";
    hint.id = "h-" + f.id;
    hint.textContent = f.hint;
    label.append(hint);
    const ta = document.createElement("textarea");
    ta.id = "p-" + f.id;
    ta.rows = 3;
    ta.maxLength = 4000;
    ta.required = f.required;
    ta.setAttribute("aria-describedby", hint.id);
    ta.addEventListener("input", () => {
      state.proposal[f.id] = ta.value;
      ta.classList.remove("invalid");
      ta.removeAttribute("aria-invalid");
      save();
      refresh();
    });
    box.append(label, ta);
  }
}

function fillFields() {
  for (const f of FIELDS) $("p-" + f.id).value = state.proposal[f.id];
  $("p-review").value = state.proposal.review;
  $("include-review").checked = state.proposal.includeReview !== false;
  $("review-box").hidden = !state.proposal.review.trim();
}

// The AI expands the visitor's answers (and the conversation, if any) into a full proposal.
// It never overwrites what the visitor wrote; it only fills empty answers and the review.
async function generate() {
  if (state.proposal.review.trim() && !confirm("Replace the current engineering review with a new AI draft?")) return;
  const note = $("gen-note");
  note.textContent = "The AI is expanding your idea…";
  let raw = "";
  try {
    raw = await stream(history(expansionPrompt(state.proposal)), (piece) => { raw += piece; note.textContent = `The AI is writing… ${raw.length} characters`; });
  } catch (e) {
    if (e.kind !== "aborted") { note.textContent = `Could not expand the idea: ${e.message}`; warn("expand failed", e); return; }
    raw = e.partial || raw;
  }
  const x = parseExpansion(raw);
  if (!x.review) {
    note.textContent = "The model did not return the expected structure. Try again or try a larger model. You can also submit your answers as they are.";
    return;
  }
  const p = state.proposal;
  // Numbers in AI pass criteria must come from the requirements or the visitor; otherwise "To be defined and validated".
  const visitorText = FIELDS.map((f) => p[f.id]).join("\n");
  x.review = guardCriteria(x.review, visitorText);
  x.test = guardCriteria(x.test, visitorText);
  const filled = [];
  for (const f of FIELDS) if (!p[f.id].trim() && x[f.id]) { p[f.id] = x[f.id]; filled.push(f.label); }
  if (!p.title.trim() && x.title) p.title = x.title;
  p.review = x.review;
  p.includeReview = true;
  state.draftedWith = state.model;
  fillFields();
  $("review-box").open = true;
  save();
  refresh();
  note.textContent = "Engineering review ready below. Read it and correct anything wrong before you submit." +
    (filled.length ? ` The AI also filled in: ${filled.join(", ")}.` : "");
}

function markdown() {
  return toMarkdown(state.proposal, { model: state.draftedWith });
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch (e) { warn("clipboard failed", e); return false; }
}

function openConsent() {
  const missing = missingRequired(state.proposal);
  for (const f of FIELDS) {
    const bad = missing.includes(f.label);
    $("p-" + f.id).classList.toggle("invalid", bad);
    if (bad) $("p-" + f.id).setAttribute("aria-invalid", "true");
  }
  if (missing.length) {
    $("editor-note").textContent = `Please answer: ${missing.join(" and ")}`;
    $("p-" + FIELDS.find((f) => missing.includes(f.label)).id).focus();
    return;
  }
  $("editor-note").textContent = "";
  $("p-title").value = autoTitle(state.proposal);
  $("consent-review").hidden = !(state.proposal.includeReview && state.proposal.review.trim());
  $("agree").checked = false;
  $("go").disabled = true;
  $("consent-note").textContent = "";
  const dlg = $("consent");
  if (typeof dlg.showModal === "function") dlg.showModal();
  else if (confirm("The proposal will be public on GitHub under your account. Your chat is not included. Continue?")) submit();
}

function submit() {
  const md = markdown();
  const { url, bodyIncluded } = discussionUrl(state.proposal, md);
  if (!bodyIncluded) copyText(md);
  window.open(url, "_blank", "noopener");
  $("editor-note").textContent = bodyIncluded
    ? "GitHub opened in a new tab. Check the text and press “Start discussion” there."
    : "Your proposal is long, so it was copied to the clipboard. Paste it into the GitHub page that opened, then press “Start discussion”.";
  log("submit link opened", { bodyIncluded, length: url.length });
}

// ---------- giscus ----------
function loadGiscus() {
  if (!GISCUS.repoId || !GISCUS.categoryId) return;
  const s = document.createElement("script");
  s.src = "https://giscus.app/client.js";
  const attrs = {
    "data-repo": GISCUS.repo, "data-repo-id": GISCUS.repoId, "data-category": GISCUS.category,
    "data-category-id": GISCUS.categoryId, "data-mapping": "specific", "data-term": "Engineering Lab",
    "data-reactions-enabled": "1", "data-input-position": "top", "data-theme": "preferred_color_scheme",
    "data-lang": "en", "data-loading": "lazy", crossorigin: "anonymous",
  };
  for (const [k, v] of Object.entries(attrs)) s.setAttribute(k, v);
  s.async = true;
  $("giscus-slot").append(s);
}

// ---------- wiring ----------
function refresh() {
  const ready = state.connected && !!state.system && !state.busy;
  $("msg").disabled = !(state.connected && state.system);
  $("send").disabled = !ready;
  const p = state.proposal;
  $("generate").disabled = !(ready && (p.idea.trim() || p.why.trim() || state.messages.length >= 2));
  $("clear").disabled = state.busy || state.messages.length === 0;
  $("chat-note").textContent = !state.system ? "The project brief could not be loaded; the AI is unavailable."
    : !state.connected ? "Connect to Ollama to start."
    : state.busy ? "The model is answering…" : "Enter sends, Shift+Enter adds a line.";
}

function init() {
  load();
  $("endpoint").value = state.endpoint;
  buildFields();
  fillFields();
  renderLog();
  refresh();

  loadKnowledge().then(refresh, (e) => { warn("knowledge failed", e); refresh(); });

  $("connect").addEventListener("click", connect);
  $("model").addEventListener("change", (e) => { state.model = e.target.value; save(); });
  $("composer").addEventListener("submit", (e) => {
    e.preventDefault();
    const text = $("msg").value.trim();
    if (!text || $("send").disabled) return;
    $("msg").value = "";
    send(text);
  });
  $("msg").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); $("composer").requestSubmit(); }
  });
  $("stop").addEventListener("click", () => state.abort && state.abort.abort());
  $("clear").addEventListener("click", () => {
    if (!confirm("Delete this conversation from this browser?")) return;
    state.messages = [];
    renderLog();
    save();
    refresh();
  });
  $("generate").addEventListener("click", generate);
  $("p-title").addEventListener("input", (e) => { state.proposal.title = e.target.value; save(); });
  $("p-review").addEventListener("input", (e) => { state.proposal.review = e.target.value; save(); });
  $("include-review").addEventListener("change", (e) => { state.proposal.includeReview = e.target.checked; save(); });
  $("copy-md").addEventListener("click", async () => {
    $("editor-note").textContent = (await copyText(markdown())) ? "Copied as Markdown." : "Copy failed. Use Download .md instead.";
  });
  $("download-md").addEventListener("click", () => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([markdown()], { type: "text/markdown" }));
    a.download = autoTitle(state.proposal).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) + ".md";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
  $("reset-p").addEventListener("click", () => {
    if (!confirm("Clear your answers and the AI review?")) return;
    state.proposal = emptyProposal();
    state.draftedWith = "";
    fillFields();
    save();
    refresh();
  });
  $("submit").addEventListener("click", openConsent);
  $("agree").addEventListener("change", (e) => { $("go").disabled = !e.target.checked; });
  $("go").addEventListener("click", (e) => {
    e.preventDefault();
    if (!$("agree").checked) return;
    $("consent").close();
    submit();
  });

  // never lose a pending save when the tab closes or reloads
  addEventListener("pagehide", () => { if (saveTimer) flush(); });
  addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden" && saveTimer) flush(); });

  loadGiscus();
  log("ready");
}

init();
