// ── Perplexity Conversation Exporter ─────────────────────────────────
// Paste this into your browser console while on perplexity.ai
// It will export all threads as JSON + Markdown + HTML in a ZIP file.
// ─────────────────────────────────────────────────────────────────────

(async () => {
  const API_VERSION = "2.18";
  const API_BASE = "https://www.perplexity.ai/rest";
  const PAGE_SIZE = 20;
  const DELAY = 400;

  const HEADERS = {
    "content-type": "application/json",
    "x-app-apiversion": API_VERSION,
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ── UI overlay ──────────────────────────────────────────────────────

  const overlay = document.createElement("div");
  overlay.id = "perplexity-exporter-overlay";
  overlay.innerHTML = `
    <div style="position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:99999;
      display:flex;align-items:center;justify-content:center;font-family:-apple-system,BlinkMacSystemFont,sans-serif">
      <div style="background:#1e293b;border-radius:16px;padding:40px;max-width:500px;width:90%;color:#e2e8f0;box-shadow:0 25px 50px rgba(0,0,0,0.4)">
        <h2 style="margin:0 0 8px;font-size:20px;color:#f8fafc">Perplexity Exporter</h2>
        <p id="pxe-status" style="color:#94a3b8;font-size:14px;margin:0 0 20px">Starting...</p>
        <div style="width:100%;height:8px;background:#334155;border-radius:4px;overflow:hidden;margin-bottom:8px">
          <div id="pxe-bar" style="height:100%;background:#8b5cf6;border-radius:4px;transition:width 0.3s;width:0%"></div>
        </div>
        <p id="pxe-detail" style="color:#64748b;font-size:13px;margin:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis"></p>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  const ui = {
    status: overlay.querySelector("#pxe-status"),
    bar: overlay.querySelector("#pxe-bar"),
    detail: overlay.querySelector("#pxe-detail"),
    set(status, pct, detail) {
      if (status) this.status.textContent = status;
      if (pct != null) this.bar.style.width = pct + "%";
      if (detail) this.detail.textContent = detail;
    },
    done(msg) {
      this.status.textContent = msg;
      this.bar.style.width = "100%";
      this.bar.style.background = "#22c55e";
      this.detail.textContent = "You can close this overlay by clicking anywhere.";
      overlay.querySelector("div").style.cursor = "pointer";
      overlay.addEventListener("click", () => overlay.remove());
    },
    error(msg) {
      this.status.textContent = msg;
      this.bar.style.background = "#ef4444";
      this.detail.textContent = "Click anywhere to close.";
      overlay.addEventListener("click", () => overlay.remove());
    },
  };

  // ── API helpers ──────────────────────────────────────────────────────

  async function apiPost(path, body, reason) {
    const resp = await fetch(`${API_BASE}${path}`, {
      method: "POST",
      headers: {
        ...HEADERS,
        "x-perplexity-request-endpoint": `${API_BASE}${path}`,
        "x-perplexity-request-reason": reason || "export",
      },
      body: JSON.stringify(body),
      credentials: "include",
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status} on ${path}`);
    return resp.json();
  }

  async function apiGet(path) {
    const resp = await fetch(`${API_BASE}${path}`, {
      headers: HEADERS,
      credentials: "include",
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status} on ${path}`);
    return resp.json();
  }

  function sanitize(name) {
    return name.replace(/[<>:"/\\|?*]/g, "_").replace(/^[. ]+|[. ]+$/g, "").slice(0, 80) || "untitled";
  }

  function escapeHtml(str) {
    return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  // ── Selection UI ──────────────────────────────────────────────────

  function showSelectionUI(items) {
    return new Promise((resolve) => {
      const checked = new Set(items.map((_, i) => i));
      const container = document.createElement("div");
      container.id = "pxe-select";
      const itemRows = items.map((item, i) => {
        const title = item.title || item.query_str || "Untitled";
        return `<label style="display:flex;align-items:center;gap:8px;padding:4px 0;cursor:pointer;font-size:13px;color:#cbd5e1">
          <input type="checkbox" checked data-idx="${i}" style="accent-color:#8b5cf6;width:15px;height:15px">
          <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(title)}</span>
        </label>`;
      }).join("");
      container.innerHTML = `<div style="position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:99999;display:flex;align-items:center;justify-content:center;font-family:-apple-system,BlinkMacSystemFont,sans-serif">
        <div style="background:#1e293b;border-radius:16px;padding:32px;max-width:500px;width:90%;color:#e2e8f0;box-shadow:0 25px 50px rgba(0,0,0,0.4);max-height:80vh;display:flex;flex-direction:column">
          <h2 style="margin:0 0 8px;font-size:18px;color:#f8fafc">Select threads</h2>
          <p id="pxe-sel-count" style="color:#94a3b8;font-size:13px;margin:0 0 4px">${items.length} selected</p>
          <div style="margin-bottom:8px">
            <button id="pxe-sel-all" style="background:#334155;border:none;color:#e2e8f0;padding:4px 12px;border-radius:6px;cursor:pointer;font-size:12px;margin-right:6px">Select All</button>
            <button id="pxe-sel-none" style="background:#334155;border:none;color:#e2e8f0;padding:4px 12px;border-radius:6px;cursor:pointer;font-size:12px">Clear</button>
          </div>
          <div style="overflow-y:auto;flex:1;margin-bottom:16px;border:1px solid #334155;border-radius:8px;padding:8px 12px">${itemRows}</div>
          <button id="pxe-sel-go" style="width:100%;padding:12px;border:none;border-radius:8px;background:#8b5cf6;color:#fff;font-size:15px;font-weight:600;cursor:pointer">Export Selected</button>
        </div>
      </div>`;
      document.body.appendChild(container);

      const checkboxes = container.querySelectorAll("input[type=checkbox]");
      const countEl = container.querySelector("#pxe-sel-count");
      const updateCount = () => {
        const n = container.querySelectorAll("input[type=checkbox]:checked").length;
        countEl.textContent = n + " selected";
      };
      const setAll = (v) => { checkboxes.forEach(cb => { cb.checked = v; }); updateCount(); };

      container.querySelector("#pxe-sel-all").onclick = () => setAll(true);
      container.querySelector("#pxe-sel-none").onclick = () => setAll(false);
      container.querySelectorAll("input[type=checkbox]").forEach(cb => cb.onchange = updateCount);
      container.querySelector("#pxe-sel-go").onclick = () => {
        const idxs = [];
        checkboxes.forEach((cb, i) => { if (cb.checked) idxs.push(i); });
        container.remove();
        resolve(idxs.map(i => items[i]));
      };
    });
  }

  // ── Fetch thread list ─────────────────────────────────────────────────

  ui.set("Fetching thread list...");
  let threads = [];
  let offset = 0;

  try {
    while (true) {
      const data = await apiPost(
        `/thread/list_ask_threads?version=${API_VERSION}&source=default`,
        { limit: PAGE_SIZE, ascending: false, offset, search_term: "" },
        "threads-body"
      );
      if (!Array.isArray(data) || !data.length) break;
      threads.push(...data);

      const pct = Math.min(Math.round((threads.length / (data[0]?.total_threads || threads.length + PAGE_SIZE)) * 100), 99);
      ui.set(`Fetching thread list... ${threads.length} threads`, pct);

      const last = data[data.length - 1];
      if (!last?.has_next_page) break;
      offset += PAGE_SIZE;
      await sleep(DELAY);
    }
  } catch (e) {
    ui.error(`Failed to fetch threads: ${e.message}. Are you logged in?`);
    return;
  }

  if (!threads.length) {
    ui.done("No threads found.");
    return;
  }

  // ── Selection UI ───────────────────────────────────────────────────

  const selected = await showSelectionUI(threads);
  if (!selected.length) {
    ui.done("Nothing selected. Export cancelled.");
    return;
  }

  ui.set(`Downloading ${selected.length} thread(s)...`);

  // ── Pass 1: Download threads ────────────────────────────────────────

  const zipEntries = [];
  let failed = 0;
  const total = selected.length;
  const downloaded = [];

  for (let i = 0; i < total; i++) {
    const { uuid, query_str, title: rawTitle, updated_at, slug } = selected[i];
    const title = rawTitle || query_str || "Untitled";
    const safeTitle = sanitize(title);
    const fname = `${safeTitle}_${uuid ? uuid.slice(0, 8) : i}`;
    const pct = Math.round(((i + 1) / total) * 100);

    ui.set(`Downloading ${i + 1} of ${total} (${pct}%)`, pct, title);

    try {
      const detail = await apiGet(`/thread/${slug || uuid}`);
      const convo = { ...detail, query_str, title, updated_at, slug, uuid };
      const jsonStr = JSON.stringify(convo, null, 2);
      const mdStr = toMarkdown(convo);
      zipEntries.push({ path: `json/${fname}.json`, data: jsonStr });
      zipEntries.push({ path: `markdown/${fname}.md`, data: mdStr });
      downloaded.push({ fname, title, convo });
    } catch {
      failed++;
    }

    await sleep(DELAY);
  }

  // ── Pass 2: Generate HTML ────────────────────────────────────────────

  ui.set("Generating HTML pages...", 100);
  const allConvos = downloaded.map((d) => ({ fname: d.fname, title: d.title }));

  for (const d of downloaded) {
    const htmlStr = toHtml(d.convo, allConvos, d.fname);
    zipEntries.push({ path: `html/${d.fname}.html`, data: htmlStr });
  }

  // ── Build ZIP and download ────────────────────────────────────────────

  ui.set("Creating ZIP archive...", 100);
  const zipBlob = buildZipBlob(zipEntries);
  const a = document.createElement("a");
  a.href = URL.createObjectURL(zipBlob);
  a.download = "perplexity-export.zip";
  a.click();
  URL.revokeObjectURL(a.href);

  const succeeded = total - failed;
  let doneMsg = `Done! Exported ${succeeded}/${total} threads.`;
  if (failed) doneMsg += ` (${failed} failed)`;
  ui.done(doneMsg);

  // ── Markdown converter ────────────────────────────────────────────────

  function toMarkdown(convo) {
    const title = convo.title || convo.query_str || "Untitled";
    const ut = convo.updated_at || convo.created_at;
    let dateStr = "";
    if (ut) {
      try { dateStr = new Date(ut).toISOString().replace("T", " ").slice(0, 16) + " UTC"; } catch {}
    }

    const lines = [`# ${title}`, ""];
    if (dateStr) lines.push(`*${dateStr}*\n`);

    // Extract steps from entries[].text (which is a JSON string of steps)
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

    // If nothing was extracted, use the raw query_str
    if (lines.length <= 2 && convo.query_str) {
      lines.push(`${convo.query_str}\n`);
    }

    return lines.join("\n");
  }

  // ── HTML converter ────────────────────────────────────────────────────

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
            const b64 = btoa(unescape(encodeURIComponent(a)));
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

    // Fallback: if no steps parsed, show raw query_str
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
    .sidebar {
      position: fixed; left: -280px; z-index: 99;
      transition: left 0.2s; box-shadow: 2px 0 8px rgba(0,0,0,0.1);
    }
    .sidebar.open { left: 0; }
    .sidebar-toggle { display: flex; }
    .main { margin-left: 0 !important; }
  }
  .main { flex: 1; overflow-y: auto; }
  .header {
    max-width: 768px; margin: 0 auto; padding: 32px 24px 16px;
    border-bottom: 1px solid #e5e5e5;
  }
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
  .message.assistant .content h1,
  .message.assistant .content h2,
  .message.assistant .content h3 { margin: 16px 0 8px; font-weight: 600; }
  .message.assistant .content h1 { font-size: 20px; }
  .message.assistant .content h2 { font-size: 18px; }
  .message.assistant .content h3 { font-size: 16px; }
  .message.assistant .content p { margin: 8px 0; }
  .message.assistant .content ul,
  .message.assistant .content ol { margin: 8px 0; padding-left: 24px; }
  .message.assistant .content li { margin: 4px 0; }
  .message.assistant .content a { color: #20808d; }
  .message.assistant .content code {
    background: #f0f0f0; border-radius: 4px; padding: 2px 5px;
    font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace;
    font-size: 14px;
  }
  .message.assistant .content pre { margin: 12px 0; border-radius: 8px; overflow: hidden; }
  .message.assistant .content pre code {
    display: block; background: #0d0d0d; color: #f8f8f2;
    padding: 16px; overflow-x: auto; border-radius: 0;
    font-size: 13px; line-height: 1.5;
  }
  .code-block { position: relative; }
  .code-block .copy-btn {
    position: absolute; top: 8px; right: 8px;
    background: #333; border: none; color: #999; cursor: pointer;
    font-size: 12px; padding: 4px 10px; border-radius: 4px;
    opacity: 0; transition: opacity 0.2s;
  }
  .code-block:hover .copy-btn { opacity: 1; }
  .code-block .copy-btn:hover { color: #fff; background: #555; }
  .sources { margin-top: 12px; }
  .sources-title { font-size: 13px; font-weight: 600; color: #6b6b6b; margin-bottom: 6px; }
  .source-link {
    display: inline-block; padding: 4px 12px; margin: 2px 4px 2px 0;
    background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 16px;
    font-size: 13px; color: #166534; text-decoration: none;
  }
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
  <div class="chat">
  ${messagesHtml}
  </div>
</div>
<script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"><\/script>
<script src="https://cdn.jsdelivr.net/gh/highlightjs/cdn-release/build/highlight.min.js"><\/script>
<script>
document.addEventListener('DOMContentLoaded', () => {
  marked.setOptions({
    highlight: (code, lang) => {
      if (lang && hljs.getLanguage(lang)) {
        return hljs.highlight(code, { language: lang }).value;
      }
      return hljs.highlightAuto(code).value;
    },
    breaks: true,
  });

  const renderer = new marked.Renderer();
  renderer.code = function({ text, lang }) {
    const highlighted = lang && hljs.getLanguage(lang)
      ? hljs.highlight(text, { language: lang }).value
      : hljs.highlightAuto(text).value;
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

  // ── Minimal ZIP builder (store, no compression) ──────────────────────

  function buildZipBlob(entries) {
    const te = new TextEncoder();
    const parts = [];
    const cdParts = [];
    let offset = 0;

    for (const entry of entries) {
      const pathBytes = te.encode(entry.path);
      const dataBytes = typeof entry.data === "string" ? te.encode(entry.data) : entry.data;
      const crc = crc32(dataBytes);

      const lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true);
      lh.setUint16(4, 20, true);
      lh.setUint16(8, 0, true);
      lh.setUint32(14, crc, true);
      lh.setUint32(18, dataBytes.length, true);
      lh.setUint32(22, dataBytes.length, true);
      lh.setUint16(26, pathBytes.length, true);

      parts.push(new Uint8Array(lh.buffer), pathBytes, dataBytes);

      const cd = new DataView(new ArrayBuffer(46));
      cd.setUint32(0, 0x02014b50, true);
      cd.setUint16(4, 20, true);
      cd.setUint16(6, 20, true);
      cd.setUint16(10, 0, true);
      cd.setUint32(16, crc, true);
      cd.setUint32(20, dataBytes.length, true);
      cd.setUint32(24, dataBytes.length, true);
      cd.setUint16(28, pathBytes.length, true);
      cd.setUint32(42, offset, true);

      cdParts.push(new Uint8Array(cd.buffer), pathBytes);

      offset += 30 + pathBytes.length + dataBytes.length;
    }

    const cdSize = cdParts.reduce((s, p) => s + p.length, 0);

    const eocd = new DataView(new ArrayBuffer(22));
    eocd.setUint32(0, 0x06054b50, true);
    eocd.setUint16(8, entries.length, true);
    eocd.setUint16(10, entries.length, true);
    eocd.setUint32(12, cdSize, true);
    eocd.setUint32(16, offset, true);

    return new Blob([...parts, ...cdParts, new Uint8Array(eocd.buffer)], {
      type: "application/zip",
    });
  }

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
})();
