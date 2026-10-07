import http.server
import socketserver
import json
import base64
import csv
import os

def check_auth(auth_header):
    if not auth_header or not auth_header.startswith('Basic '):
        return False
    try:
        decoded = base64.b64decode(auth_header[6:]).decode('utf-8')
        user, pwd = decoded.split(':', 1)
        if not os.path.exists('secrets.csv'):
            return False
        with open('secrets.csv', 'r', encoding='utf-8') as f:
            for row in csv.reader(f):
                if len(row) >= 2 and row[0] == user and row[1] == pwd:
                    return True
        return False
    except Exception:
        return False

PUBLIC_FILES = {
    'index.html': 'text/html; charset=utf-8',
    'styles.css': 'text/css; charset=utf-8',
    'app.js': 'text/javascript; charset=utf-8',
    'data/data.json': 'application/json',
    'data/pricing_data.csv': 'text/csv; charset=utf-8',
}

class H(http.server.SimpleHTTPRequestHandler):
    def serve_public(self, name):
        if name not in PUBLIC_FILES or not os.path.isfile(name):
            self.send_error(404)
            return
        with open(name, 'rb') as f:
            body = f.read()
        if name == 'data/data.json':  # never expose the edit log publicly
            try:
                d = json.loads(body)
                d['log'] = []
                body = json.dumps(d).encode('utf-8')
            except ValueError:
                body = b'{}'
        self.send_response(200)
        self.send_header('Content-Type', PUBLIC_FILES[name])
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(body)

    def check_authorization(self):
        if check_auth(self.headers.get('Authorization')):
            return True
        self.send_response(401)
        self.send_header('WWW-Authenticate', 'Basic realm="Pricing"')
        self.end_headers()
        return False

    def do_GET(self):
        path = self.path.split('?', 1)[0]
        if path == '/view':
            self.send_response(301)
            self.send_header('Location', '/view/')
            self.end_headers()
            return
        if path.startswith('/view/'):
            return self.serve_public(path[6:] or 'index.html')
        if not self.check_authorization():
            return
        super().do_GET()

    def do_POST(self):
        if not self.check_authorization():
            return
        if self.path == '/save':
            length = int(self.headers.get('content-length', 0))
            req = json.loads(self.rfile.read(length).decode('utf-8'))
            with open('data/pricing_data.csv', 'w', encoding='utf-8') as f:
                f.write(req.get('csv', ''))
            with open('data/data.json', 'w', encoding='utf-8') as f:
                f.write(req.get('json', '{}'))
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b'Saved')
        else:
            self.send_error(404)

socketserver.TCPServer(('', 3811), H).serve_forever()
