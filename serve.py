#!/usr/bin/env python3
"""Serves web/ at http://127.0.0.1:8000 (or the port given) for local testing.

Unlike plain `python3 -m http.server`, it tells the browser to re-check every file on each load. Otherwise
Chrome keeps old copies for a while after an edit and can run a new index.html with an old main.js.
"""
import functools
import http.server
import pathlib
import sys


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-cache')
        super().end_headers()


port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
web = pathlib.Path(__file__).resolve().parent / 'web'
server = http.server.ThreadingHTTPServer(('127.0.0.1', port), functools.partial(Handler, directory=web))
print(f'Serving {web} at http://127.0.0.1:{port}')
try:
    server.serve_forever()
except KeyboardInterrupt:
    pass
