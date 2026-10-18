// End-to-end tests: drive the real lab page in an iframe against mock Ollama servers.
// Ports come from the query string, set by tests/run_tests.py.
const q = new URLSearchParams(location.search);
const GOOD = q.get("good"), REFUSED = q.get("refused"), DEAD = q.get("dead");
const KEY = "scooter-lab.v1";
const frame = document.getElementById("lab");
const results = [];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, what, timeout = 8000) {
  const t0 = performance.now();
  for (;;) {
    try { const v = fn(); if (v) return v; } catch { /* not ready */ }
    if (performance.now() - t0 > timeout) throw new Error("timeout waiting for " + what);
    await sleep(40);
  }
}
async function open(saved) {
  frame.src = "about:blank"; // unload the previous page first, so its pagehide save cannot overwrite our setup
  await new Promise((r) => frame.addEventListener("load", r, { once: true }));
  localStorage.clear();
  if (saved) localStorage.setItem(KEY, JSON.stringify(saved));
  frame.src = "../lab/index.html?t=" + Math.random();
  await new Promise((r) => frame.addEventListener("load", r, { once: true }));
  const d = frame.contentDocument;
  await waitFor(() => d.getElementById("connect"), "page");
  return { d, w: frame.contentWindow, $: (id) => d.getElementById(id) };
}
async function test(name, fn) {
  try { await fn(); results.push({ name, ok: true }); } catch (e) { results.push({ name, ok: false, err: String(e && e.message || e) }); }
}
function ok(v, msg) { if (!v) throw new Error(msg); }

const setField = ($, id, v) => { $(id).value = v; $(id).dispatchEvent(new Event("input")); };

await test("page loads without Ollama: short form with two required questions", async () => {
  const { $, d } = await open({ endpoint: `http://127.0.0.1:${DEAD}` });
  ok($("send").disabled && $("generate").disabled, "AI controls disabled before connect");
  ok(d.querySelectorAll("#fields textarea").length === 3, "3 questions");
  ok($("review-box").hidden, "no AI review section without AI");
  setField($, "p-idea", "Use one MCU.");
  $("submit").click();
  ok(!$("consent").open, "dialog not opened");
  ok(/Please answer: Why is it better\?/.test($("editor-note").textContent), "asks for the missing answer");
  ok($("p-why").getAttribute("aria-invalid") === "true" && d.activeElement === $("p-why"), "missing field marked and focused");
});

await test("visitor without Ollama answers three questions and submits", async () => {
  const { $, w } = await open({ endpoint: `http://127.0.0.1:${DEAD}` });
  setField($, "p-idea", "Radar-only detection on one automotive MCU. Drop the camera.");
  setField($, "p-why", "Fewer parts and one processor to verify.");
  let url = "";
  w.open = (u) => { url = u; return null; };
  $("submit").click();
  ok($("consent").open, "consent dialog open");
  ok($("p-title").value === "Radar-only detection on one automotive MCU", "title suggested from the idea");
  ok($("consent-review").hidden, "dialog does not mention an AI review");
  $("agree").click();
  $("go").click();
  const body = decodeURIComponent(url);
  ok(url.includes("category=engineering-proposals") && url.includes("title=Radar-only%20detection%20on%20one%20automotive%20MCU"), "discussion link");
  ok(body.includes("## Idea\n\nRadar-only detection") && body.includes("## Why it is better\n\nFewer parts"), "answers in body");
  ok(!body.includes("How I would test it") && !body.includes("Engineering review") && !body.includes("local AI"), "nothing AI-related or empty");
});

await test("Ollama not running: clear status and help", async () => {
  const { $ } = await open({ endpoint: `http://127.0.0.1:${DEAD}` });
  $("connect").click();
  await waitFor(() => $("status-text").textContent === "Ollama not reachable.", "unreachable status");
  ok(!$("help").hidden, "help shown"); ok($("setup").open, "setup opened");
  ok(/OLLAMA_ORIGINS/.test($("help").textContent) && /11435/.test($("help").textContent), "mentions the lab session settings");
});

await test("CORS refused by Ollama: reported as unreachable", async () => {
  const { $ } = await open({ endpoint: `http://127.0.0.1:${REFUSED}` });
  $("connect").click();
  await waitFor(() => $("status-text").textContent === "Ollama not reachable.", "refused status");
});

await test("non-local address is refused before any request", async () => {
  const { $ } = await open();
  $("endpoint").value = "https://evil.example:11434";
  $("connect").click();
  await waitFor(() => $("status-text").textContent === "Address not allowed.", "refusal");
});

let captured = "";
await test("connect, chat, safe rendering, AI expansion of the three answers, consent and submit link", async () => {
  const { $, d, w } = await open({ endpoint: `http://127.0.0.1:${GOOD}` });
  $("connect").click();
  await waitFor(() => $("status-text").textContent.startsWith("Connected"), "connected");
  ok($("model").options.length === 1 && $("model").value === "qwen2.5:7b", "embedding model filtered, chat model picked");
  await waitFor(() => !$("send").disabled, "send enabled");

  $("msg").value = "Why use a Raspberry Pi and an STM32? A single ESP32-S3 might be enough.";
  $("composer").requestSubmit();
  await waitFor(() => !$("send").disabled && d.querySelectorAll(".msg.assistant").length === 1, "first answer");
  const a = d.querySelector(".msg.assistant");
  ok(/Interesting alternative/.test(a.textContent), "answer text");
  ok(a.querySelector("strong") && a.querySelectorAll("li").length === 2, "markdown rendered");

  $("msg").value = 'ECHO:<img src=x onerror="parent.__pwned=1"><script>parent.__pwned=1</script>';
  $("composer").requestSubmit();
  await waitFor(() => !$("send").disabled && d.querySelectorAll(".msg.assistant").length === 2, "echo answer");
  await sleep(200);
  ok(d.querySelectorAll("#log img, #log script").length === 0, "no injected elements");
  ok(window.__pwned === undefined, "no script ran");

  setField($, "p-idea", "One MCU");
  setField($, "p-why", "Cheaper");
  ok(!$("generate").disabled, "Expand with AI enabled");
  $("generate").click();
  await waitFor(() => /Engineering review ready/.test($("gen-note").textContent), "review ready");
  ok($("p-idea").value === "One MCU" && $("p-why").value === "Cheaper", "visitor's answers not overwritten");
  ok(/detection range/.test($("p-test").value), "empty optional answer filled by the AI");
  ok(/The AI also filled in: How would you test it\?/.test($("gen-note").textContent), "tells the visitor what it filled");
  ok(!$("review-box").hidden && $("review-box").open, "review shown");
  const review = $("p-review").value;
  ok(/^### Architecture/.test(review) && /### Requirements check \(FR-1 to FR-8\)/.test(review) && /### Validation suggestions/.test(review), "review sections");
  ok(/Unknown heading/.test(review), "unknown heading kept");
  ok(/Pass criterion: below 20 ms\./.test(review) && /Detection range; Pass criterion: To be defined and validated\./.test(review), "invented criterion replaced, requirement value kept");

  w.open = (url) => { captured = url; return null; };
  $("submit").click();
  ok($("consent").open, "consent dialog open");
  ok($("p-title").value === "Single ESP32-S3 with radar-only detection", "AI title offered");
  ok(!$("consent-review").hidden, "dialog says the review is included");
  ok($("go").disabled, "cannot submit before agreeing");
  $("agree").click();
  ok(!$("go").disabled, "agree enables submit");
  $("go").click();
  ok(!$("consent").open, "dialog closed");
  ok(captured.startsWith("https://github.com/karimsamy11/scooter-acc-expose/discussions/new?category=engineering-proposals&title=Single%20ESP32-S3"), "discussion link: " + captured.slice(0, 120));
  const body = decodeURIComponent(captured);
  ok(body.includes("## Engineering review") && body.includes("Drafted by a local AI model (qwen2.5:7b)"), "review and attribution");
  ok(!body.includes("Why use a Raspberry Pi"), "chat not included in submission");

  $("include-review").click();
  $("submit").click(); $("agree").click(); $("go").click();
  ok(!decodeURIComponent(captured).includes("Engineering review"), "review left out when unticked");
  $("include-review").click();
});

await test("conversation and proposal survive a reload", async () => {
  frame.src = "about:blank"; // closing the page must flush the pending save
  await new Promise((r) => frame.addEventListener("load", r, { once: true }));
  const saved = JSON.parse(localStorage.getItem(KEY));
  const { $, d } = await open(saved);
  await waitFor(() => d.querySelectorAll(".msg").length === 4, "4 restored messages");
  ok($("p-idea").value === "One MCU" && /### Architecture/.test($("p-review").value) && !$("review-box").hidden, "answers and review restored");
});

await test("stop button ends an answer and keeps the partial text", async () => {
  const saved = JSON.parse(localStorage.getItem(KEY));
  const { $, d } = await open(saved);
  $("connect").click();
  await waitFor(() => !$("send").disabled, "connected");
  $("msg").value = "ECHO:" + "long answer ".repeat(3000);
  $("composer").requestSubmit();
  await waitFor(() => !$("stop").hidden, "stop visible");
  $("stop").click();
  await waitFor(() => $("stop").hidden && /stopped/.test(d.querySelectorAll(".msg.assistant")[2]?.textContent || ""), "stopped");
});

const pass = results.filter((r) => r.ok).length;
const report = { suite: "e2e", pass, total: results.length, results };
document.getElementById("out").textContent = JSON.stringify(report, null, 2);
fetch("/__result", { method: "POST", body: JSON.stringify(report) }).catch(() => {});
