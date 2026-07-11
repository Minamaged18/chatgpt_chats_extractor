# ChatGPT & Perplexity Conversation Exporters

Export all your conversations from ChatGPT and Perplexity as **JSON + Markdown + HTML + ZIP**.

| Feature | ChatGPT | Perplexity |
|---------|:-------:|:----------:|
| Export chats to JSON | ✅ | ✅ |
| Markdown output | ✅ | ✅ |
| HTML viewer with sidebar | ✅ | ✅ |
| Downloaded files (images, PDFs, code outputs) | ✅ | ❌ |
| Source citations | ❌ | ✅ |
| Select which chats to export | ✅ | ✅ |

---

## ChatGPT

### Browser Console (no server needed)

1. Go to [chatgpt.com](https://chatgpt.com) and **log in**
2. Press **F12** → click **Console** tab
3. Copy the entire [`export-chatgpt-console.js`](https://raw.githubusercontent.com/Minamaged18/chatgpt_chats_extractor/main/export-chatgpt-console.js) file, **paste it in the console**, press **Enter**
4. Wait for the list to load → a popup appears with checkboxes
5. Pick which conversations you want, click **Export Selected**
6. A ZIP file downloads automatically with `chatgpt-export.zip`

### Terminal (Node.js or Python)

```bash
git clone https://github.com/Minamaged18/chatgpt_chats_extractor.git
cd chatgpt_chats_extractor
node export-chatgpt.mjs
```

A browser opens at `http://127.0.0.1:8423` — paste your session token from `chatgpt.com/api/auth/session` → exports everything to `~/Desktop/chatgpt-export/`.

**Note:** The terminal version may get blocked by Cloudflare. Use the browser console instead if that happens.

---

## Perplexity

### Browser Console (no server needed)

1. Go to [perplexity.ai](https://www.perplexity.ai) and **log in**
2. Press **F12** → click **Console** tab
3. Copy the entire [`export-perplexity-console.js`](https://raw.githubusercontent.com/Minamaged18/chatgpt_chats_extractor/main/export-perplexity-console.js) file, **paste it in the console**, press **Enter**
4. Wait for the list to load → a popup appears with checkboxes
5. Pick which threads you want, click **Export Selected**
6. A ZIP file downloads automatically with `perplexity-export.zip`

### Terminal (Node.js or Python)

```bash
git clone https://github.com/Minamaged18/chatgpt_chats_extractor.git
cd chatgpt_chats_extractor
node export-perplexity.mjs
```

A browser opens at `http://127.0.0.1:8424` — paste your `__Secure-next-auth.session-token` cookie → exports everything to `~/Desktop/perplexity-export/`.

**Getting the cookie:** F12 → Application → Cookies → perplexity.ai → find `__Secure-next-auth.session-token` → copy its value.

**Note:** The terminal version may get blocked by Cloudflare. Use the browser console instead.

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

## Troubleshooting

| Problem | Fix |
|---------|-----|
| 403 error (terminal) | Use the browser console version instead |
| Token/cookie expired | Re-copy and try again |
| HTML pages look unstyled | Internet access needed once for CDN styling |
| Python not found | `xcode-select --install` (macOS) or `sudo apt install python3` (Linux) |
