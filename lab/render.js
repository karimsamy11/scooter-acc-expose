// Renders a small, safe subset of Markdown (paragraphs, lists, code, bold, inline code, headings)
// by building DOM nodes. Text is only ever assigned through textContent, never innerHTML,
// so model output and visitor text cannot inject HTML or scripts.

function inline(parent, text) {
  const re = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > last) parent.append(document.createTextNode(text.slice(last, m.index)));
    const tok = m[0];
    const el = document.createElement(tok.startsWith("**") ? "strong" : "code");
    el.textContent = tok.startsWith("**") ? tok.slice(2, -2) : tok.slice(1, -1);
    parent.append(el);
    last = m.index + tok.length;
  }
  if (last < text.length) parent.append(document.createTextNode(text.slice(last)));
}

export function renderMarkdown(target, md) {
  target.replaceChildren();
  const lines = String(md || "").replace(/\r\n?/g, "\n").split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^```/.test(line)) {
      const pre = document.createElement("pre");
      const code = document.createElement("code");
      const body = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) body.push(lines[i++]);
      i++;
      code.textContent = body.join("\n");
      pre.append(code);
      target.append(pre);
      continue;
    }
    if (/^\s*([-*•]|\d+[.)])\s+/.test(line)) {
      const ordered = /^\s*\d+[.)]\s+/.test(line);
      const list = document.createElement(ordered ? "ol" : "ul");
      while (i < lines.length && /^\s*([-*•]|\d+[.)])\s+/.test(lines[i])) {
        const li = document.createElement("li");
        inline(li, lines[i].replace(/^\s*([-*•]|\d+[.)])\s+/, ""));
        list.append(li);
        i++;
      }
      target.append(list);
      continue;
    }
    const h = /^#{1,4}\s+(.+)$/.exec(line);
    if (h) {
      const el = document.createElement("p");
      el.className = "md-h";
      inline(el, h[1]);
      target.append(el);
      i++;
      continue;
    }
    if (!line.trim()) { i++; continue; }
    const para = [];
    while (i < lines.length && lines[i].trim() && !/^```|^#{1,4}\s|^\s*([-*•]|\d+[.)])\s+/.test(lines[i])) para.push(lines[i++]);
    const p = document.createElement("p");
    inline(p, para.join(" "));
    target.append(p);
  }
}
