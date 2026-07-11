# ChatGPT & Perplexity Conversation Exporters

Export all your conversations from ChatGPT and Perplexity as **JSON + Markdown + HTML + ZIP** — pick individual chats or export everything.

| Feature | ChatGPT | Perplexity |
|---------|:-------:|:----------:|
| Export chats to JSON | ✅ | ✅ |
| Markdown output | ✅ | ✅ |
| HTML viewer with sidebar | ✅ | ✅ |
| Downloaded files (images, PDFs, code outputs) | ✅ | ❌ |
| Source citations | ❌ | ✅ |
| Select which chats to export | ✅ | ✅ |

---

## How to use

### 1. Start the server

```bash
git clone https://github.com/Minamaged18/chatgpt_chats_extractor.git
cd chatgpt_chats_extractor
python3 serve.py
```

You'll see a message like `Exporter Server running`.

### 2. Go to ChatGPT or Perplexity

Go to the site and **log in**.

### 3. Open the console and paste

Press **F12** → **Console** tab. If you see `Type "allow pasting"`, type that first and press Enter. Then paste the one-liner:

**For ChatGPT:**
```js
fetch("http://127.0.0.1:8425/export-chatgpt-console.js").then(r=>r.text()).then(eval)
```

**For Perplexity:**
```js
fetch("http://127.0.0.1:8425/export-perplexity-console.js").then(r=>r.text()).then(eval)
```

### 4. Select and export

A popup shows your conversations with checkboxes. Pick what you want → click **Export Selected** → ZIP downloads automatically.

---

## Output

```
chatgpt-export/   (or perplexity-export/)
├── json/         Raw API JSON
├── markdown/     Readable text with links
├── html/         Nice viewer with sidebar + code highlighting
├── files/        Downloaded images, PDFs, code outputs (ChatGPT only)
└── *.zip         Everything zipped
```

Open any `.html` file in a browser to browse your conversations.

---

## Terminal (no browser console)

If you prefer not to use the browser console:

```bash
cd chatgpt_chats_extractor
node export-chatgpt.mjs          # for ChatGPT
node export-perplexity.mjs       # for Perplexity
```

Opens a web UI where you paste your token/cookie. Exports everything (no selection UI). May be blocked by Cloudflare.

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `Unexpected token 'export'` | Chrome blocks pasting. Type `allow pasting` in the console first, then paste the one-liner |
| `ERR_CONNECTION_REFUSED` | Make sure `python3 serve.py` is running |
| `Failed to fetch` / CORS error | Make sure you're using `http://127.0.0.1:8425` (not `localhost`) |
| 403 error (terminal mode) | Cloudflare blocking — use the browser console method instead |
| Token/cookie expired | Re-login and try again |
| Python not found | `xcode-select --install` (macOS) or `sudo apt install python3` (Linux) |
