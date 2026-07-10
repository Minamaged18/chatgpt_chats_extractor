# ChatGPT & Perplexity Conversation Exporters

Export all your conversations from ChatGPT and Perplexity as **JSON + Markdown + HTML + ZIP**.

| Feature | ChatGPT | Perplexity |
|---------|:-------:|:----------:|
| Export chats to JSON | ✅ | ✅ |
| Markdown output | ✅ | ✅ |
| HTML viewer with sidebar | ✅ | ✅ |
| Downloaded files (images, PDFs, code outputs) | ✅ | ❌ |
| Source citations | ❌ | ✅ |

---

## ChatGPT

### Easiest way — Browser Console

1. Go to [chatgpt.com](https://chatgpt.com) and log in
2. Open the console: **F12 → Console**
3. Paste [`export-chatgpt-console.js`](https://raw.githubusercontent.com/ocombe/AI-Conversation-Exporters/main/export-chatgpt-console.js) and press Enter
4. Select the conversations you want (or Select All) → click **Export Selected**
5. Wait for the ZIP to download

### Terminal

```bash
curl -sL https://raw.githubusercontent.com/ocombe/AI-Conversation-Exporters/main/export-chatgpt.sh | bash
```

Opens a web UI → paste your session token → done. Requires Node.js 18+ or Python 3.

---

## Perplexity

### Easiest way — Browser Console

1. Go to [perplexity.ai](https://www.perplexity.ai) and log in
2. Open the console: **F12 → Console**
3. Paste [`export-perplexity-console.js`](https://raw.githubusercontent.com/ocombe/AI-Conversation-Exporters/main/export-perplexity-console.js) and press Enter
4. Select the threads you want (or Select All) → click **Export Selected**
5. Wait for the ZIP to download

### Terminal

```bash
curl -sL https://raw.githubusercontent.com/ocombe/AI-Conversation-Exporters/main/export-perplexity.sh | bash
```

Opens a web UI → paste your `__Secure-next-auth.session-token` cookie → done. Requires Node.js 18+ or Python 3.

**Getting the cookie:** F12 → Application → Cookies → perplexity.ai → copy `__Secure-next-auth.session-token`.

**Note:** The terminal version may get blocked by Cloudflare. Use the browser console if that happens.

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
| Token expired | Re-copy the session token/cookie |
| Empty pages | You're offline — HTML needs CDN access once for styling |
| Python not found | `xcode-select --install` (macOS) or `sudo apt install python3` (Linux) |
