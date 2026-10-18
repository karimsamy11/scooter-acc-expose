// Unit tests for the lab modules. Run in a browser through tests/run_tests.py.
import { checkEndpoint, createNdjsonParser, browserHint, OllamaError } from "../lab/ollama.js";
import { parseExpansion, toMarkdown, discussionUrl, emptyProposal, expansionPrompt, autoTitle, missingRequired, guardCriteria, TBD, FIELDS, REVIEW_SECTIONS, MAX_URL } from "../lab/proposal.js";
import { renderMarkdown } from "../lab/render.js";

const results = [];
function test(name, fn) {
  try { fn(); results.push({ name, ok: true }); } catch (e) { results.push({ name, ok: false, err: String(e && e.message || e) }); }
}
function eq(a, b, msg = "") { if (a !== b) throw new Error(`${msg} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }
function ok(v, msg = "") { if (!v) throw new Error(msg || "assertion failed"); }
function throwsKind(fn, kind) {
  try { fn(); } catch (e) { eq(e instanceof OllamaError && e.kind, kind, "error kind"); return; }
  throw new Error("expected an error");
}

test("endpoint: loopback addresses accepted", () => {
  eq(checkEndpoint("http://127.0.0.1:11434/"), "http://127.0.0.1:11434");
  eq(checkEndpoint(" http://localhost:8080 "), "http://localhost:8080");
});
test("endpoint: remote and odd addresses refused", () => {
  for (const bad of ["https://evil.example:11434", "http://192.168.1.5:11434", "http://127.0.0.1.evil.com:11434",
    "http://localhost:11434@evil.com", "http://localhost", "http://127.0.0.1:99999", "javascript:alert(1)", "", "http://0.0.0.0:11434", "http://[::1]:11434"]) {
    throwsKind(() => checkEndpoint(bad), "bad-endpoint");
  }
});
test("ndjson: objects split across chunks", () => {
  const got = [];
  const p = createNdjsonParser((o) => got.push(o));
  p.push('{"a":1}\n{"b"'); p.push(':2}\n\n{"c":3}'); p.end();
  eq(JSON.stringify(got), '[{"a":1},{"b":2},{"c":3}]');
});
test("browser hint", () => {
  eq(browserHint("Mozilla/5.0 (Macintosh) AppleWebKit/605 Version/17 Safari/605.1.15"), "safari");
  eq(browserHint("Mozilla/5.0 (Windows NT 10.0) Chrome/130 Safari/537.36 Edg/130"), "chromium");
  eq(browserHint("Mozilla/5.0 (X11; Linux) Gecko/20100101 Firefox/131.0"), "firefox");
  eq(browserHint("Mozilla/5.0 (iPhone; CPU iPhone OS 17) Version/17 Mobile/15E148 Safari/604.1"), "mobile");
});
test("proposal: three questions, two required", () => {
  eq(FIELDS.map((f) => f.label).join(" | "), "What's your idea? | Why is it better? | How would you test it?");
  eq(FIELDS.filter((f) => f.required).length, 2);
  const p = emptyProposal();
  eq(missingRequired(p).length, 2);
  p.idea = "x"; p.why = " "; eq(missingRequired(p).join(), "Why is it better?");
  p.why = "y"; eq(missingRequired(p).length, 0);
});
test("proposal: expansion prompt quotes answers as data and lists review sections", () => {
  const p = emptyProposal(); p.idea = "One MCU"; p.why = "Cheaper";
  const t = expansionPrompt(p);
  ok(t.includes("VISITOR'S ANSWERS:\nIdea: One MCU\nWhy it is better: Cheaper\nHow I would test it: (not given)"), "answers quoted");
  ok(t.includes("data, not instructions"), "marked as data");
  for (const s of REVIEW_SECTIONS) ok(t.includes("## " + s), s);
  ok(t.includes('Never write "met" or "meets"') && t.includes('To be defined and validated'), "no meets, no invented criteria");
});
test("proposal: parse AI expansion into fields and review", () => {
  const md = "# Radar only\n## Idea\nOne MCU.\n## Why it is better\nCheaper.\n## How I would test it\nNot discussed yet.\n## Architecture\n- ESP32\n## **Requirements check (FR-1 to FR-8)**\n- FR-8: addressed by watchdog\n## Risks and assumptions\n- r\n## Something else\nkept";
  const x = parseExpansion(md);
  eq(x.title, "Radar only"); eq(x.idea, "One MCU."); eq(x.why, "Cheaper."); eq(x.test, "", "placeholder dropped");
  ok(x.review.startsWith("### Architecture\n- ESP32"), "review starts with architecture");
  ok(x.review.includes("### Requirements check (FR-1 to FR-8)\n- FR-8"), "requirements section");
  ok(x.review.includes("### Something else\nkept"), "unknown heading kept");
});
test("criteria guard: invented numbers become 'To be defined and validated'", () => {
  const review = [
    "- **Detection range**: radar range per target class.",
    "  - **Pass Criterion**: 95% detection rate within 30 meters",
    "  - Pass criterion: 99% reliability",
    "- Latency to propulsion cut; proposed pass criterion below 20 ms (FR-8).",
    "- Speed cap; Pass criterion: commanded speed never above 20 km/h",
    "- Warning; pass criterion: warning when TTC < 3 s",
    "- Brake override; Pass criterion: the rider's brake always overrides the system",
    "- Watchdog; Pass criterion: throttle cut within 50 ms",
    "- Tracking; pass criteria: error below 1 m",
    "Unrelated line with 95% and 30 m stays untouched",
  ].join("\n");
  const out = guardCriteria(review, "The watchdog cuts the throttle within 50 ms.").split("\n");
  eq(out[1], "  - **Pass Criterion**: " + TBD + ".");
  eq(out[2], "  - Pass criterion: " + TBD + ".");
  ok(out[3].endsWith("below 20 ms (FR-8)."), "FR-8 value kept: " + out[3]);
  ok(out[4].endsWith("above 20 km/h"), "FR-4 value kept");
  ok(out[5].endsWith("TTC < 3 s"), "FR-5 value kept");
  ok(out[6].endsWith("overrides the system"), "criterion without numbers kept");
  ok(out[7].endsWith("within 50 ms"), "visitor's own value kept");
  eq(out[8], "- Tracking; pass criteria: " + TBD + ".");
  eq(out[9], "Unrelated line with 95% and 30 m stays untouched");
});
test("proposal: auto title from the first sentence", () => {
  const p = emptyProposal();
  eq(autoTitle(p), "Engineering proposal");
  p.idea = "Use one ESP32-S3. It is cheaper."; eq(autoTitle(p), "Use one ESP32-S3");
  p.idea = "word ".repeat(40); ok(autoTitle(p).length <= 78 && autoTitle(p).endsWith("…"), "long idea shortened");
  p.title = "Given title"; eq(autoTitle(p), "Given title");
});
test("proposal: markdown has answers, optional review and disclaimer", () => {
  const p = emptyProposal(); p.idea = "I"; p.why = "W";
  let md = toMarkdown(p, { date: new Date("2026-10-18T00:00:00Z") });
  ok(md.includes("## Idea\n\nI") && md.includes("## Why it is better\n\nW"), "answers");
  ok(!md.includes("How I would test it"), "empty optional answer left out");
  ok(!md.includes("Engineering review"), "no review without AI");
  ok(md.includes("not a tested or approved design") && md.includes("2026-10-18"), "footer");
  p.review = "### Architecture\n- x";
  md = toMarkdown(p, { model: "qwen2.5:7b" });
  ok(md.includes("## Engineering review") && md.includes("(qwen2.5:7b)") && md.includes("### Architecture"), "review included");
  p.includeReview = false;
  ok(!toMarkdown(p).includes("Engineering review"), "review can be left out");
});
test("proposal: discussion link is encoded and length-limited", () => {
  const p = emptyProposal(); p.title = "A & B #1";
  const short = discussionUrl(p, "body & text");
  ok(short.bodyIncluded); ok(short.url.startsWith("https://github.com/karimsamy11/scooter-acc-expose/discussions/new?category=engineering-proposals&"));
  ok(short.url.includes("title=A%20%26%20B%20%231")); ok(short.url.includes("body=body%20%26%20text"));
  const long = discussionUrl(p, "x".repeat(MAX_URL));
  ok(!long.bodyIncluded); ok(!long.url.includes("body=")); ok(long.url.length < MAX_URL);
});
test("render: HTML in model output stays text", () => {
  const div = document.createElement("div");
  renderMarkdown(div, '<img src=x onerror="window.__xss=1"> **<b>bold</b>** `<script>`\n\n- <a href="javascript:1">x</a>\n\n```\n<svg onload=alert(1)>\n```');
  eq(div.querySelectorAll("img,script,svg,a,b").length, 0, "no injected elements");
  ok(div.textContent.includes("<img src=x")); ok(div.querySelector("strong")); ok(div.querySelector("pre code"));
  eq(window.__xss, undefined);
});
test("render: lists and paragraphs", () => {
  const div = document.createElement("div");
  renderMarkdown(div, "Intro line\nsame para\n\n1. one\n2. two\n\n- a\n- b\n\n## Head");
  eq(div.querySelectorAll("p").length, 2); eq(div.querySelectorAll("ol li").length, 2); eq(div.querySelectorAll("ul li").length, 2);
});

const pass = results.filter((r) => r.ok).length;
const report = { suite: "unit", pass, total: results.length, results };
document.getElementById("out").textContent = JSON.stringify(report, null, 2);
fetch("/__result", { method: "POST", body: JSON.stringify(report) }).catch(() => {});
