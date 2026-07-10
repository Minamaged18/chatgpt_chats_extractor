#!/usr/bin/env node
/**
 * Perplexity Conversation Exporter — Node.js with local web UI.
 * Starts a local server, opens a browser with a nice UI,
 * user pastes their session cookie, and threads are exported.
 *
 * Usage: node export-perplexity.mjs
 * Requirements: Node.js 18+
 */

import { createServer } from "node:http";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import { execSync } from "node:child_process";

const API_VERSION = "2.18";
const API_BASE = "https://www.perplexity.ai/rest";
const PAGE_SIZE = 20;
const DELAY = 400;
const OUTPUT_DIR = join(homedir(), "Desktop", "perplexity-export");
const ZIP_PATH = join(homedir(), "Desktop", "perplexity-export.zip");
const HOST = "127.0.0.1";
const PORT = 8424;

const HEADERS = {
  "content-type": "application/json",
  "x-app-apiversion": API_VERSION,
  "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  Accept: "application/json, */*",
  "Accept-Language": "en-US,en;q=0.9",
  "Sec-Ch-Ua": '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
  "Sec-Ch-Ua-Mobile": "?0",
  "Sec-Ch-Ua-Platform": '"Linux"',
  "Sec-Fetch-Dest": "empty",
  "Sec-Fetch-Mode": "cors",
  "Sec-Fetch-Site": "same-origin",
  "Referer": "https://www.perplexity.ai/",
  "Origin": "https://www.perplexity.ai",
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── API helpers ─────────────────────────────────────────────────────

async function apiPost(path, body, reason, cookie) {
  const h = { ...HEADERS };
  if (reason) {
    h["x-perplexity-request-endpoint"] = `${API_BASE}${path}`;
    h["x-perplexity-request-reason"] = reason;
  }
  if (cookie) h.Cookie = `__Secure-next-auth.session-token=${cookie}`;

  const resp = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: h,
    body: JSON.stringify(body),
    redirect: "follow",
  });
  if (!resp.ok) {
    const bodyText = await resp.text().catch(() => "");
    throw new Error(`HTTP ${resp.status}: ${bodyText.slice(0, 300)}`);
  }
  return resp.json();
}

async function apiGet(path, cookie) {
  const h = { ...HEADERS };
  if (cookie) h.Cookie = `__Secure-next-auth.session-token=${cookie}`;

  const resp = await fetch(`${API_BASE}${path}`, {
    headers: h,
    redirect: "follow",
  });
  if (!resp.ok) {
    const bodyText = await resp.text().catch(() => "");
    throw new Error(`HTTP ${resp.status}: ${bodyText.slice(0, 300)}`);
  }
  return resp.json();
}

function sanitizeFilename(name, maxLen = 80) {
  return name.replace(/[<>:"/\\|?*]/g, "_").replace(/^[. ]+|[. ]+$/g, "").slice(0, maxLen) || "untitled";
}

function escapeHtml(str) {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ── Markdown converter ──────────────────────────────────────────────

function toMarkdown(convo) {
  const title = convo.title || convo.query_str || "Untitled";
  const ut = convo.updated_at || convo.created_at;
  let dateStr = "";
  if (ut) {
    try { dateStr = new Date(ut).toISOString().replace("T", " ").slice(0, 16) + " UTC"; } catch {}
  }

  const lines = [`# ${title}`, ""];
  if (dateStr) lines.push(`*${dateStr}*\n`);

  const entries = convo.entries || convo.steps || [];
  for (const entry of entries) {
    let steps = [];
    try {
      const parsed = typeof entry.text === "string" ? JSON.parse(entry.text) : entry.text;
      steps = Array.isArray(parsed) ? parsed : (parsed?.steps || []);
    } catch { steps = []; }

    for (const step of steps) {
      if (step.step_type === "INITIAL_QUERY") {
        const q = step.content?.query || "";
        if (q) lines.push(`## Q: ${q}\n`);
      }
      if (step.step_type === "FINAL") {
        let answerData = {};
        try {
          answerData = typeof step.content?.answer === "string"
            ? JSON.parse(step.content.answer)
            : (step.content?.answer || {});
        } catch { answerData = {}; }
        const a = answerData.answer || "";
        if (a) lines.push(`${a}\n`);
        const sources = answerData.web_results || [];
        if (sources.length) {
          lines.push("**Sources:**\n");
          for (const src of sources) {
            const name = src.name || "source";
            const url = src.url || "";
            if (url) lines.push(`- [${name}](${url})`);
            else lines.push(`- ${name}`);
          }
          lines.push("");
        }
      }
    }
  }

  if (lines.length <= 2 && convo.query_str) {
    lines.push(`${convo.query_str}\n`);
  }
  return lines.join("\n");
}

// ── HTML converter ──────────────────────────────────────────────────

function toHtml(convo, allConvos, currentFname) {
  const title = escapeHtml(convo.title || convo.query_str || "Untitled");
  const ut = convo.updated_at || convo.created_at;
  let dateStr = "";
  if (ut) {
    try { dateStr = new Date(ut).toISOString().replace("T", " ").slice(0, 16) + " UTC"; } catch {}
  }

  const entries = convo.entries || convo.steps || [];
  const messagesParts = [];

  for (const entry of entries) {
    let steps = [];
    try {
      const parsed = typeof entry.text === "string" ? JSON.parse(entry.text) : entry.text;
      steps = Array.isArray(parsed) ? parsed : (parsed?.steps || []);
    } catch { steps = []; }

    for (const step of steps) {
      if (step.step_type === "INITIAL_QUERY") {
        const q = step.content?.query || "";
        if (q) {
          messagesParts.push(`<div class="message user"><div class="bubble" dir="auto">${escapeHtml(q).replace(/\n/g, "<br>")}</div></div>`);
        }
      }
      if (step.step_type === "FINAL") {
        let answerData = {};
        try {
          answerData = typeof step.content?.answer === "string"
            ? JSON.parse(step.content.answer)
            : (step.content?.answer || {});
        } catch { answerData = {}; }
        const a = answerData.answer || "";
        if (a) {
          const b64 = Buffer.from(a, "utf8").toString("base64");
          let html = `<div class="message assistant">
        <div class="avatar">P</div>
        <div class="content"><div class="md-content" dir="auto" data-md="${b64}"></div>`;

          const sources = answerData.web_results || [];
          if (sources.length) {
            html += `<div class="sources"><div class="sources-title">Sources</div>`;
            for (const src of sources) {
              const name = src.name || "source";
              const url = src.url || "#";
              html += `<a class="source-link" href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(name)}</a>`;
            }
            html += `</div>`;
          }
          html += `</div></div>`;
          messagesParts.push(html);
        }
      }
    }
  }

  if (!messagesParts.length && convo.query_str) {
    messagesParts.push(`<div class="message user"><div class="bubble" dir="auto">${escapeHtml(convo.query_str).replace(/\n/g, "<br>")}</div></div>`);
  }

  const messagesHtml = messagesParts.join("\n");

  const sidebarItems = allConvos.map((c) => {
    const cls = c.fname === currentFname ? "sidebar-item active" : "sidebar-item";
    return `<a class="${cls}" href="${c.fname}.html" title="${escapeHtml(c.title)}">${escapeHtml(c.title)}</a>`;
  }).join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/highlightjs/cdn-release/build/styles/github-dark.min.css">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", sans-serif;
    background: #ffffff; color: #0d0d0d;
    line-height: 1.65; font-size: 16px;
    display: flex; height: 100vh;
  }
  .sidebar {
    width: 260px; min-width: 260px; height: 100vh;
    background: #f9f9f9; border-right: 1px solid #e5e5e5;
    overflow-y: auto; padding: 16px 0;
    flex-shrink: 0; position: sticky; top: 0;
  }
  .sidebar-header {
    padding: 8px 16px 16px; font-size: 14px; font-weight: 600;
    color: #6b6b6b; border-bottom: 1px solid #e5e5e5; margin-bottom: 8px;
  }
  .sidebar-item {
    display: block; padding: 8px 16px; font-size: 13px;
    color: #0d0d0d; text-decoration: none;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    border-radius: 8px; margin: 2px 8px;
  }
  .sidebar-item:hover { background: #ececec; }
  .sidebar-item.active { background: #e5e5e5; font-weight: 600; }
  .sidebar-toggle {
    display: none; position: fixed; top: 12px; left: 12px; z-index: 100;
    background: #f4f4f4; border: 1px solid #e5e5e5; border-radius: 8px;
    width: 36px; height: 36px; cursor: pointer;
    align-items: center; justify-content: center; font-size: 20px;
  }
  @media (max-width: 768px) {
    .sidebar { position: fixed; left: -280px; z-index: 99; transition: left 0.2s; box-shadow: 2px 0 8px rgba(0,0,0,0.1); }
    .sidebar.open { left: 0; }
    .sidebar-toggle { display: flex; }
    .main { margin-left: 0 !important; }
  }
  .main { flex: 1; overflow-y: auto; }
  .header { max-width: 768px; margin: 0 auto; padding: 32px 24px 16px; border-bottom: 1px solid #e5e5e5; }
  .header h1 { font-size: 22px; font-weight: 600; }
  .header .date { font-size: 13px; color: #6b6b6b; margin-top: 4px; }
  .chat { max-width: 768px; margin: 0 auto; padding: 24px; }
  .message { margin-bottom: 24px; }
  .message.user { display: flex; justify-content: flex-end; }
  .message.user .bubble {
    background: #f4f4f4; border-radius: 18px; padding: 10px 16px;
    max-width: 85%; white-space: pre-wrap; word-break: break-word;
  }
  .message.assistant { display: flex; gap: 12px; align-items: flex-start; }
  .message.assistant .avatar {
    width: 28px; height: 28px; border-radius: 50%;
    background: #20808d; color: #fff;
    display: flex; align-items: center; justify-content: center;
    flex-shrink: 0; margin-top: 2px; font-size: 14px; font-weight: 700;
  }
  .message.assistant .content { flex: 1; min-width: 0; }
  .message.assistant .content h1, .message.assistant .content h2, .message.assistant .content h3 { margin: 16px 0 8px; font-weight: 600; }
  .message.assistant .content h1 { font-size: 20px; }
  .message.assistant .content h2 { font-size: 18px; }
  .message.assistant .content h3 { font-size: 16px; }
  .message.assistant .content p { margin: 8px 0; }
  .message.assistant .content ul, .message.assistant .content ol { margin: 8px 0; padding-left: 24px; }
  .message.assistant .content li { margin: 4px 0; }
  .message.assistant .content a { color: #20808d; }
  .message.assistant .content code { background: #f0f0f0; border-radius: 4px; padding: 2px 5px; font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace; font-size: 14px; }
  .message.assistant .content pre { margin: 12px 0; border-radius: 8px; overflow: hidden; }
  .message.assistant .content pre code { display: block; background: #0d0d0d; color: #f8f8f2; padding: 16px; overflow-x: auto; border-radius: 0; font-size: 13px; line-height: 1.5; }
  .code-block { position: relative; }
  .code-block .copy-btn { position: absolute; top: 8px; right: 8px; background: #333; border: none; color: #999; cursor: pointer; font-size: 12px; padding: 4px 10px; border-radius: 4px; opacity: 0; transition: opacity 0.2s; }
  .code-block:hover .copy-btn { opacity: 1; }
  .code-block .copy-btn:hover { color: #fff; background: #555; }
  .sources { margin-top: 12px; }
  .sources-title { font-size: 13px; font-weight: 600; color: #6b6b6b; margin-bottom: 6px; }
  .source-link { display: inline-block; padding: 4px 12px; margin: 2px 4px 2px 0; background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 16px; font-size: 13px; color: #166534; text-decoration: none; }
  .source-link:hover { background: #dcfce7; }
</style>
</head>
<body>
<button class="sidebar-toggle" onclick="document.querySelector('.sidebar').classList.toggle('open')">&#9776;</button>
<nav class="sidebar">
  <div class="sidebar-header">Threads</div>
  ${sidebarItems}
</nav>
<div class="main">
  <div class="header">
    <h1>${title}</h1>
    ${dateStr ? `<div class="date">${dateStr}</div>` : ""}
  </div>
  <div class="chat">${messagesHtml}</div>
</div>
<script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"><\/script>
<script src="https://cdn.jsdelivr.net/gh/highlightjs/cdn-release/build/highlight.min.js"><\/script>
<script>
document.addEventListener('DOMContentLoaded', () => {
  marked.setOptions({
    highlight: (code, lang) => {
      if (lang && hljs.getLanguage(lang)) return hljs.highlight(code, { language: lang }).value;
      return hljs.highlightAuto(code).value;
    },
    breaks: true,
  });
  const renderer = new marked.Renderer();
  renderer.code = function({ text, lang }) {
    const highlighted = lang && hljs.getLanguage(lang) ? hljs.highlight(text, { language: lang }).value : hljs.highlightAuto(text).value;
    return '<div class="code-block"><button class="copy-btn" onclick="navigator.clipboard.writeText(this.nextElementSibling.querySelector(\\'code\\').textContent);this.textContent=\\'Copied!\\';setTimeout(()=>this.textContent=\\'Copy\\',1500)">Copy</button>'
      + '<pre><code class="hljs">' + highlighted + '</code></pre></div>';
  };
  marked.use({ renderer });
  document.querySelectorAll('.md-content').forEach(el => {
    const md = decodeURIComponent(escape(atob(el.dataset.md)));
    el.innerHTML = marked.parse(md);
  });
  const active = document.querySelector('.sidebar-item.active');
  if (active) active.scrollIntoView({ block: 'center', behavior: 'instant' });
});
<\/script>
</body>
</html>`;
}

// ── ZIP builder ─────────────────────────────────────────────────────

function crc32(buf) {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function buildZip(files) {
  const entries = [];
  let offset = 0;

  for (const file of files) {
    const pathBuf = Buffer.from(file.path, "utf8");
    const data = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data, "utf8");
    const crc = crc32(data);

    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(pathBuf.length, 26);

    entries.push({ header, pathBuf, data, crc, offset });
    offset += 30 + pathBuf.length + data.length;
  }

  const cdParts = [];
  for (const e of entries) {
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt32LE(e.crc, 16);
    cd.writeUInt32LE(e.data.length, 20);
    cd.writeUInt32LE(e.data.length, 24);
    cd.writeUInt16LE(e.pathBuf.length, 28);
    cd.writeUInt32LE(e.offset, 42);
    cdParts.push(cd, e.pathBuf);
  }
  const cdBuf = Buffer.concat(cdParts);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);

  const parts = [];
  for (const e of entries) parts.push(e.header, e.pathBuf, e.data);
  parts.push(cdBuf, eocd);
  return Buffer.concat(parts);
}

// ── Export logic ────────────────────────────────────────────────────

async function runExport(cookie, sendEvent) {
  try {
    sendEvent("status", "Fetching thread list...");
    const threads = [];
    let offset = 0;

    while (true) {
      const data = await apiPost(
        `/thread/list_ask_threads?version=${API_VERSION}&source=default`,
        { limit: PAGE_SIZE, ascending: false, offset, search_term: "" },
        "threads-body",
        cookie
      );
      if (!Array.isArray(data) || !data.length) break;
      threads.push(...data);
      const totalEstimate = data[0]?.total_threads || threads.length + PAGE_SIZE;
      sendEvent("status", `Fetching thread list... ${threads.length}/${totalEstimate}`);
      const last = data[data.length - 1];
      if (!last?.has_next_page) break;
      offset += PAGE_SIZE;
      await sleep(DELAY);
    }

    const total = threads.length;
    if (total === 0) {
      sendEvent("done", JSON.stringify({ total: 0, succeeded: 0, failed: 0, output: "" }));
      return;
    }

    sendEvent("status", `Found ${total} threads. Starting download...`);

    const jsonDir = join(OUTPUT_DIR, "json");
    const mdDir = join(OUTPUT_DIR, "markdown");
    const htmlDir = join(OUTPUT_DIR, "html");
    mkdirSync(jsonDir, { recursive: true });
    mkdirSync(mdDir, { recursive: true });
    mkdirSync(htmlDir, { recursive: true });

    const zipFiles = [];
    const failed = [];
    const downloaded = [];

    for (let i = 0; i < total; i++) {
      const { uuid, query_str, title: rawTitle, updated_at, slug } = threads[i];
      const title = rawTitle || query_str || "Untitled";
      const safe = sanitizeFilename(title);
      const fname = `${safe}_${uuid ? uuid.slice(0, 8) : i}`;

      sendEvent("progress", JSON.stringify({ current: i + 1, total, title }));

      try {
        const detail = await apiGet(`/thread/${slug || uuid}`, cookie);
        const convo = { ...detail, query_str, title, updated_at, slug, uuid };
        const jsonStr = JSON.stringify(convo, null, 2);

        const mdStr = toMarkdown(convo);
        writeFileSync(join(jsonDir, `${fname}.json`), jsonStr, "utf8");
        writeFileSync(join(mdDir, `${fname}.md`), mdStr, "utf8");
        zipFiles.push({ path: `json/${fname}.json`, data: jsonStr });
        zipFiles.push({ path: `markdown/${fname}.md`, data: mdStr });

        downloaded.push({ fname, title, convo });
      } catch (e) {
        console.error(`[thread error] "${title}": ${e.message}`);
        failed.push(title);
      }

      await sleep(DELAY);
    }

    // Pass 2: Generate HTML with sidebar
    sendEvent("status", "Generating HTML pages...");
    const allConvos = downloaded.map((d) => ({ fname: d.fname, title: d.title }));

    for (const d of downloaded) {
      const htmlStr = toHtml(d.convo, allConvos, d.fname);
      writeFileSync(join(htmlDir, `${d.fname}.html`), htmlStr, "utf8");
      zipFiles.push({ path: `html/${d.fname}.html`, data: htmlStr });
    }

    sendEvent("status", "Creating ZIP archive...");
    const zipBuf = buildZip(zipFiles);
    writeFileSync(ZIP_PATH, zipBuf);

    const doneMsg = {
      total,
      succeeded: total - failed.length,
      failed: failed.length,
      failedTitles: failed,
      output: OUTPUT_DIR,
      zip: ZIP_PATH,
    };
    sendEvent("done", JSON.stringify(doneMsg));
  } catch (e) {
    sendEvent("error_msg", `Export failed: ${e.message}`);
  }
}

// ── HTML page ───────────────────────────────────────────────────────

const HTML_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Perplexity Exporter</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: #0f172a; color: #e2e8f0;
    min-height: 100vh; display: flex; align-items: center; justify-content: center;
  }
  .card {
    background: #1e293b; border-radius: 16px; padding: 40px;
    max-width: 600px; width: 100%; box-shadow: 0 25px 50px rgba(0,0,0,0.4);
  }
  h1 { font-size: 24px; margin-bottom: 8px; color: #f8fafc; }
  .subtitle { color: #94a3b8; margin-bottom: 32px; font-size: 14px; }
  .step { display: flex; gap: 12px; margin-bottom: 20px; }
  .step-num {
    flex-shrink: 0; width: 28px; height: 28px; border-radius: 50%;
    background: #8b5cf6; color: #fff; display: flex; align-items: center;
    justify-content: center; font-size: 13px; font-weight: 600;
  }
  .step-num.done { background: #22c55e; }
  .step-text { font-size: 14px; line-height: 1.6; padding-top: 3px; }
  .step-text a { color: #a78bfa; text-decoration: none; }
  .step-text a:hover { text-decoration: underline; }
  code {
    background: #334155; border-radius: 4px; padding: 2px 6px;
    font-family: "SFMono-Regular", Consolas, monospace;
    font-size: 12px; border: 1px solid #475569; color: #cbd5e1;
  }
  textarea {
    width: 100%; height: 80px; background: #0f172a; border: 2px solid #334155;
    border-radius: 8px; color: #e2e8f0; padding: 12px; font-family: monospace;
    font-size: 13px; resize: vertical; margin: 16px 0;
  }
  textarea:focus { outline: none; border-color: #8b5cf6; }
  textarea::placeholder { color: #64748b; }
  button {
    width: 100%; padding: 12px; border: none; border-radius: 8px;
    background: #8b5cf6; color: #fff; font-size: 15px; font-weight: 600;
    cursor: pointer; transition: background 0.2s;
  }
  button:hover { background: #7c3aed; }
  button:disabled { background: #475569; cursor: not-allowed; }
  .progress-section { margin-top: 24px; }
  .progress-bar-bg {
    width: 100%; height: 8px; background: #334155; border-radius: 4px;
    overflow: hidden; margin: 12px 0;
  }
  .progress-bar {
    height: 100%; background: #8b5cf6; border-radius: 4px;
    transition: width 0.3s ease; width: 0%;
  }
  .progress-text { font-size: 13px; color: #94a3b8; }
  .current-title { font-size: 13px; color: #64748b; margin-top: 4px;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .result { margin-top: 20px; padding: 16px; border-radius: 8px; font-size: 14px; }
  .result.success { background: #14532d; color: #bbf7d0; }
  .result.error { background: #7f1d1d; color: #fecaca; }
  .hidden { display: none; }
</style>
</head>
<body>
<div class="card">
  <h1>Perplexity Exporter</h1>
  <p class="subtitle">Export all your threads as JSON, Markdown &amp; HTML</p>

  <div id="steps">
    <div class="step">
      <div class="step-num" id="step1-num">1</div>
      <div class="step-text">
        Go to <a href="https://www.perplexity.ai" target="_blank">perplexity.ai</a> and log in.
      </div>
    </div>
    <div class="step">
      <div class="step-num" id="step2-num">2</div>
      <div class="step-text">
        Open DevTools (<kbd>F12</kbd>), go to <strong>Application</strong> &rarr; <strong>Cookies</strong> &rarr; <strong>perplexity.ai</strong>.
      </div>
    </div>
    <div class="step">
      <div class="step-num" id="step3-num">3</div>
      <div class="step-text">
        Find <code>__Secure-next-auth.session-token</code>, copy its value, and paste it below.
      </div>
    </div>
  </div>

  <textarea id="cookie-input" placeholder="Paste the cookie value here..."></textarea>
  <button id="export-btn" onclick="startExport()">Export threads</button>

  <div id="progress-section" class="progress-section hidden">
    <div class="progress-bar-bg"><div class="progress-bar" id="progress-bar"></div></div>
    <div class="progress-text" id="progress-text">Starting...</div>
    <div class="current-title" id="current-title"></div>
  </div>

  <div id="result" class="result hidden"></div>
</div>

<script>
function startExport() {
  const cookie = document.getElementById('cookie-input').value.trim();
  if (!cookie) return alert('Please paste the cookie value first.');

  document.getElementById('export-btn').disabled = true;
  document.getElementById('cookie-input').disabled = true;
  document.getElementById('progress-section').classList.remove('hidden');
  document.getElementById('result').classList.add('hidden');
  ['step1-num','step2-num','step3-num'].forEach(id => {
    document.getElementById(id).classList.add('done');
    document.getElementById(id).textContent = '\\u2713';
  });

  fetch('/start-export', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cookie }),
  })
    .then(r => r.json())
    .then(data => {
      const evtSource = new EventSource('/progress/' + data.exportId);

      evtSource.addEventListener('status', (e) => {
        document.getElementById('progress-text').textContent = e.data;
      });

      evtSource.addEventListener('progress', (e) => {
        const d = JSON.parse(e.data);
        const pct = Math.round((d.current / d.total) * 100);
        document.getElementById('progress-bar').style.width = pct + '%';
        document.getElementById('progress-text').textContent =
          'Downloading ' + d.current + ' of ' + d.total + ' (' + pct + '%)';
        document.getElementById('current-title').textContent = d.title;
      });

      evtSource.addEventListener('error_msg', (e) => {
        evtSource.close();
        showResult('error', e.data);
        resetUI();
      });

      evtSource.addEventListener('done', (e) => {
        evtSource.close();
        const d = JSON.parse(e.data);
        if (d.total === 0) {
          showResult('success', 'No threads found in your account.');
        } else {
          let msg = 'Done! Exported ' + d.succeeded + ' of ' + d.total + ' threads.';
          msg += '<br><br>Saved to:<br><code>' + d.output + '</code>';
          msg += '<br><code>' + d.zip + '</code>';
          if (d.failed > 0) msg += '<br><br>' + d.failed + ' threads failed: ' + d.failedTitles.join(', ');
          showResult('success', msg);
        }
        resetUI();
      });

      evtSource.onerror = () => {
        evtSource.close();
        showResult('error', 'Connection lost.');
        resetUI();
      };
    })
    .catch(err => {
      showResult('error', 'Failed to start: ' + err.message);
      resetUI();
    });
}

function resetUI() {
  document.getElementById('export-btn').disabled = false;
  document.getElementById('cookie-input').disabled = false;
}

function showResult(type, message) {
  const el = document.getElementById('result');
  el.className = 'result ' + type;
  el.innerHTML = message;
  el.classList.remove('hidden');
}
</script>
</body>
</html>`;

// ── HTTP server ─────────────────────────────────────────────────────

const exports = new Map();

const server = createServer((req, res) => {
  if (req.method === "GET" && (req.url === "/" || req.url === "")) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(HTML_PAGE);
  } else if (req.method === "POST" && req.url === "/start-export") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let cookie;
      try {
        cookie = JSON.parse(body).cookie;
      } catch {
        res.writeHead(400);
        res.end();
        return;
      }

      const exportId = randomUUID().slice(0, 8);
      exports.set(exportId, { events: [], done: false });

      const sendEvent = (type, data) => {
        const entry = exports.get(exportId);
        if (entry) entry.events.push({ type, data: data.replace(/\n/g, "\\n") });
      };

      runExport(cookie, sendEvent).finally(() => {
        const entry = exports.get(exportId);
        if (entry) entry.done = true;
      });

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ exportId }));
    });
  } else if (req.method === "GET" && req.url.startsWith("/progress/")) {
    const exportId = req.url.split("/progress/")[1];
    const entry = exports.get(exportId);
    if (!entry) {
      res.writeHead(404);
      res.end();
      return;
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    let sent = 0;
    const interval = setInterval(() => {
      while (sent < entry.events.length) {
        const evt = entry.events[sent++];
        res.write(`event: ${evt.type}\ndata: ${evt.data}\n\n`);
      }
      if (entry.done && sent >= entry.events.length) {
        clearInterval(interval);
        exports.delete(exportId);
        res.end();
      }
    }, 200);

    req.on("close", () => clearInterval(interval));
  } else {
    res.writeHead(404);
    res.end();
  }
});

// ── Main ────────────────────────────────────────────────────────────

const url = `http://${HOST}:${PORT}`;
server.listen(PORT, HOST, () => {
  console.log(`Perplexity Exporter running at ${url}`);
  console.log("Press Ctrl+C to stop.\n");

  try {
    if (process.platform === "darwin") execSync(`open "${url}"`);
    else if (process.platform === "linux") execSync(`xdg-open "${url}"`);
  } catch {}
});
