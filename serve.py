#!/usr/bin/env python3
"""
Serve the console exporter scripts with CORS headers so you can load them
with a one-liner in the browser console.

Usage:
  python3 serve.py

Then in your browser console (on chatgpt.com or perplexity.ai):
  fetch("http://127.0.0.1:8425/export-chatgpt-console.js").then(r=>r.text()).then(eval)

Or for Perplexity:
  fetch("http://127.0.0.1:8425/export-perplexity-console.js").then(r=>r.text()).then(eval)
"""

from http.server import HTTPServer, SimpleHTTPRequestHandler
import os
import sys

PORT = 8425
DIR = os.path.dirname(os.path.abspath(__file__))


class CORSHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DIR, **kwargs)

    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "*")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(200)
        self.end_headers()

    def log_message(self, format, *args):
        # Quiet mode
        pass


if __name__ == "__main__":
    server = HTTPServer(("127.0.0.1", PORT), CORSHandler)
    print(f"\n  ┌────────────────────────────────────────────────────────┐")
    print(f"  │  Exporter Server running                             │")
    print(f"  │                                                      │")
    print(f"  │  1. Go to chatgpt.com or perplexity.ai and log in    │")
    print(f"  │  2. Press F12 → Console tab                          │")
    print(f"  │     If you see 'Type allow pasting', type it first   │")
    print(f"  │  3. Paste the one-liner below:                       │")
    print(f"  │                                                      │")
    print(f"  │  For ChatGPT:                                        │")
    print(f"  │  fetch(\"http://127.0.0.1:{PORT}/export-chatgpt-console.js\").then(r=>r.text()).then(eval)  │")
    print(f"  │                                                      │")
    print(f"  │  For Perplexity:                                     │")
    print(f"  │  fetch(\"http://127.0.0.1:{PORT}/export-perplexity-console.js\").then(r=>r.text()).then(eval) │")
    print(f"  │                                                      │")
    print(f"  │  Press Ctrl+C to stop                                │")
    print(f"  └────────────────────────────────────────────────────────┘\n")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n  Server stopped.\n")
        server.shutdown()
