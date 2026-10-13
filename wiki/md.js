// A small Markdown renderer for Blockfieldpedia articles: front matter, ## / ### headings, paragraphs, - and 1. lists (two levels),
// pipe tables, **bold**, *italic*, `code`, [text](url) and wiki links [[kind:name|label]]. link(kind, name, label) returns the HTML of a wiki link.
(() => {
"use strict";
const esc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function frontMatter(src) {
  const meta = {};
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(src);
  if (!m) return { meta, body: src };
  for (const line of m[1].split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return { meta, body: src.slice(m[0].length) };
}

function inline(s, link) {
  const codes = [];
  s = s.replace(/`([^`]+)`/g, (_, c) => { codes.push(c); return "\u0000" + (codes.length - 1) + "\u0000"; });
  const links = [];
  s = s.replace(/\[\[([a-z_]+):([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, k, n, l) => { links.push(link(k, n.trim(), l && l.trim())); return "\u0001" + (links.length - 1) + "\u0001"; });
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t, u) => { links.push(`<a href="${esc(u)}">${inline(t, link)}</a>`); return "\u0001" + (links.length - 1) + "\u0001"; });
  s = esc(s)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?!\*)/g, "$1<em>$2</em>")
    .replace(/(^|\W)_([^_\s][^_]*?)_(?=\W|$)/g, "$1<em>$2</em>");
  return s.replace(/\u0001(\d+)\u0001/g, (_, i) => links[+i]).replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${esc(codes[+i])}</code>`);
}

const cells = row => row.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map(c => c.trim());

function render(src, link, slug) {
  const lines = src.replace(/\r/g, "").split("\n"), out = [];
  let para = [];
  const flush = () => { if (para.length) { out.push(`<p>${inline(para.join(" "), link)}</p>`); para = []; } };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m;
    if (!line.trim()) { flush(); continue; }
    if ((m = /^(#{1,4})\s+(.*)$/.exec(line))) {
      flush();
      const lv = Math.max(2, m[1].length), id = slug ? slug(m[2]) : "";
      out.push(`<h${lv}${id ? ` id="${id}"` : ""}>${inline(m[2], link)}</h${lv}>`);
      continue;
    }
    if (/^\s*\|/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
      flush();
      const head = cells(line);
      i++;
      const rows = [];
      while (i + 1 < lines.length && /^\s*\|/.test(lines[i + 1])) rows.push(cells(lines[++i]));
      out.push(`<table class="wt"><thead><tr>${head.map(c => `<th>${inline(c, link)}</th>`).join("")}</tr></thead><tbody>` +
        rows.map(r => `<tr>${r.map(c => `<td>${inline(c, link)}</td>`).join("")}</tr>`).join("") + "</tbody></table>");
      continue;
    }
    if ((m = /^(\s*)([-*]|\d+\.)\s+(.*)$/.exec(line))) {
      flush();
      const ordered = /\d/.test(m[2]);
      const items = [];   // [{text, sub: []}]
      let j = i;
      for (; j < lines.length; j++) {
        const l = lines[j], lm = /^(\s*)([-*]|\d+\.)\s+(.*)$/.exec(l);
        if (lm) {
          if (lm[1].length >= 2 && items.length) items[items.length - 1].sub.push(lm[3]);
          else items.push({ text: lm[3], sub: [] });
        } else if (l.trim() && /^\s{2,}/.test(l) && items.length) {
          const it = items[items.length - 1];
          if (it.sub.length) it.sub[it.sub.length - 1] += " " + l.trim(); else it.text += " " + l.trim();
        } else break;
      }
      i = j - 1;
      const tag = ordered ? "ol" : "ul";
      out.push(`<${tag}>` + items.map(it => `<li>${inline(it.text, link)}` +
        (it.sub.length ? `<ul>${it.sub.map(s => `<li>${inline(s, link)}</li>`).join("")}</ul>` : "") + "</li>").join("") + `</${tag}>`);
      continue;
    }
    para.push(line.trim());
  }
  flush();
  return out.join("\n");
}

window.WikiMD = { render, inline, frontMatter, esc };
})();
