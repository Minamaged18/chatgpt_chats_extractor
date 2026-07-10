#!/usr/bin/env python3
"""
ChatGPT Conversation Exporter — Python with local web UI.
Starts a local server, opens a browser with a nice UI,
user pastes their session JSON, and conversations are exported.
Uses only Python 3 standard library.
"""

import base64
import html as html_module
import json
import os
import re
import ssl
import time
import uuid
import webbrowser
import zipfile
import threading
from datetime import datetime, timezone
from http.server import HTTPServer, BaseHTTPRequestHandler
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

API_BASE = "https://chatgpt.com/backend-api"
PAGE_SIZE = 100
RATE_LIMIT_DELAY = 0.5
OUTPUT_DIR = Path.home() / "Desktop" / "chatgpt-export"
ZIP_PATH = Path.home() / "Desktop" / "chatgpt-export.zip"
HOST = "127.0.0.1"
PORT = 8423
DEVICE_ID = str(uuid.uuid4())

BROWSER_HEADERS = {
    "Content-Type": "application/json",
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Accept": "application/json",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": "https://chatgpt.com/",
    "Origin": "https://chatgpt.com",
    "Oai-Device-Id": DEVICE_ID,
    "Oai-Language": "en-US",
    "Sec-Ch-Ua": '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
    "Sec-Ch-Ua-Mobile": "?0",
    "Sec-Ch-Ua-Platform": '"macOS"',
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin",
}

SSL_CTX = ssl.create_default_context()

# ── API helpers ──────────────────────────────────────────────────────

def api_get(path, token):
    url = f"{API_BASE}/{path}"
    headers = {**BROWSER_HEADERS, "Authorization": f"Bearer {token}"}
    req = Request(url, headers=headers)
    with urlopen(req, context=SSL_CTX) as resp:
        return json.loads(resp.read().decode())


def api_fetch_binary(url, token=None):
    headers = {**BROWSER_HEADERS, "Accept": "*/*"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = Request(url, headers=headers)
    with urlopen(req, context=SSL_CTX) as resp:
        data = resp.read()
        content_type = resp.headers.get("Content-Type", "")
        return data, content_type


MIME_TO_EXT = {
    "image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif",
    "image/webp": ".webp", "image/svg+xml": ".svg", "application/pdf": ".pdf",
    "text/plain": ".txt", "text/html": ".html", "text/csv": ".csv",
    "application/json": ".json", "application/zip": ".zip",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
}


# ── File references ──────────────────────────────────────────────────

def extract_file_references(convo):
    refs = []
    seen = set()
    mapping = convo.get("mapping", {})

    for node in mapping.values():
        msg = node.get("message")
        if not msg:
            continue

        # image_asset_pointer in content parts
        parts = msg.get("content", {}).get("parts", [])
        for part in parts:
            if isinstance(part, dict) and part.get("content_type") == "image_asset_pointer":
                ap = part.get("asset_pointer", "")
                m = re.match(r"^(?:file-service|sediment)://(.+)$", ap)
                if m and m.group(1) not in seen:
                    seen.add(m.group(1))
                    dalle_prompt = (part.get("metadata") or {}).get("dalle", {}).get("prompt")
                    refs.append({
                        "file_id": m.group(1),
                        "filename": "dalle_image.png" if dalle_prompt else "image.png",
                        "type": "image",
                    })

        # metadata.attachments
        for att in msg.get("metadata", {}).get("attachments", []):
            fid = att.get("id")
            if fid and fid not in seen:
                seen.add(fid)
                refs.append({
                    "file_id": fid,
                    "filename": att.get("name", "attachment"),
                    "type": "attachment",
                })

        # metadata.citations
        for cit in msg.get("metadata", {}).get("citations", []):
            fid = (cit.get("metadata") or {}).get("file_id") or cit.get("file_id")
            title = (cit.get("metadata") or {}).get("title") or cit.get("title", "citation")
            if fid and fid not in seen:
                seen.add(fid)
                refs.append({
                    "file_id": fid,
                    "filename": title,
                    "type": "citation",
                })

    return refs


def download_file(file_id, token, fallback_name=None):
    meta = api_get(f"files/download/{file_id}", token)
    url = meta.get("download_url")
    if not url:
        raise ValueError("No download_url returned")
    data, content_type = api_fetch_binary(url, token)
    filename = meta.get("file_name") or fallback_name or file_id
    # Add extension from content-type if missing
    if "." not in filename and content_type:
        mime = content_type.split(";")[0].strip()
        ext = MIME_TO_EXT.get(mime)
        if ext:
            filename += ext
    return filename, data


def deduplicate_filename(name, used_names):
    if name not in used_names:
        used_names.add(name)
        return name
    dot = name.rfind(".")
    base = name[:dot] if dot > 0 else name
    ext = name[dot:] if dot > 0 else ""
    i = 1
    while f"{base}_{i}{ext}" in used_names:
        i += 1
    deduped = f"{base}_{i}{ext}"
    used_names.add(deduped)
    return deduped


# ── Markdown converter ───────────────────────────────────────────────

def conversation_to_markdown(convo, file_map=None):
    if file_map is None:
        file_map = {}
    title = convo.get("title", "Untitled")
    ct = convo.get("create_time")
    date_str = ""
    if ct:
        dt = datetime.fromtimestamp(ct, tz=timezone.utc)
        date_str = dt.strftime("%Y-%m-%d %H:%M UTC")

    lines = [f"# {title}", ""]
    if date_str:
        lines.append(f"*{date_str}*\n")

    mapping = convo.get("mapping", {})
    root_id = next((k for k, v in mapping.items() if v.get("parent") is None), None)

    if root_id:
        queue = [root_id]
        while queue:
            node_id = queue.pop(0)
            node = mapping.get(node_id, {})
            msg = node.get("message")
            if msg and msg.get("content", {}).get("parts"):
                role = msg.get("author", {}).get("role", "unknown")
                content_type = msg.get("content", {}).get("content_type", "text")
                # Skip system, tool, and non-text assistant messages
                if role in ("system", "tool"):
                    queue.extend(node.get("children", []))
                    continue
                if role == "assistant" and content_type != "text":
                    queue.extend(node.get("children", []))
                    continue
                text_parts = []

                for part in msg["content"]["parts"]:
                    if isinstance(part, str):
                        text_parts.append(part)
                    elif isinstance(part, dict) and part.get("content_type") == "image_asset_pointer":
                        ap = part.get("asset_pointer", "")
                        m = re.match(r"^(?:file-service|sediment)://(.+)$", ap)
                        if m and m.group(1) in file_map:
                            text_parts.append(f"![image]({file_map[m.group(1)]})")
                        else:
                            text_parts.append("[image]")
                    else:
                        text_parts.append(json.dumps(part))

                # Add attachment links
                for att in msg.get("metadata", {}).get("attachments", []):
                    if att.get("id") and att["id"] in file_map:
                        name = att.get("name", "attachment")
                        text_parts.append(f"\n📎 [{name}]({file_map[att['id']]})")

                text = strip_citations("\n".join(text_parts)).strip()
                if text:
                    lines.append(f"## {role.capitalize()}\n\n{text}\n")
            queue.extend(node.get("children", []))

    return "\n".join(lines)


# ── HTML converter ───────────────────────────────────────────────────

OPENAI_LOGO_SVG = '<svg viewBox="0 0 41 41" fill="none" xmlns="http://www.w3.org/2000/svg" width="24" height="24"><path d="M37.532 16.87a9.963 9.963 0 0 0-.856-8.184 10.078 10.078 0 0 0-10.855-4.835A9.964 9.964 0 0 0 18.306.5a10.079 10.079 0 0 0-9.614 6.977 9.967 9.967 0 0 0-6.664 4.834 10.08 10.08 0 0 0 1.24 11.817 9.965 9.965 0 0 0 .856 8.185 10.079 10.079 0 0 0 10.855 4.835 9.965 9.965 0 0 0 7.516 3.35 10.078 10.078 0 0 0 9.617-6.981 9.967 9.967 0 0 0 6.663-4.834 10.079 10.079 0 0 0-1.243-11.813ZM22.498 37.886a7.474 7.474 0 0 1-4.799-1.735c.061-.033.168-.091.237-.134l7.964-4.6a1.294 1.294 0 0 0 .655-1.134V19.054l3.366 1.944a.12.12 0 0 1 .066.092v9.299a7.505 7.505 0 0 1-7.49 7.496ZM6.392 31.006a7.471 7.471 0 0 1-.894-5.023c.06.036.162.099.237.141l7.964 4.6a1.297 1.297 0 0 0 1.308 0l9.724-5.614v3.888a.12.12 0 0 1-.048.103l-8.051 4.649a7.504 7.504 0 0 1-10.24-2.744ZM4.297 13.62A7.469 7.469 0 0 1 8.2 10.333c0 .068-.004.19-.004.274v9.201a1.294 1.294 0 0 0 .654 1.132l9.723 5.614-3.366 1.944a.12.12 0 0 1-.114.012L7.044 23.86a7.504 7.504 0 0 1-2.747-10.24Zm27.658 6.437-9.724-5.615 3.367-1.943a.121.121 0 0 1 .114-.012l8.048 4.648a7.498 7.498 0 0 1-1.158 13.528V21.36a1.293 1.293 0 0 0-.647-1.132v-.17Zm3.35-5.043c-.059-.037-.162-.099-.236-.141l-7.965-4.6a1.298 1.298 0 0 0-1.308 0l-9.723 5.614v-3.888a.12.12 0 0 1 .048-.103l8.05-4.645a7.497 7.497 0 0 1 11.135 7.763Zm-21.063 6.929-3.367-1.944a.12.12 0 0 1-.065-.092v-9.299a7.497 7.497 0 0 1 12.293-5.756 6.94 6.94 0 0 0-.236.134l-7.965 4.6a1.294 1.294 0 0 0-.654 1.132l-.006 11.225Zm1.829-3.943 4.33-2.501 4.332 2.5v5l-4.331 2.5-4.331-2.5V18Z" fill="currentColor"/></svg>'


def conversation_to_html(convo, file_map=None, all_conversations=None, current_fname=""):
    if file_map is None:
        file_map = {}
    if all_conversations is None:
        all_conversations = []

    esc = html_module.escape
    title = esc(convo.get("title", "Untitled"))
    ct = convo.get("create_time")
    date_str = ""
    if ct:
        dt = datetime.fromtimestamp(ct, tz=timezone.utc)
        date_str = dt.strftime("%Y-%m-%d %H:%M UTC")

    messages = []
    mapping = convo.get("mapping", {})
    root_id = next((k for k, v in mapping.items() if v.get("parent") is None), None)

    if root_id:
        queue = [root_id]
        while queue:
            nid = queue.pop(0)
            node = mapping.get(nid, {})
            msg = node.get("message")
            if msg and msg.get("content", {}).get("parts"):
                role = msg.get("author", {}).get("role", "unknown")
                content_type = msg.get("content", {}).get("content_type", "text")
                if role == "system":
                    queue.extend(node.get("children", []))
                    continue

                # Determine if this is internal/thinking content
                is_internal = (role == "tool" or
                    (role == "assistant" and content_type != "text") or
                    (role == "user" and content_type == "user_editable_context"))

                text_parts = []
                image_parts = []

                for part in msg["content"]["parts"]:
                    if isinstance(part, str):
                        text_parts.append(part)
                    elif isinstance(part, dict) and part.get("content_type") == "image_asset_pointer":
                        ap = part.get("asset_pointer", "")
                        m = re.match(r"^(?:file-service|sediment)://(.+)$", ap)
                        if m and m.group(1) in file_map:
                            image_parts.append(file_map[m.group(1)])

                attachments = []
                for att in msg.get("metadata", {}).get("attachments", []):
                    if att.get("id") and att["id"] in file_map:
                        attachments.append({"name": att.get("name", "attachment"), "path": file_map[att["id"]]})

                text = strip_citations("\n".join(text_parts)).strip()
                if text or image_parts or attachments:
                    messages.append({"role": role, "text": text, "images": image_parts, "attachments": attachments, "is_internal": is_internal, "content_type": content_type})

            queue.extend(node.get("children", []))

    INTERNAL_LABELS = {
        "multimodal_text": "File context", "code": "Code", "execution_output": "Output",
        "computer_output": "Output", "tether_browsing_display": "Web browsing",
        "system_error": "Error", "text": "Tool output",
    }

    # Build message HTML
    msg_html_parts = []
    for m in messages:
        if m.get("is_internal"):
            label = INTERNAL_LABELS.get(m["content_type"], "Internal context")
            b64 = base64.b64encode(m["text"].encode("utf-8")).decode("ascii")
            msg_html_parts.append(f'<details class="thinking"><summary>{label}</summary><div class="thinking-content md-content" dir="auto" data-md="{b64}"></div></details>')
            continue

        role_class = "user" if m["role"] == "user" else "assistant"

        if m["role"] == "user":
            escaped = esc(m["text"]).replace("\n", "<br>")
            content = f'<div class="bubble" dir="auto">{escaped}</div>'
        else:
            b64 = base64.b64encode(m["text"].encode("utf-8")).decode("ascii")
            content = f'<div class="avatar">{OPENAI_LOGO_SVG}</div><div class="content"><div class="md-content" dir="auto" data-md="{b64}"></div></div>'

        if m["images"]:
            imgs = "".join(f'<a href="{esc(src)}" target="_blank"><img src="{esc(src)}" alt="image" loading="lazy"></a>' for src in m["images"])
            content += f'<div class="images">{imgs}</div>'

        if m["attachments"]:
            atts = "".join(
                f'<a class="attachment" href="{esc(a["path"])}" target="_blank"><span class="att-icon">📎</span><span class="att-name">{esc(a["name"])}</span></a>'
                for a in m["attachments"]
            )
            content += f'<div class="attachments">{atts}</div>'

        msg_html_parts.append(f'<div class="message {role_class}">{content}</div>')

    messages_html = "\n".join(msg_html_parts)

    # Build sidebar
    sidebar_items = []
    for c in all_conversations:
        cls = "sidebar-item active" if c["fname"] == current_fname else "sidebar-item"
        sidebar_items.append(f'<a class="{cls}" href="{c["fname"]}.html" title="{esc(c["title"])}">{esc(c["title"])}</a>')
    sidebar_html = "\n".join(sidebar_items)

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title}</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/highlightjs/cdn-release/build/styles/github-dark.min.css">
<style>
  * {{ box-sizing: border-box; margin: 0; padding: 0; }}
  body {{
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", sans-serif;
    background: #ffffff; color: #0d0d0d;
    line-height: 1.65; font-size: 16px;
    display: flex; height: 100vh;
  }}
  .sidebar {{
    width: 260px; min-width: 260px; height: 100vh;
    background: #f9f9f9; border-right: 1px solid #e5e5e5;
    overflow-y: auto; padding: 16px 0;
    flex-shrink: 0; position: sticky; top: 0;
  }}
  .sidebar-header {{
    padding: 8px 16px 16px; font-size: 14px; font-weight: 600;
    color: #6b6b6b; border-bottom: 1px solid #e5e5e5; margin-bottom: 8px;
  }}
  .sidebar-item {{
    display: block; padding: 8px 16px; font-size: 13px;
    color: #0d0d0d; text-decoration: none;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    border-radius: 8px; margin: 2px 8px;
  }}
  .sidebar-item:hover {{ background: #ececec; }}
  .sidebar-item.active {{ background: #e5e5e5; font-weight: 600; }}
  .sidebar-toggle {{
    display: none; position: fixed; top: 12px; left: 12px; z-index: 100;
    background: #f4f4f4; border: 1px solid #e5e5e5; border-radius: 8px;
    width: 36px; height: 36px; cursor: pointer;
    align-items: center; justify-content: center; font-size: 20px;
  }}
  @media (max-width: 768px) {{
    .sidebar {{
      position: fixed; left: -280px; z-index: 99;
      transition: left 0.2s; box-shadow: 2px 0 8px rgba(0,0,0,0.1);
    }}
    .sidebar.open {{ left: 0; }}
    .sidebar-toggle {{ display: flex; }}
    .main {{ margin-left: 0 !important; }}
  }}
  .main {{ flex: 1; overflow-y: auto; }}
  .header {{
    max-width: 768px; margin: 0 auto; padding: 32px 24px 16px;
    border-bottom: 1px solid #e5e5e5;
  }}
  .header h1 {{ font-size: 22px; font-weight: 600; }}
  .header .date {{ font-size: 13px; color: #6b6b6b; margin-top: 4px; }}
  .chat {{ max-width: 768px; margin: 0 auto; padding: 24px; }}
  .message {{ margin-bottom: 24px; }}
  .message.user {{ display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; }}
  .message.user .bubble {{
    background: #f4f4f4; border-radius: 18px; padding: 10px 16px;
    max-width: 85%; white-space: pre-wrap; word-break: break-word;
  }}
  .message.user .images {{ width: 100%; display: flex; justify-content: flex-end; }}
  .message.assistant {{ display: flex; gap: 12px; align-items: flex-start; }}
  .message.assistant .avatar {{
    width: 28px; height: 28px; border-radius: 50%;
    background: #00a67e; color: #fff;
    display: flex; align-items: center; justify-content: center;
    flex-shrink: 0; margin-top: 2px;
  }}
  .message.assistant .content {{ flex: 1; min-width: 0; }}
  .message.assistant .content h1,
  .message.assistant .content h2,
  .message.assistant .content h3 {{ margin: 16px 0 8px; font-weight: 600; }}
  .message.assistant .content h1 {{ font-size: 20px; }}
  .message.assistant .content h2 {{ font-size: 18px; }}
  .message.assistant .content h3 {{ font-size: 16px; }}
  .message.assistant .content p {{ margin: 8px 0; }}
  .message.assistant .content ul,
  .message.assistant .content ol {{ margin: 8px 0; padding-left: 24px; }}
  .message.assistant .content li {{ margin: 4px 0; }}
  .message.assistant .content a {{ color: #1a7f64; }}
  .message.assistant .content code {{
    background: #f0f0f0; border-radius: 4px; padding: 2px 5px;
    font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace;
    font-size: 14px;
  }}
  .message.assistant .content pre {{ margin: 12px 0; border-radius: 8px; overflow: hidden; }}
  .message.assistant .content pre code {{
    display: block; background: #0d0d0d; color: #f8f8f2;
    padding: 16px; overflow-x: auto; border-radius: 0;
    font-size: 13px; line-height: 1.5;
  }}
  .code-block {{ position: relative; }}
  .code-block .copy-btn {{
    position: absolute; top: 8px; right: 8px;
    background: #333; border: none; color: #999; cursor: pointer;
    font-size: 12px; padding: 4px 10px; border-radius: 4px;
    opacity: 0; transition: opacity 0.2s;
  }}
  .code-block:hover .copy-btn {{ opacity: 1; }}
  .code-block .copy-btn:hover {{ color: #fff; background: #555; }}
  .images img {{ max-width: 100%; border-radius: 8px; margin: 4px 0; display: block; cursor: pointer; }}
  .images img:hover {{ opacity: 0.9; }}
  .message.user .images img {{ max-width: 300px; }}
  .attachments {{ margin-top: 8px; display: flex; flex-wrap: wrap; gap: 8px; }}
  .attachment {{
    display: inline-flex; align-items: center; gap: 8px;
    background: #f4f4f4; border: 1px solid #e5e5e5; border-radius: 8px;
    padding: 8px 12px; text-decoration: none; color: #0d0d0d; font-size: 14px;
  }}
  .attachment:hover {{ background: #ececec; }}
  .att-icon {{ font-size: 16px; }}
  .att-name {{ overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 200px; }}

  .thinking {{
    margin-bottom: 24px; border-left: 3px solid #d4d4d4;
    padding-left: 16px; font-size: 14px;
  }}
  .thinking summary {{
    color: #8e8e8e; font-style: italic; cursor: pointer;
    padding: 4px 0; user-select: none;
  }}
  .thinking summary:hover {{ color: #555; }}
  .thinking-content {{
    color: #6b6b6b; padding: 8px 0; font-style: italic;
  }}
  .thinking-content p, .thinking-content li {{ color: #6b6b6b; }}
  .thinking-content pre code {{ opacity: 0.7; }}
  .thinking-content h1, .thinking-content h2, .thinking-content h3 {{
    color: #6b6b6b; font-size: 15px;
  }}
</style>
</head>
<body>
<button class="sidebar-toggle" onclick="document.querySelector('.sidebar').classList.toggle('open')">&#9776;</button>
<nav class="sidebar">
  <div class="sidebar-header">Conversations</div>
  {sidebar_html}
</nav>
<div class="main">
  <div class="header">
    <h1>{title}</h1>
    {"<div class='date'>" + date_str + "</div>" if date_str else ""}
  </div>
  <div class="chat">
  {messages_html}
  </div>
</div>
<script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
<script src="https://cdn.jsdelivr.net/gh/highlightjs/cdn-release/build/highlight.min.js"></script>
<script>
document.addEventListener('DOMContentLoaded', () => {{
  marked.setOptions({{
    highlight: (code, lang) => {{
      if (lang && hljs.getLanguage(lang)) {{
        return hljs.highlight(code, {{ language: lang }}).value;
      }}
      return hljs.highlightAuto(code).value;
    }},
    breaks: true,
  }});

  const renderer = new marked.Renderer();
  renderer.code = function({{ text, lang }}) {{
    const highlighted = lang && hljs.getLanguage(lang)
      ? hljs.highlight(text, {{ language: lang }}).value
      : hljs.highlightAuto(text).value;
    return '<div class="code-block"><button class="copy-btn" onclick="navigator.clipboard.writeText(this.nextElementSibling.querySelector(\\'code\\').textContent);this.textContent=\\'Copied!\\';setTimeout(()=>this.textContent=\\'Copy\\',1500)">Copy</button>'
      + '<pre><code class="hljs">' + highlighted + '</code></pre></div>';
  }};
  marked.use({{ renderer }});

  document.querySelectorAll('.md-content').forEach(el => {{
    const md = decodeURIComponent(escape(atob(el.dataset.md)));
    el.innerHTML = marked.parse(md);
  }});

  const active = document.querySelector('.sidebar-item.active');
  if (active) active.scrollIntoView({{ block: 'center', behavior: 'instant' }});
}});
</script>
</body>
</html>"""


def strip_citations(text):
    return re.sub(r"\u3010[^\u3011]*\u3011", "", text)


def sanitize_filename(name, max_length=80):
    name = re.sub(r'[<>:"/\\|?*]', "_", name)
    name = name.strip(". ")
    return name[:max_length] if name else "untitled"


# ── Export logic ─────────────────────────────────────────────────────

def run_export(token, send_event):
    try:
        send_event("status", "Fetching conversation list...")
        conversations = []
        offset = 0
        while True:
            data = api_get(f"conversations?offset={offset}&limit={PAGE_SIZE}", token)
            items = data.get("items", [])
            if not items:
                break
            conversations.extend(items)
            total = data.get("total", 0)
            send_event("status", f"Fetching conversation list... {len(conversations)}/{total}")
            offset += PAGE_SIZE
            if offset >= total:
                break
            time.sleep(RATE_LIMIT_DELAY)

        total = len(conversations)
        if total == 0:
            send_event("done", json.dumps({"total": 0, "succeeded": 0, "failed": 0, "output": ""}))
            return

        send_event("status", f"Found {total} conversations. Starting download...")

        json_dir = OUTPUT_DIR / "json"
        md_dir = OUTPUT_DIR / "markdown"
        html_dir = OUTPUT_DIR / "html"
        files_dir = OUTPUT_DIR / "files"
        json_dir.mkdir(parents=True, exist_ok=True)
        md_dir.mkdir(parents=True, exist_ok=True)
        html_dir.mkdir(parents=True, exist_ok=True)

        failed = []
        total_files = 0
        failed_files = 0

        # Pass 1: Download all conversations and files
        downloaded = []  # list of {"fname", "title", "convo", "file_map"}

        for i, convo_summary in enumerate(conversations, 1):
            cid = convo_summary["id"]
            title = convo_summary.get("title") or "Untitled"
            safe = sanitize_filename(title)
            fname = f"{safe}_{cid[:8]}"

            send_event("progress", json.dumps({"current": i, "total": total, "title": title}))

            try:
                convo = api_get(f"conversation/{cid}", token)

                # Save JSON immediately
                with open(json_dir / f"{fname}.json", "w", encoding="utf-8") as f:
                    json.dump(convo, f, indent=2, ensure_ascii=False)

                # Extract and download file references
                file_refs = extract_file_references(convo)
                file_map = {}
                used_names = set()

                if file_refs:
                    conv_files_dir = files_dir / fname
                    conv_files_dir.mkdir(parents=True, exist_ok=True)

                    for ref in file_refs:
                        total_files += 1
                        try:
                            send_event("status", f'Downloading file {total_files} for "{title}"...')
                            dl_name, data = download_file(ref["file_id"], token, ref["filename"])
                            actual_name = deduplicate_filename(dl_name or ref["filename"], used_names)
                            with open(conv_files_dir / actual_name, "wb") as f:
                                f.write(data)
                            file_map[ref["file_id"]] = f"../files/{fname}/{actual_name}"
                            time.sleep(RATE_LIMIT_DELAY)
                        except Exception:
                            failed_files += 1

                # Save Markdown immediately
                md = conversation_to_markdown(convo, file_map)
                with open(md_dir / f"{fname}.md", "w", encoding="utf-8") as f:
                    f.write(md)

                # Store for HTML pass 2
                downloaded.append({"fname": fname, "title": title, "convo": convo, "file_map": file_map})

            except Exception:
                failed.append(title)

            time.sleep(RATE_LIMIT_DELAY)

        # Pass 2: Generate HTML with sidebar navigation
        send_event("status", "Generating HTML pages...")
        all_convos = [{"fname": d["fname"], "title": d["title"]} for d in downloaded]

        for d in downloaded:
            html_content = conversation_to_html(d["convo"], d["file_map"], all_convos, d["fname"])
            with open(html_dir / f"{d['fname']}.html", "w", encoding="utf-8") as f:
                f.write(html_content)

        # Create ZIP
        send_event("status", "Creating ZIP archive...")
        with zipfile.ZipFile(ZIP_PATH, "w", zipfile.ZIP_DEFLATED) as zf:
            for dirpath, _, filenames in os.walk(OUTPUT_DIR):
                for fn in filenames:
                    filepath = Path(dirpath) / fn
                    zf.write(filepath, filepath.relative_to(OUTPUT_DIR))

        send_event("done", json.dumps({
            "total": total,
            "succeeded": total - len(failed),
            "failed": len(failed),
            "failedTitles": failed,
            "output": str(OUTPUT_DIR),
            "zip": str(ZIP_PATH),
            "totalFiles": total_files,
            "failedFiles": failed_files,
        }))
    except HTTPError as e:
        send_event("error_msg", f"API returned {e.code}. Session may have expired.")
    except Exception as e:
        send_event("error_msg", f"Export failed: {e}")


# ── HTML page (web UI for token input) ───────────────────────────────

HTML_PAGE = """<!DOCTYPE html>
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
</html>"""


# ── HTTP server ──────────────────────────────────────────────────────

exports = {}  # exportId -> {"events": [], "done": bool}


class ExportHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        pass

    def do_GET(self):
        if self.path == "/" or self.path == "":
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.end_headers()
            self.wfile.write(HTML_PAGE.encode())

        elif self.path.startswith("/progress/"):
            export_id = self.path.split("/progress/", 1)[1]
            entry = exports.get(export_id)
            if not entry:
                self.send_response(404)
                self.end_headers()
                return

            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Connection", "keep-alive")
            self.end_headers()

            sent = 0
            while True:
                while sent < len(entry["events"]):
                    evt = entry["events"][sent]
                    safe = evt["data"].replace("\n", "\\n")
                    try:
                        self.wfile.write(f"event: {evt['type']}\ndata: {safe}\n\n".encode())
                        self.wfile.flush()
                    except BrokenPipeError:
                        return
                    sent += 1
                if entry["done"] and sent >= len(entry["events"]):
                    break
                time.sleep(0.2)

            exports.pop(export_id, None)

        else:
            self.send_response(404)
            self.end_headers()

    def do_POST(self):
        if self.path == "/start-export":
            content_length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(content_length)

            try:
                token = json.loads(body)["token"]
            except (json.JSONDecodeError, KeyError):
                self.send_response(400)
                self.end_headers()
                return

            export_id = str(uuid.uuid4())[:8]
            exports[export_id] = {"events": [], "done": False}

            def send_event(event_type, data):
                if event_type == "error":
                    event_type = "error_msg"
                exports[export_id]["events"].append({"type": event_type, "data": data})

            def background():
                run_export(token, send_event)
                exports[export_id]["done"] = True

            threading.Thread(target=background, daemon=True).start()

            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"exportId": export_id}).encode())

        else:
            self.send_response(404)
            self.end_headers()


# ── Main ─────────────────────────────────────────────────────────────

def main():
    server = HTTPServer((HOST, PORT), ExportHandler)
    url = f"http://{HOST}:{PORT}"

    print(f"ChatGPT Exporter running at {url}")
    print("Press Ctrl+C to stop.\n")

    webbrowser.open(url)

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
        server.server_close()


if __name__ == "__main__":
    main()
