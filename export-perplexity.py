#!/usr/bin/env python3
"""
Perplexity Conversation Exporter — Python 3 with local web UI.
Starts a local server, opens a browser with a nice UI,
user pastes their session cookie, and threads are exported.
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

API_VERSION = "2.18"
API_BASE = "https://www.perplexity.ai/rest"
PAGE_SIZE = 20
RATE_LIMIT_DELAY = 0.4
OUTPUT_DIR = Path.home() / "Desktop" / "perplexity-export"
ZIP_PATH = Path.home() / "Desktop" / "perplexity-export.zip"
HOST = "127.0.0.1"
PORT = 8424

BROWSER_HEADERS = {
    "content-type": "application/json",
    "x-app-apiversion": API_VERSION,
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Accept": "application/json, */*",
    "Accept-Language": "en-US,en;q=0.9",
}

SSL_CTX = ssl.create_default_context()


# ── API helpers ──────────────────────────────────────────────────────

def api_post(path, body, reason, cookie):
    url = f"{API_BASE}{path}"
    data = json.dumps(body).encode("utf-8")
    headers = {**BROWSER_HEADERS}
    if reason:
        headers["x-perplexity-request-endpoint"] = f"{API_BASE}{path}"
        headers["x-perplexity-request-reason"] = reason
    if cookie:
        headers["Cookie"] = f"__Secure-next-auth.session-token={cookie}"
    req = Request(url, data=data, headers=headers)
    try:
        with urlopen(req, context=SSL_CTX) as resp:
            return json.loads(resp.read().decode())
    except HTTPError as e:
        body_text = e.read().decode("utf-8", errors="replace")[:300]
        raise Exception(f"HTTP {e.code}: {body_text}")


def api_get(path, cookie):
    url = f"{API_BASE}{path}"
    headers = {**BROWSER_HEADERS}
    if cookie:
        headers["Cookie"] = f"__Secure-next-auth.session-token={cookie}"
    req = Request(url, headers=headers)
    try:
        with urlopen(req, context=SSL_CTX) as resp:
            return json.loads(resp.read().decode())
    except HTTPError as e:
        body_text = e.read().decode("utf-8", errors="replace")[:300]
        raise Exception(f"HTTP {e.code}: {body_text}")


def sanitize_filename(name, max_len=80):
    name = re.sub(r'[<>:"/\\|?*]', "_", name)
    name = re.sub(r'^[. ]+|[. ]+$', "", name)
    return name[:max_len] or "untitled"


def escape_html(s):
    return html_module.escape(s, quote=True)


# ── Markdown converter ──────────────────────────────────────────────

def to_markdown(convo):
    title = convo.get("title") or convo.get("query_str") or "Untitled"
    ut = convo.get("updated_at") or convo.get("created_at")
    date_str = ""
    if ut:
        try:
            dt = datetime.fromisoformat(str(ut).replace("Z", "+00:00"))
            date_str = dt.strftime("%Y-%m-%d %H:%M") + " UTC"
        except Exception:
            pass

    lines = [f"# {title}", ""]
    if date_str:
        lines.append(f"*{date_str}*\n")

    entries = convo.get("entries") or convo.get("steps") or []
    for entry in entries:
        steps = []
        text = entry.get("text")
        if isinstance(text, str):
            try:
                parsed = json.loads(text)
                steps = parsed if isinstance(parsed, list) else parsed.get("steps", [])
            except Exception:
                steps = []
        elif isinstance(text, list):
            steps = text

        for step in steps:
            if step.get("step_type") == "INITIAL_QUERY":
                q = step.get("content", {}).get("query", "")
                if q:
                    lines.append(f"## Q: {q}\n")
            if step.get("step_type") == "FINAL":
                answer_raw = step.get("content", {}).get("answer")
                answer_data = {}
                if isinstance(answer_raw, str):
                    try:
                        answer_data = json.loads(answer_raw)
                    except Exception:
                        answer_data = {}
                elif isinstance(answer_raw, dict):
                    answer_data = answer_raw
                a = answer_data.get("answer", "")
                if a:
                    lines.append(f"{a}\n")
                sources = answer_data.get("web_results", [])
                if sources:
                    lines.append("**Sources:**\n")
                    for src in sources:
                        name = src.get("name") or "source"
                        url = src.get("url", "")
                        if url:
                            lines.append(f"- [{name}]({url})")
                        else:
                            lines.append(f"- {name}")
                    lines.append("")

    if len(lines) <= 2 and convo.get("query_str"):
        lines.append(f"{convo.get('query_str')}\n")

    return "\n".join(lines)


# ── HTML converter ──────────────────────────────────────────────────

def to_html(convo, all_convos, current_fname):
    title = escape_html(convo.get("title") or convo.get("query_str") or "Untitled")
    ut = convo.get("updated_at") or convo.get("created_at")
    date_str = ""
    if ut:
        try:
            dt = datetime.fromisoformat(str(ut).replace("Z", "+00:00"))
            date_str = dt.strftime("%Y-%m-%d %H:%M") + " UTC"
        except Exception:
            pass

    entries = convo.get("entries") or convo.get("steps") or []
    messages_html_parts = []

    for entry in entries:
        steps = []
        text = entry.get("text")
        if isinstance(text, str):
            try:
                parsed = json.loads(text)
                steps = parsed if isinstance(parsed, list) else parsed.get("steps", [])
            except Exception:
                steps = []
        elif isinstance(text, list):
            steps = text

        for step in steps:
            if step.get("step_type") == "INITIAL_QUERY":
                q = step.get("content", {}).get("query", "")
                if q:
                    escaped_q = escape_html(q).replace("\n", "<br>")
                    messages_html_parts.append(
                        f'<div class="message user"><div class="bubble" dir="auto">{escaped_q}</div></div>'
                    )
            if step.get("step_type") == "FINAL":
                answer_raw = step.get("content", {}).get("answer")
                answer_data = {}
                if isinstance(answer_raw, str):
                    try:
                        answer_data = json.loads(answer_raw)
                    except Exception:
                        answer_data = {}
                elif isinstance(answer_raw, dict):
                    answer_data = answer_raw
                a = answer_data.get("answer", "")
                if a:
                    b64 = base64.b64encode(a.encode("utf-8")).decode("ascii")
                    msg = f'<div class="message assistant"><div class="avatar">P</div><div class="content"><div class="md-content" dir="auto" data-md="{b64}"></div>'

                    sources = answer_data.get("web_results", [])
                    if sources:
                        msg += '<div class="sources"><div class="sources-title">Sources</div>'
                        for src in sources:
                            name = src.get("name") or "source"
                            url = src.get("url", "#")
                            msg += f'<a class="source-link" href="{escape_html(url)}" target="_blank" rel="noopener">{escape_html(name)}</a>'
                        msg += '</div>'

                    msg += '</div></div>'
                    messages_html_parts.append(msg)

    if not messages_html_parts and convo.get("query_str"):
        escaped_q = escape_html(convo.get("query_str")).replace("\n", "<br>")
        messages_html_parts.append(
            f'<div class="message user"><div class="bubble" dir="auto">{escaped_q}</div></div>'
        )

    messages_html = "\n".join(messages_html_parts)

    sidebar_items = []
    for c in all_convos:
        cls = "sidebar-item active" if c["fname"] == current_fname else "sidebar-item"
        sidebar_items.append(
            f'<a class="{cls}" href="{c["fname"]}.html" title="{escape_html(c["title"])}">{escape_html(c["title"])}</a>'
        )
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
    .sidebar {{ position: fixed; left: -280px; z-index: 99; transition: left 0.2s; box-shadow: 2px 0 8px rgba(0,0,0,0.1); }}
    .sidebar.open {{ left: 0; }}
    .sidebar-toggle {{ display: flex; }}
    .main {{ margin-left: 0 !important; }}
  }}
  .main {{ flex: 1; overflow-y: auto; }}
  .header {{ max-width: 768px; margin: 0 auto; padding: 32px 24px 16px; border-bottom: 1px solid #e5e5e5; }}
  .header h1 {{ font-size: 22px; font-weight: 600; }}
  .header .date {{ font-size: 13px; color: #6b6b6b; margin-top: 4px; }}
  .chat {{ max-width: 768px; margin: 0 auto; padding: 24px; }}
  .message {{ margin-bottom: 24px; }}
  .message.user {{ display: flex; justify-content: flex-end; }}
  .message.user .bubble {{
    background: #f4f4f4; border-radius: 18px; padding: 10px 16px;
    max-width: 85%; white-space: pre-wrap; word-break: break-word;
  }}
  .message.assistant {{ display: flex; gap: 12px; align-items: flex-start; }}
  .message.assistant .avatar {{
    width: 28px; height: 28px; border-radius: 50%;
    background: #20808d; color: #fff;
    display: flex; align-items: center; justify-content: center;
    flex-shrink: 0; margin-top: 2px; font-size: 14px; font-weight: 700;
  }}
  .message.assistant .content {{ flex: 1; min-width: 0; }}
  .message.assistant .content h1, .message.assistant .content h2, .message.assistant .content h3 {{ margin: 16px 0 8px; font-weight: 600; }}
  .message.assistant .content h1 {{ font-size: 20px; }}
  .message.assistant .content h2 {{ font-size: 18px; }}
  .message.assistant .content h3 {{ font-size: 16px; }}
  .message.assistant .content p {{ margin: 8px 0; }}
  .message.assistant .content ul, .message.assistant .content ol {{ margin: 8px 0; padding-left: 24px; }}
  .message.assistant .content li {{ margin: 4px 0; }}
  .message.assistant .content a {{ color: #20808d; }}
  .message.assistant .content code {{ background: #f0f0f0; border-radius: 4px; padding: 2px 5px; font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace; font-size: 14px; }}
  .message.assistant .content pre {{ margin: 12px 0; border-radius: 8px; overflow: hidden; }}
  .message.assistant .content pre code {{ display: block; background: #0d0d0d; color: #f8f8f2; padding: 16px; overflow-x: auto; border-radius: 0; font-size: 13px; line-height: 1.5; }}
  .code-block {{ position: relative; }}
  .code-block .copy-btn {{ position: absolute; top: 8px; right: 8px; background: #333; border: none; color: #999; cursor: pointer; font-size: 12px; padding: 4px 10px; border-radius: 4px; opacity: 0; transition: opacity 0.2s; }}
  .code-block:hover .copy-btn {{ opacity: 1; }}
  .code-block .copy-btn:hover {{ color: #fff; background: #555; }}
  .sources {{ margin-top: 12px; }}
  .sources-title {{ font-size: 13px; font-weight: 600; color: #6b6b6b; margin-bottom: 6px; }}
  .source-link {{ display: inline-block; padding: 4px 12px; margin: 2px 4px 2px 0; background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 16px; font-size: 13px; color: #166534; text-decoration: none; }}
  .source-link:hover {{ background: #dcfce7; }}
</style>
</head>
<body>
<button class="sidebar-toggle" onclick="document.querySelector('.sidebar').classList.toggle('open')">&#9776;</button>
<nav class="sidebar">
  <div class="sidebar-header">Threads</div>
  {sidebar_html}
</nav>
<div class="main">
  <div class="header">
    <h1>{title}</h1>
    {(f'<div class="date">{date_str}</div>') if date_str else ""}
  </div>
  <div class="chat">
  {messages_html}
  </div>
</div>
<script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"><\/script>
<script src="https://cdn.jsdelivr.net/gh/highlightjs/cdn-release/build/highlight.min.js"><\/script>
<script>
document.addEventListener('DOMContentLoaded', () => {{
  marked.setOptions({{
    highlight: (code, lang) => {{
      if (lang && hljs.getLanguage(lang)) return hljs.highlight(code, {{ language: lang }}).value;
      return hljs.highlightAuto(code).value;
    }},
    breaks: true,
  }});
  const renderer = new marked.Renderer();
  renderer.code = function({{ text, lang }}) {{
    const highlighted = lang && hljs.getLanguage(lang) ? hljs.highlight(text, {{ language: lang }}).value : hljs.highlightAuto(text).value;
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
<\/script>
</body>
</html>"""


# ── Export logic ────────────────────────────────────────────────────

def run_export(cookie, send_event):
    try:
        send_event("status", "Fetching thread list...")
        threads = []
        offset = 0

        while True:
            data = api_post(
                f"/thread/list_ask_threads?version={API_VERSION}&source=default",
                {"limit": PAGE_SIZE, "ascending": False, "offset": offset, "search_term": ""},
                "threads-body",
                cookie
            )
            if not isinstance(data, list) or not data:
                break
            threads.extend(data)
            total_est = len(threads) + PAGE_SIZE
            send_event("status", f"Fetching thread list... {len(threads)}/{total_est}")

            last = data[-1] if data else {}
            if not last.get("has_next_page"):
                break
            offset += PAGE_SIZE
            time.sleep(RATE_LIMIT_DELAY)

        total = len(threads)
        if total == 0:
            send_event("done", json.dumps({"total": 0, "succeeded": 0, "failed": 0, "output": ""}))
            return

        send_event("status", f"Found {total} threads. Starting download...")

        json_dir = OUTPUT_DIR / "json"
        md_dir = OUTPUT_DIR / "markdown"
        html_dir = OUTPUT_DIR / "html"
        json_dir.mkdir(parents=True, exist_ok=True)
        md_dir.mkdir(parents=True, exist_ok=True)
        html_dir.mkdir(parents=True, exist_ok=True)

        zip_files = []
        failed = []
        downloaded = []

        for i, thread in enumerate(threads):
            uuid_val = thread.get("uuid", "")
            query_str = thread.get("query_str", "")
            raw_title = thread.get("title", "")
            updated_at = thread.get("updated_at")
            slug = thread.get("slug", "")
            title = raw_title or query_str or "Untitled"
            safe = sanitize_filename(title)
            fname = f"{safe}_{uuid_val[:8] if uuid_val else i}"

            send_event("progress", json.dumps({"current": i + 1, "total": total, "title": title}))

            try:
                detail = api_get(f"/thread/{slug or uuid_val}", cookie)
                convo = {**detail, "query_str": query_str, "title": title, "updated_at": updated_at, "slug": slug, "uuid": uuid_val}
                json_str = json.dumps(convo, indent=2, ensure_ascii=False)

                md_str = to_markdown(convo)
                (json_dir / f"{fname}.json").write_text(json_str, encoding="utf-8")
                (md_dir / f"{fname}.md").write_text(md_str, encoding="utf-8")
                zip_files.append({"path": f"json/{fname}.json", "data": json_str})
                zip_files.append({"path": f"markdown/{fname}.md", "data": md_str})

                downloaded.append({"fname": fname, "title": title, "convo": convo})
            except Exception as e:
                print(f'[thread error] "{title}": {e}')
                failed.append(title)

            time.sleep(RATE_LIMIT_DELAY)

        # Pass 2: Generate HTML
        send_event("status", "Generating HTML pages...")
        all_convos = [{"fname": d["fname"], "title": d["title"]} for d in downloaded]

        for d in downloaded:
            html_str = to_html(d["convo"], all_convos, d["fname"])
            (html_dir / f'{d["fname"]}.html').write_text(html_str, encoding="utf-8")
            zip_files.append({"path": f'html/{d["fname"]}.html', "data": html_str})

        # Build ZIP
        send_event("status", "Creating ZIP archive...")
        with zipfile.ZipFile(ZIP_PATH, "w", zipfile.ZIP_STORED) as zf:
            for zf_entry in zip_files:
                zf.writestr(zf_entry["path"], zf_entry["data"].encode("utf-8"))

        done_msg = {
            "total": total,
            "succeeded": total - len(failed),
            "failed": len(failed),
            "failedTitles": failed,
            "output": str(OUTPUT_DIR),
            "zip": str(ZIP_PATH),
        }
        send_event("done", json.dumps(done_msg))
    except Exception as e:
        send_event("error_msg", f"Export failed: {e}")


# ── HTML page ───────────────────────────────────────────────────────

HTML_PAGE = """<!DOCTYPE html>
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
</html>"""


# ── HTTP server ─────────────────────────────────────────────────────

_exports = {}
_exports_lock = threading.Lock()


class ExportHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        pass  # suppress logs

    def do_GET(self):
        if self.path in ("/", ""):
            self._serve_html(HTML_PAGE)
        elif self.path.startswith("/progress/"):
            self._serve_sse(self.path.split("/progress/")[1])
        else:
            self.send_response(404)
            self.end_headers()

    def do_POST(self):
        if self.path == "/start-export":
            content_length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(content_length).decode("utf-8")
            try:
                cookie = json.loads(body)["cookie"]
            except Exception:
                self.send_response(400)
                self.end_headers()
                return

            export_id = str(uuid.uuid4())[:8]

            with _exports_lock:
                _exports[export_id] = {"events": [], "done": False}

            def send_event(etype, data):
                with _exports_lock:
                    entry = _exports.get(export_id)
                    if entry:
                        entry["events"].append({"type": etype, "data": data.replace("\\n", "\\\\n")})

            def export_thread():
                try:
                    run_export(cookie, send_event)
                finally:
                    with _exports_lock:
                        entry = _exports.get(export_id)
                        if entry:
                            entry["done"] = True

            threading.Thread(target=export_thread, daemon=True).start()

            self._serve_json({"exportId": export_id})
        else:
            self.send_response(404)
            self.end_headers()

    def _serve_html(self, content):
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.end_headers()
        self.wfile.write(content.encode("utf-8"))

    def _serve_json(self, data):
        body = json.dumps(data).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _serve_sse(self, export_id):
        with _exports_lock:
            entry = _exports.get(export_id)

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
        try:
            while True:
                with _exports_lock:
                    events = list(entry["events"])
                    done = entry["done"]

                while sent < len(events):
                    evt = events[sent]
                    sent += 1
                    line = f"event: {evt['type']}\ndata: {evt['data']}\n\n"
                    self.wfile.write(line.encode("utf-8"))
                    self.wfile.flush()

                if done and sent >= len(events):
                    with _exports_lock:
                        _exports.pop(export_id, None)
                    break

                time.sleep(0.2)
        except (BrokenPipeError, ConnectionResetError):
            pass


# ── Main ────────────────────────────────────────────────────────────

def main():
    server = HTTPServer((HOST, PORT), ExportHandler)
    url = f"http://{HOST}:{PORT}"
    print(f"Perplexity Exporter running at {url}")
    print("Press Ctrl+C to stop.\n")

    webbrowser.open(url)

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down...")
        server.shutdown()


if __name__ == "__main__":
    main()
