// Minimal client for a local Ollama server (https://github.com/ollama/ollama/blob/main/docs/api.md).
// Talks only to loopback addresses, so a crafted link can never send a visitor's chat elsewhere.

// 11435: the temporary "lab session" server the setup steps recommend (only it is allowed to talk to this site).
// 11434: Ollama's normal port, for visitors who allowed the site permanently.
export const LAB_ENDPOINT = "http://127.0.0.1:11435";
export const DEFAULT_ENDPOINT = LAB_ENDPOINT;
export const AUTO_ENDPOINTS = [LAB_ENDPOINT, "http://127.0.0.1:11434"];

const LOOPBACK = /^http:\/\/(127\.0\.0\.1|localhost):(\d{1,5})$/;

// Returns a normalised loopback endpoint, or throws.
export function checkEndpoint(raw) {
  const url = String(raw || "").trim().replace(/\/+$/, "");
  const m = LOOPBACK.exec(url);
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 65535) {
    throw new OllamaError("bad-endpoint", "Only a local address such as http://127.0.0.1:11434 is allowed.");
  }
  return url;
}

export class OllamaError extends Error {
  constructor(kind, message) {
    super(message);
    this.kind = kind; // bad-endpoint | unreachable | timeout | http | no-models | aborted | bad-response
  }
}

// Best guess at why the browser could not reach Ollama. The browser hides the real cause
// (not running, CORS refused, mixed content, local-network permission denied), so we explain by browser.
export function browserHint(ua = (globalThis.navigator && navigator.userAgent) || "") {
  const isSafari = /Safari\//.test(ua) && !/(Chrome|Chromium|CriOS|Edg|OPR|Firefox|FxiOS)\//.test(ua);
  const isMobile = /(Android|iPhone|iPad|Mobile)/.test(ua);
  if (isMobile) return "mobile";
  if (isSafari) return "safari";
  if (/Firefox\//.test(ua)) return "firefox";
  return "chromium";
}

async function request(endpoint, path, { method = "GET", body, signal, timeoutMs = 4000 } = {}) {
  const ctl = new AbortController();
  const timer = timeoutMs ? setTimeout(() => ctl.abort("timeout"), timeoutMs) : null;
  const onAbort = () => ctl.abort("aborted");
  if (signal) signal.addEventListener("abort", onAbort, { once: true });
  try {
    const res = await fetch(checkEndpoint(endpoint) + path, {
      method,
      body: body ? JSON.stringify(body) : undefined,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      signal: ctl.signal,
      credentials: "omit",
      referrerPolicy: "no-referrer",
    });
    if (!res.ok) {
      let detail = "";
      try { detail = (await res.json()).error || ""; } catch { /* not JSON */ }
      throw new OllamaError("http", `Ollama answered ${res.status}${detail ? ": " + detail : ""}`);
    }
    return res;
  } catch (e) {
    if (e instanceof OllamaError) throw e;
    if (ctl.signal.aborted) {
      throw ctl.signal.reason === "timeout"
        ? new OllamaError("timeout", "Ollama did not answer in time.")
        : new OllamaError("aborted", "Stopped.");
    }
    throw new OllamaError("unreachable", "The browser could not reach Ollama.");
  } finally {
    if (timer) clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", onAbort);
  }
}

// Lists installed models: [{name, size, family}]
export async function listModels(endpoint) {
  const res = await request(endpoint, "/api/tags");
  let data;
  try { data = await res.json(); } catch { throw new OllamaError("bad-response", "Unexpected answer from Ollama."); }
  const models = (data.models || [])
    .filter((m) => m && typeof m.name === "string")
    .filter((m) => !/embed/i.test(m.name)) // embedding models cannot chat
    .map((m) => ({ name: m.name, size: m.size || 0, family: (m.details && m.details.family) || "" }));
  if (!models.length) throw new OllamaError("no-models", "Ollama is running but has no chat model installed.");
  return models;
}

// Splits a streamed NDJSON body into objects. Keeps a partial last line between chunks.
export function createNdjsonParser(onObject) {
  let buf = "";
  return {
    push(text) {
      buf += text;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) onObject(JSON.parse(line));
      }
    },
    end() {
      const line = buf.trim();
      buf = "";
      if (line) onObject(JSON.parse(line));
    },
  };
}

// Streams a chat answer. onToken(text) is called for every piece. Returns the full answer.
export async function chat(endpoint, { model, messages, onToken, signal, numCtx = 8192, temperature = 0.4 }) {
  const res = await request(endpoint, "/api/chat", {
    method: "POST",
    body: { model, messages, stream: true, options: { num_ctx: numCtx, temperature } },
    signal,
    timeoutMs: 0, // a local model can take a while for the first token; the user can press Stop
  });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let full = "";
  let failure = null;
  const parser = createNdjsonParser((obj) => {
    if (obj.error) failure = new OllamaError("http", String(obj.error));
    const piece = obj.message && typeof obj.message.content === "string" ? obj.message.content : "";
    if (piece) {
      full += piece;
      if (onToken) onToken(piece);
    }
  });
  const stopped = () => {
    const e = new OllamaError("aborted", "Stopped.");
    e.partial = full;
    return e;
  };
  const onAbort = () => reader.cancel().catch(() => {});
  if (signal) signal.addEventListener("abort", onAbort, { once: true });
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      parser.push(decoder.decode(value, { stream: true }));
      if (failure) throw failure;
    }
    if (signal && signal.aborted) throw stopped();
    parser.end();
  } catch (e) {
    if (e instanceof OllamaError) throw e;
    if (signal && signal.aborted) throw stopped();
    throw new OllamaError("bad-response", "The answer stream broke off.");
  } finally {
    if (signal) signal.removeEventListener("abort", onAbort);
  }
  if (failure) throw failure;
  return full;
}
