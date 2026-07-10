#!/usr/bin/env node
/**
 * ChatGPT Conversation Exporter — Node.js with local web UI.
 * Starts a local server, opens a browser with a nice UI,
 * user pastes their session JSON, and conversations are exported.
 */

import { createServer } from "node:http";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import { execSync } from "node:child_process";

const API_BASE = "https://chatgpt.com/backend-api";
const PAGE_SIZE = 100;
const DELAY = 500;
const OUTPUT_DIR = join(homedir(), "Desktop", "chatgpt-export");
const ZIP_PATH = join(homedir(), "Desktop", "chatgpt-export.zip");
const HOST = "127.0.0.1";
const PORT = 8423;
const DEVICE_ID = randomUUID();

const HEADERS = {
  "Content-Type": "application/json",
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  Accept: "application/json",
  "Accept-Language": "en-US,en;q=0.9",
  Referer: "https://chatgpt.com/",
  Origin: "https://chatgpt.com",
  "Oai-Device-Id": DEVICE_ID,
  "Oai-Language": "en-US",
  "Sec-Ch-Ua": '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
  "Sec-Ch-Ua-Mobile": "?0",
  "Sec-Ch-Ua-Platform": '"macOS"',
  "Sec-Fetch-Dest": "empty",
  "Sec-Fetch-Mode": "cors",
  "Sec-Fetch-Site": "same-origin",
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── API helpers ─────────────────────────────────────────────────────

async function apiGet(path, token) {
  const resp = await fetch(`${API_BASE}/${path}`, {
    headers: { ...HEADERS, Authorization: `Bearer ${token}` },
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`HTTP ${resp.status}: ${body.slice(0, 300)}`);
  }
  return resp.json();
}

async function apiFetchBinary(url, token) {
  const h = { ...HEADERS, Accept: "*/*" };
  if (token) h.Authorization = `Bearer ${token}`;
  const resp = await fetch(url, { headers: h });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const buffer = Buffer.from(await resp.arrayBuffer());
  const contentType = resp.headers.get("content-type") || "";
  return { buffer, contentType };
}

const MIME_TO_EXT = {
  "image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif",
  "image/webp": ".webp", "image/svg+xml": ".svg", "application/pdf": ".pdf",
  "text/plain": ".txt", "text/html": ".html", "text/csv": ".csv",
  "application/json": ".json", "application/zip": ".zip",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
};

// ── File references ─────────────────────────────────────────────────

function extractFileReferences(convo) {
  const refs = [];
  const seen = new Set();
  const mapping = convo.mapping || {};

  for (const node of Object.values(mapping)) {
    const msg = node.message;
    if (!msg) continue;

    // image_asset_pointer in content parts
    if (msg.content?.parts) {
      for (const part of msg.content.parts) {
        if (part?.content_type === "image_asset_pointer" && part.asset_pointer) {
          const match = part.asset_pointer.match(/^(?:file-service|sediment):\/\/(.+)$/);
          if (match && !seen.has(match[1])) {
            seen.add(match[1]);
            refs.push({
              fileId: match[1],
              filename: part.metadata?.dalle?.prompt ? "dalle_image.png" : "image.png",
              type: "image",
              nodeId: node.id,
            });
          }
        }
      }
    }

    // metadata.attachments
    if (msg.metadata?.attachments) {
      for (const att of msg.metadata.attachments) {
        if (att.id && !seen.has(att.id)) {
          seen.add(att.id);
          refs.push({
            fileId: att.id,
            filename: att.name || "attachment",
            type: "attachment",
            nodeId: node.id,
          });
        }
      }
    }

    // metadata.citations
    if (msg.metadata?.citations) {
      for (const cit of msg.metadata.citations) {
        const fileId = cit.metadata?.file_id || cit.file_id;
        const title = cit.metadata?.title || cit.title || "citation";
        if (fileId && !seen.has(fileId)) {
          seen.add(fileId);
          refs.push({
            fileId,
            filename: title,
            type: "citation",
            nodeId: node.id,
          });
        }
      }
    }
  }

  return refs;
}

async function downloadFile(fileId, token, fallbackName) {
  const meta = await apiGet(`files/download/${fileId}`, token);
  console.log(`  download_url: ${meta.download_url?.slice(0, 120)}...`);
  console.log(`  file_name: ${meta.file_name}, status: ${meta.status}`);
  const url = meta.download_url;
  if (!url) throw new Error("No download_url returned");
  const { buffer, contentType } = await apiFetchBinary(url, token);
  let filename = meta.file_name || fallbackName || fileId;
  // Add extension from content-type if missing
  if (!filename.includes(".") && contentType) {
    const mime = contentType.split(";")[0].trim();
    const ext = MIME_TO_EXT[mime];
    if (ext) filename += ext;
  }
  return { filename, buffer };
}

function deduplicateFilename(name, usedNames) {
  if (!usedNames.has(name)) {
    usedNames.add(name);
    return name;
  }
  const dot = name.lastIndexOf(".");
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  let i = 1;
  while (usedNames.has(`${base}_${i}${ext}`)) i++;
  const deduped = `${base}_${i}${ext}`;
  usedNames.add(deduped);
  return deduped;
}

// ── Markdown converter ──────────────────────────────────────────────

function conversationToMarkdown(convo, fileMap = {}) {
  const title = convo.title || "Untitled";
  const ct = convo.create_time;
  let dateStr = "";
  if (ct) dateStr = new Date(ct * 1000).toISOString().replace("T", " ").slice(0, 16) + " UTC";

  const lines = [`# ${title}`, ""];
  if (dateStr) lines.push(`*${dateStr}*\n`);

  const mapping = convo.mapping || {};
  const rootId = Object.keys(mapping).find((k) => mapping[k].parent == null);

  if (rootId) {
    const queue = [rootId];
    while (queue.length) {
      const nid = queue.shift();
      const node = mapping[nid] || {};
      const msg = node.message;
      if (msg?.content?.parts) {
        const role = msg.author?.role || "unknown";
        // Skip system, tool, and non-text assistant messages
        if (role === "system" || role === "tool") {
          queue.push(...(node.children || []));
          continue;
        }
        const contentType = msg.content?.content_type || "text";
        if (role === "assistant" && contentType !== "text") {
          queue.push(...(node.children || []));
          continue;
        }
        const textParts = [];

        for (const part of msg.content.parts) {
          if (typeof part === "string") {
            textParts.push(part);
          } else if (part?.content_type === "image_asset_pointer" && part.asset_pointer) {
            const match = part.asset_pointer.match(/^(?:file-service|sediment):\/\/(.+)$/);
            if (match && fileMap[match[1]]) {
              textParts.push(`![image](${fileMap[match[1]]})`);
            } else {
              textParts.push("[image]");
            }
          } else {
            textParts.push(JSON.stringify(part));
          }
        }

        // Add attachment links
        if (msg.metadata?.attachments) {
          for (const att of msg.metadata.attachments) {
            if (att.id && fileMap[att.id]) {
              textParts.push(`\n📎 [${att.name || "attachment"}](${fileMap[att.id]})`);
            }
          }
        }

        const text = stripCitations(textParts.join("\n")).trim();
        if (text) {
          lines.push(`## ${role.charAt(0).toUpperCase() + role.slice(1)}\n\n${text}\n`);
        }
      }
      queue.push(...(node.children || []));
    }
  }
  return lines.join("\n");
}

// ── HTML converter ──────────────────────────────────────────────────

function stripCitations(str) {
  return str.replace(/\u3010[^】]*\u3011/g, "");
}

function escapeHtml(str) {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function conversationToHtml(convo, fileMap = {}, allConversations = [], currentFname = "") {
  const title = escapeHtml(convo.title || "Untitled");
  const ct = convo.create_time;
  let dateStr = "";
  if (ct) dateStr = new Date(ct * 1000).toISOString().replace("T", " ").slice(0, 16) + " UTC";

  const messages = [];
  const mapping = convo.mapping || {};
  const rootId = Object.keys(mapping).find((k) => mapping[k].parent == null);

  if (rootId) {
    const queue = [rootId];
    while (queue.length) {
      const nid = queue.shift();
      const node = mapping[nid] || {};
      const msg = node.message;
      if (msg?.content?.parts) {
        const role = msg.author?.role || "unknown";
        const contentType = msg.content?.content_type || "text";
        if (role === "system") {
          queue.push(...(node.children || []));
          continue;
        }

        // Determine if this is internal/thinking content
        const isInternal = role === "tool" ||
          (role === "assistant" && contentType !== "text") ||
          (role === "user" && contentType === "user_editable_context");

        const textParts = [];
        const imageParts = [];

        for (const part of msg.content.parts) {
          if (typeof part === "string") {
            textParts.push(part);
          } else if (part?.content_type === "image_asset_pointer" && part.asset_pointer) {
            const match = part.asset_pointer.match(/^(?:file-service|sediment):\/\/(.+)$/);
            if (match && fileMap[match[1]]) {
              imageParts.push(fileMap[match[1]]);
            }
          }
        }

        const attachments = [];
        if (msg.metadata?.attachments) {
          for (const att of msg.metadata.attachments) {
            if (att.id && fileMap[att.id]) {
              attachments.push({ name: att.name || "attachment", path: fileMap[att.id] });
            }
          }
        }

        const text = stripCitations(textParts.join("\n")).trim();
        if (text || imageParts.length || attachments.length) {
          messages.push({ role, text, images: imageParts, attachments, isInternal, contentType });
        }
      }
      queue.push(...(node.children || []));
    }
  }

  const INTERNAL_LABELS = {
    multimodal_text: "File context", code: "Code", execution_output: "Output",
    computer_output: "Output", tether_browsing_display: "Web browsing",
    system_error: "Error", text: "Tool output",
  };

  // Build message HTML
  const messagesHtml = messages.map((m) => {
    if (m.isInternal) {
      const label = INTERNAL_LABELS[m.contentType] || "Internal context";
      const b64 = Buffer.from(m.text, "utf8").toString("base64");
      return `<details class="thinking"><summary>${label}</summary><div class="thinking-content md-content" dir="auto" data-md="${b64}"></div></details>`;
    }

    const roleClass = m.role === "user" ? "user" : "assistant";
    let content = "";

    if (m.role === "user") {
      // User messages: render as escaped text (users don't write markdown)
      const escapedText = escapeHtml(m.text);
      content = `<div class="bubble" dir="auto">${escapedText.replace(/\n/g, "<br>")}</div>`;
    } else {
      // Assistant messages: store markdown for client-side rendering
      const avatar = `<div class="avatar"><svg viewBox="0 0 41 41" fill="none" xmlns="http://www.w3.org/2000/svg" width="24" height="24"><path d="M37.532 16.87a9.963 9.963 0 0 0-.856-8.184 10.078 10.078 0 0 0-10.855-4.835A9.964 9.964 0 0 0 18.306.5a10.079 10.079 0 0 0-9.614 6.977 9.967 9.967 0 0 0-6.664 4.834 10.08 10.08 0 0 0 1.24 11.817 9.965 9.965 0 0 0 .856 8.185 10.079 10.079 0 0 0 10.855 4.835 9.965 9.965 0 0 0 7.516 3.35 10.078 10.078 0 0 0 9.617-6.981 9.967 9.967 0 0 0 6.663-4.834 10.079 10.079 0 0 0-1.243-11.813ZM22.498 37.886a7.474 7.474 0 0 1-4.799-1.735c.061-.033.168-.091.237-.134l7.964-4.6a1.294 1.294 0 0 0 .655-1.134V19.054l3.366 1.944a.12.12 0 0 1 .066.092v9.299a7.505 7.505 0 0 1-7.49 7.496ZM6.392 31.006a7.471 7.471 0 0 1-.894-5.023c.06.036.162.099.237.141l7.964 4.6a1.297 1.297 0 0 0 1.308 0l9.724-5.614v3.888a.12.12 0 0 1-.048.103l-8.051 4.649a7.504 7.504 0 0 1-10.24-2.744ZM4.297 13.62A7.469 7.469 0 0 1 8.2 10.333c0 .068-.004.19-.004.274v9.201a1.294 1.294 0 0 0 .654 1.132l9.723 5.614-3.366 1.944a.12.12 0 0 1-.114.012L7.044 23.86a7.504 7.504 0 0 1-2.747-10.24Zm27.658 6.437-9.724-5.615 3.367-1.943a.121.121 0 0 1 .114-.012l8.048 4.648a7.498 7.498 0 0 1-1.158 13.528V21.36a1.293 1.293 0 0 0-.647-1.132v-.17Zm3.35-5.043c-.059-.037-.162-.099-.236-.141l-7.965-4.6a1.298 1.298 0 0 0-1.308 0l-9.723 5.614v-3.888a.12.12 0 0 1 .048-.103l8.05-4.645a7.497 7.497 0 0 1 11.135 7.763Zm-21.063 6.929-3.367-1.944a.12.12 0 0 1-.065-.092v-9.299a7.497 7.497 0 0 1 12.293-5.756 6.94 6.94 0 0 0-.236.134l-7.965 4.6a1.294 1.294 0 0 0-.654 1.132l-.006 11.225Zm1.829-3.943 4.33-2.501 4.332 2.5v5l-4.331 2.5-4.331-2.5V18Z" fill="currentColor"/></svg></div>`;
      // Encode text as base64 to avoid HTML escaping issues with markdown
      const b64 = Buffer.from(m.text, "utf8").toString("base64");
      content = `${avatar}<div class="content"><div class="md-content" dir="auto" data-md="${b64}"></div></div>`;
    }

    // Add images
    if (m.images.length) {
      const imgs = m.images.map((src) => `<a href="${escapeHtml(src)}" target="_blank"><img src="${escapeHtml(src)}" alt="image" loading="lazy"></a>`).join("");
      content += `<div class="images">${imgs}</div>`;
    }

    // Add attachment cards
    if (m.attachments.length) {
      const atts = m.attachments
        .map((a) => `<a class="attachment" href="${escapeHtml(a.path)}" target="_blank"><span class="att-icon">📎</span><span class="att-name">${escapeHtml(a.name)}</span></a>`)
        .join("");
      content += `<div class="attachments">${atts}</div>`;
    }

    return `<div class="message ${roleClass}">${content}</div>`;
  }).join("\n");

  // Build sidebar HTML
  const sidebarItems = allConversations.map((c) => {
    const isActive = c.fname === currentFname;
    const cls = isActive ? "sidebar-item active" : "sidebar-item";
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

  /* ── Sidebar ── */
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

  /* ── Hamburger toggle (mobile) ── */
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

  /* ── Main area ── */
  .main { flex: 1; overflow-y: auto; }
  .header {
    max-width: 768px; margin: 0 auto; padding: 32px 24px 16px;
    border-bottom: 1px solid #e5e5e5;
  }
  .header h1 { font-size: 22px; font-weight: 600; }
  .header .date { font-size: 13px; color: #6b6b6b; margin-top: 4px; }
  .chat { max-width: 768px; margin: 0 auto; padding: 24px; }

  /* ── Messages ── */
  .message { margin-bottom: 24px; }
  .message.user { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; }
  .message.user .bubble {
    background: #f4f4f4; border-radius: 18px; padding: 10px 16px;
    max-width: 85%; white-space: pre-wrap; word-break: break-word;
  }
  .message.user .images { width: 100%; display: flex; justify-content: flex-end; }
  .message.assistant {
    display: flex; gap: 12px; align-items: flex-start;
  }
  .message.assistant .avatar {
    width: 28px; height: 28px; border-radius: 50%;
    background: #00a67e; color: #fff;
    display: flex; align-items: center; justify-content: center;
    flex-shrink: 0; margin-top: 2px;
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
  .message.assistant .content a { color: #1a7f64; }
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
  .images img { max-width: 100%; border-radius: 8px; margin: 4px 0; display: block; cursor: pointer; }
  .images img:hover { opacity: 0.9; }
  .message.user .images img { max-width: 300px; }
  .attachments { margin-top: 8px; display: flex; flex-wrap: wrap; gap: 8px; }
  .attachment {
    display: inline-flex; align-items: center; gap: 8px;
    background: #f4f4f4; border: 1px solid #e5e5e5; border-radius: 8px;
    padding: 8px 12px; text-decoration: none; color: #0d0d0d; font-size: 14px;
  }
  .attachment:hover { background: #ececec; }
  .att-icon { font-size: 16px; }
  .att-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 200px; }

  /* ── Collapsed internal/thinking blocks ── */
  .thinking {
    margin-bottom: 24px; border-left: 3px solid #d4d4d4;
    padding-left: 16px; font-size: 14px;
  }
  .thinking summary {
    color: #8e8e8e; font-style: italic; cursor: pointer;
    padding: 4px 0; user-select: none;
  }
  .thinking summary:hover { color: #555; }
  .thinking-content {
    color: #6b6b6b; padding: 8px 0; font-style: italic;
  }
  .thinking-content p, .thinking-content li { color: #6b6b6b; }
  .thinking-content pre code { opacity: 0.7; }
  .thinking-content h1, .thinking-content h2, .thinking-content h3 {
    color: #6b6b6b; font-size: 15px;
  }
</style>
</head>
<body>
<button class="sidebar-toggle" onclick="document.querySelector('.sidebar').classList.toggle('open')">&#9776;</button>
<nav class="sidebar">
  <div class="sidebar-header">Conversations</div>
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

  // Scroll active sidebar item into view
  const active = document.querySelector('.sidebar-item.active');
  if (active) active.scrollIntoView({ block: 'center', behavior: 'instant' });
});
<\/script>
</body>
</html>`;
}

function sanitizeFilename(name, maxLen = 80) {
  return name.replace(/[<>:"/\\|?*]/g, "_").replace(/^[. ]+|[. ]+$/g, "").slice(0, maxLen) || "untitled";
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

async function runExport(token, sendEvent) {
  try {
    sendEvent("status", "Fetching conversation list...");
    const conversations = [];
    let offset = 0;
    while (true) {
      const data = await apiGet(`conversations?offset=${offset}&limit=${PAGE_SIZE}`, token);
      const items = data.items || [];
      if (!items.length) break;
      conversations.push(...items);
      const total = data.total || 0;
      sendEvent("status", `Fetching conversation list... ${conversations.length}/${total}`);
      offset += PAGE_SIZE;
      if (offset >= total) break;
      await sleep(DELAY);
    }

    const total = conversations.length;
    if (total === 0) {
      sendEvent("done", JSON.stringify({ total: 0, succeeded: 0, failed: 0, output: "" }));
      return;
    }

    sendEvent("status", `Found ${total} conversations. Starting download...`);

    const jsonDir = join(OUTPUT_DIR, "json");
    const mdDir = join(OUTPUT_DIR, "markdown");
    const htmlDir = join(OUTPUT_DIR, "html");
    const filesDir = join(OUTPUT_DIR, "files");
    mkdirSync(jsonDir, { recursive: true });
    mkdirSync(mdDir, { recursive: true });
    mkdirSync(htmlDir, { recursive: true });

    const zipFiles = [];
    const failed = [];
    let totalFiles = 0;
    let failedFiles = 0;
    const failedFileDetails = [];

    // Pass 1: Download all conversations and files
    const downloaded = []; // { fname, title, convo, jsonStr, fileMap }

    for (let i = 0; i < total; i++) {
      const { id: cid, title: rawTitle } = conversations[i];
      const title = rawTitle || "Untitled";
      const safe = sanitizeFilename(title);
      const fname = `${safe}_${cid.slice(0, 8)}`;

      sendEvent("progress", JSON.stringify({ current: i + 1, total, title }));

      try {
        const convo = await apiGet(`conversation/${cid}`, token);
        const jsonStr = JSON.stringify(convo, null, 2);

        // Extract and download file references
        const fileRefs = extractFileReferences(convo);
        const fileMap = {};
        const usedNames = new Set();

        console.log(`[${fname}] Found ${fileRefs.length} file ref(s)`);
        if (fileRefs.length) {
          for (const ref of fileRefs) console.log(`  -> ${ref.type}: ${ref.filename} (${ref.fileId})`);
          const convFilesDir = join(filesDir, fname);
          mkdirSync(convFilesDir, { recursive: true });

          for (const ref of fileRefs) {
            totalFiles++;
            try {
              console.log(`  Downloading ${ref.fileId}...`);
              sendEvent("status", `Downloading file ${totalFiles} for "${title}"...`);
              const { filename: dlName, buffer } = await downloadFile(ref.fileId, token, ref.filename);
              const actualName = deduplicateFilename(dlName || ref.filename, usedNames);
              writeFileSync(join(convFilesDir, actualName), buffer);
              zipFiles.push({ path: `files/${fname}/${actualName}`, data: buffer });
              fileMap[ref.fileId] = `../files/${fname}/${actualName}`;
              await sleep(DELAY);
            } catch (e) {
              failedFiles++;
              console.error(`  FAILED: ${ref.filename} (${ref.fileId}): ${e.message}`);
            }
          }
        }

        // Write JSON and Markdown immediately
        const mdStr = conversationToMarkdown(convo, fileMap);
        writeFileSync(join(jsonDir, `${fname}.json`), jsonStr, "utf8");
        writeFileSync(join(mdDir, `${fname}.md`), mdStr, "utf8");
        zipFiles.push({ path: `json/${fname}.json`, data: jsonStr });
        zipFiles.push({ path: `markdown/${fname}.md`, data: mdStr });

        // Store for HTML pass 2 (needs full conversation list for sidebar)
        downloaded.push({ fname, title, convo, fileMap });
      } catch (e) {
        console.error(`[conversation error] "${title}": ${e.message}`);
        failed.push(title);
      }

      await sleep(DELAY);
    }

    // Pass 2: Generate HTML with sidebar navigation
    sendEvent("status", "Generating HTML pages...");
    const allConvos = downloaded.map((d) => ({ fname: d.fname, title: d.title }));

    for (const d of downloaded) {
      const htmlStr = conversationToHtml(d.convo, d.fileMap, allConvos, d.fname);
      writeFileSync(join(htmlDir, `${d.fname}.html`), htmlStr, "utf8");
      zipFiles.push({ path: `html/${d.fname}.html`, data: htmlStr });
    }

    sendEvent("status", "Creating ZIP archive...");
    const zipBuf = buildZip(zipFiles);
    writeFileSync(ZIP_PATH, zipBuf);

    if (failedFileDetails.length) {
      console.error(`\n${failedFiles} file download(s) failed:`);
      for (const d of failedFileDetails) console.error(`  - ${d}`);
      console.error("");
    }

    let doneMsg = {
      total,
      succeeded: total - failed.length,
      failed: failed.length,
      failedTitles: failed,
      output: OUTPUT_DIR,
      zip: ZIP_PATH,
      totalFiles,
      failedFiles,
      failedFileDetails,
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
<title>ChatGPT Exporter</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: #0f172a; color: #e2e8f0;
    min-height: 100vh; display: flex; align-items: center; justify-content: center;
  }
  .card {
    background: #1e293b; border-radius: 16px; padding: 40px;
    max-width: 580px; width: 100%; box-shadow: 0 25px 50px rgba(0,0,0,0.4);
  }
  h1 { font-size: 24px; margin-bottom: 8px; color: #f8fafc; }
  .subtitle { color: #94a3b8; margin-bottom: 32px; font-size: 14px; }
  .step { display: flex; gap: 12px; margin-bottom: 20px; }
  .step-num {
    flex-shrink: 0; width: 28px; height: 28px; border-radius: 50%;
    background: #3b82f6; color: #fff; display: flex; align-items: center;
    justify-content: center; font-size: 13px; font-weight: 600;
  }
  .step-num.done { background: #22c55e; }
  .step-text { font-size: 14px; line-height: 1.6; padding-top: 3px; }
  .step-text a { color: #60a5fa; text-decoration: none; }
  .step-text a:hover { text-decoration: underline; }
  kbd {
    background: #334155; border-radius: 4px; padding: 2px 6px;
    font-family: inherit; font-size: 12px; border: 1px solid #475569;
  }
  textarea {
    width: 100%; height: 100px; background: #0f172a; border: 2px solid #334155;
    border-radius: 8px; color: #e2e8f0; padding: 12px; font-family: monospace;
    font-size: 13px; resize: vertical; margin: 16px 0;
  }
  textarea:focus { outline: none; border-color: #3b82f6; }
  textarea::placeholder { color: #64748b; }
  button {
    width: 100%; padding: 12px; border: none; border-radius: 8px;
    background: #3b82f6; color: #fff; font-size: 15px; font-weight: 600;
    cursor: pointer; transition: background 0.2s;
  }
  button:hover { background: #2563eb; }
  button:disabled { background: #475569; cursor: not-allowed; }
  .progress-section { margin-top: 24px; }
  .progress-bar-bg {
    width: 100%; height: 8px; background: #334155; border-radius: 4px;
    overflow: hidden; margin: 12px 0;
  }
  .progress-bar {
    height: 100%; background: #3b82f6; border-radius: 4px;
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
  <h1>ChatGPT Exporter</h1>
  <p class="subtitle">Export all your conversations as JSON, Markdown &amp; HTML</p>

  <div id="steps">
    <div class="step">
      <div class="step-num" id="step1-num">1</div>
      <div class="step-text">
        Open <a href="https://chatgpt.com/api/auth/session" target="_blank">
        chatgpt.com/api/auth/session</a> in a new tab.<br>
        <span style="color:#94a3b8">(If you see a login page, log in first, then open the link again.)</span>
      </div>
    </div>
    <div class="step">
      <div class="step-num" id="step2-num">2</div>
      <div class="step-text">
        Select all the text on that page (<kbd>Cmd+A</kbd>),
        copy it (<kbd>Cmd+C</kbd>), and paste it below.
      </div>
    </div>
  </div>

  <textarea id="token-input" placeholder='Paste the session JSON here &#x2014; it looks like {"user":{...},"accessToken":"eyJhbG..."}'></textarea>
  <button id="export-btn" onclick="startExport()">Export conversations</button>

  <div id="progress-section" class="progress-section hidden">
    <div class="progress-bar-bg"><div class="progress-bar" id="progress-bar"></div></div>
    <div class="progress-text" id="progress-text">Starting...</div>
    <div class="current-title" id="current-title"></div>
  </div>

  <div id="result" class="result hidden"></div>
</div>

<script>
const isMac = navigator.platform.toUpperCase().includes('MAC');
if (!isMac) {
  document.querySelectorAll('kbd').forEach(el => {
    el.textContent = el.textContent.replace('Cmd', 'Ctrl');
  });
}

function startExport() {
  const raw = document.getElementById('token-input').value.trim();
  if (!raw) return alert('Please paste the session JSON first.');

  let parsed;
  try { parsed = JSON.parse(raw); } catch {
    return alert('Invalid JSON. Make sure you copied the entire page content.');
  }
  const token = parsed.accessToken;
  if (!token) return alert('No "accessToken" found. Make sure you are logged in and copied the full page.');

  document.getElementById('export-btn').disabled = true;
  document.getElementById('token-input').disabled = true;
  document.getElementById('progress-section').classList.remove('hidden');
  document.getElementById('result').classList.add('hidden');
  document.getElementById('step1-num').classList.add('done');
  document.getElementById('step1-num').textContent = '\\u2713';
  document.getElementById('step2-num').classList.add('done');
  document.getElementById('step2-num').textContent = '\\u2713';

  fetch('/start-export', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
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
          showResult('success', 'No conversations found in your account.');
        } else {
          let msg = 'Done! Exported ' + d.succeeded + ' of ' + d.total + ' conversations.';
          if (d.totalFiles > 0) msg += '<br>' + (d.totalFiles - d.failedFiles) + ' of ' + d.totalFiles + ' files downloaded.';
          msg += '<br><br>Saved to:<br><code>' + d.output + '</code>';
          msg += '<br><code>' + d.zip + '</code>';
          if (d.failed > 0) msg += '<br><br>' + d.failed + ' conversations failed: ' + d.failedTitles.join(', ');
          if (d.failedFileDetails && d.failedFileDetails.length) msg += '<br><br>File download errors:<br>' + d.failedFileDetails.map(s => '&bull; ' + s).join('<br>');
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
  document.getElementById('token-input').disabled = false;
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

const exports = new Map(); // exportId -> { events: [], done: false }

const server = createServer((req, res) => {
  if (req.method === "GET" && (req.url === "/" || req.url === "")) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(HTML_PAGE);
  } else if (req.method === "POST" && req.url === "/start-export") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let token;
      try {
        token = JSON.parse(body).token;
      } catch {
        res.writeHead(400);
        res.end();
        return;
      }

      const exportId = randomUUID().slice(0, 8);
      exports.set(exportId, { events: [], done: false });

      const sendEvent = (type, data) => {
        const entry = exports.get(exportId);
        if (entry) entry.events.push({ type: type, data: data.replace(/\n/g, "\\n") });
      };

      runExport(token, sendEvent).finally(() => {
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
  console.log(`ChatGPT Exporter running at ${url}`);
  console.log("Press Ctrl+C to stop.\n");

  // Open browser
  try {
    if (process.platform === "darwin") execSync(`open "${url}"`);
    else if (process.platform === "linux") execSync(`xdg-open "${url}"`);
  } catch {}
});
