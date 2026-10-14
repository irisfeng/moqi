#!/usr/bin/env python3
import json
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from rapidocr_onnxruntime import RapidOCR

engine = RapidOCR()
MAX_BODY = 30 * 1024 * 1024


class H(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.0"

    def send_json(self, code, obj):
        d = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(d)))
        self.end_headers()
        self.wfile.write(d)

    def do_GET(self):
        if urllib.parse.urlparse(self.path).path == "/healthz":
            self.send_json(200, {"ok": True, "service": "pm-ocr"})
            return
        self.send_json(404, {"error": "not found"})

    def do_POST(self):
        if urllib.parse.urlparse(self.path).path != "/ocr":
            self.send_json(404, {"error": "not found"})
            return
        n = int(self.headers.get("Content-Length", 0) or 0)
        if n > MAX_BODY:
            self.send_json(413, {"error": "image too large"})
            return
        data = self.rfile.read(n)
        if not data:
            self.send_json(400, {"error": "empty body"})
            return
        t0 = time.time()
        try:
            result, _elapse = engine(data)
        except Exception as e:
            self.send_json(422, {"error": "ocr failed: " + str(e)[:180]})
            return
        lines = []
        confs = []
        if result:
            for row in result:
                if row and len(row) >= 3 and row[1]:
                    lines.append(str(row[1]))
                    try:
                        confs.append(float(row[2]))
                    except (TypeError, ValueError):
                        pass
        conf = round(sum(confs) / len(confs), 4) if confs else 0.0
        self.send_json(200, {
            "text": "\n".join(lines),
            "confidence": conf,
            "lines": len(lines),
            "elapsed_ms": int((time.time() - t0) * 1000),
        })

    def log_message(self, fmt, *args):
        pass


if __name__ == "__main__":
    srv = ThreadingHTTPServer(("0.0.0.0", 8092), H)
    srv.daemon_threads = True
    print("pm-ocr listening :8092", flush=True)
    srv.serve_forever()
