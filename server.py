import http.server
import socketserver
import json
import base64
import csv
import glob
import io
import math
import os
import sys
import threading

import google_auth_httplib2
import httplib2
from google.auth.exceptions import GoogleAuthError
from google.oauth2 import service_account
from googleapiclient.discovery import build
from googleapiclient.errors import HttpError


SPREADSHEET_ID = os.environ.get(
    'GOOGLE_SPREADSHEET_ID',
    '19ByaGb1-X7Z_6_Dwhba1Efn78EQ2Ue9n9uXdAIHCk-U',
)
SHEET_NAME = os.environ.get('GOOGLE_SHEET_NAME', 'Sheet1')
CARDS_SHEET_NAME = os.environ.get('GOOGLE_CARDS_SHEET_NAME', 'cards')
LOGS_SHEET_NAME = os.environ.get('GOOGLE_LOGS_SHEET_NAME', 'logs')
SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets'
GOOGLE_TIMEOUT = float(os.environ.get('GOOGLE_TIMEOUT', '10'))  # seconds per Google call
_SAVE_LOCK = threading.Lock()  # guards saves, pushes of unsynced data and refreshes of data/
_SAVE_GEN = 0  # bumped on every save, so a load can tell its Google read may be stale
UNSYNCED = 'data/.unsynced'  # present while data/ holds changes Google Sheets has not got


def ensure_local_data_files():
    os.makedirs('data', exist_ok=True)
    for path, initial_contents in (
        ('data/data.json', '{"log": [], "projects": []}\n'),
        ('data/pricing_data.csv', ''),
    ):
        try:
            with open(path, 'x', encoding='utf-8') as data_file:
                data_file.write(initial_contents)
        except FileExistsError:
            continue


def write_local(path, text):
    os.makedirs(os.path.dirname(path) or '.', exist_ok=True)
    tmp = f'{path}.{threading.get_ident()}.tmp'  # per thread: requests run concurrently
    with open(tmp, 'w', encoding='utf-8', newline='') as f:
        f.write(text)
    os.replace(tmp, path)


def mirror_local(path, text, gen):
    """Keep data/ in step with what was just read from Google (best effort). Skipped when data/
    has unsynced changes, or a save started since the read (gen), so newer local work is kept."""
    if not _SAVE_LOCK.acquire(blocking=False):
        return
    try:
        if gen != _SAVE_GEN or os.path.exists(UNSYNCED):
            return
        try:
            with open(path, 'r', encoding='utf-8', newline='') as f:
                if f.read() == text:
                    return
        except OSError:
            pass
        write_local(path, text)
    except OSError as exc:
        print(f'Could not update local copy {path}: {exc}', file=sys.stderr)
    finally:
        _SAVE_LOCK.release()


def push_unsynced():
    """Send data/ to Google if an earlier save did not reach it. Returns the error, or ''."""
    global _SAVE_GEN
    if not os.path.exists(UNSYNCED):
        return ''
    with _SAVE_LOCK:
        if not os.path.exists(UNSYNCED):  # another request pushed it meanwhile
            return ''
        _SAVE_GEN += 1
        try:
            with open('data/pricing_data.csv', 'r', encoding='utf-8', newline='') as f:
                rows = parse_pricing_csv(f.read())
            save_pricing_rows(rows)
            save_app_data(read_local_app_data())
            os.remove(UNSYNCED)
        except (GoogleAuthError, HttpError, httplib2.HttpLib2Error, OSError, RuntimeError, ValueError) as exc:
            print(f'Could not push unsynced local changes to Google Sheets: {exc}', file=sys.stderr)
            return f'Local changes not yet synced to Google Sheets: {exc}'
    print('Pushed unsynced local changes to Google Sheets', file=sys.stderr)
    return ''


def rows_to_csv_text(rows):
    output = io.StringIO(newline='')
    csv.writer(output, lineterminator='\n').writerows(rows)
    return output.getvalue()


def header_text(value):
    return ' '.join(str(value).split())[:200].encode('ascii', 'replace').decode('ascii')


def sheet_prefix(name=None):
    escaped_name = (name or SHEET_NAME).replace("'", "''")
    return f"'{escaped_name}'!"


def sheet_range():
    return f'{sheet_prefix()}A:ZZ'


def get_sheets_service():
    credentials_path = os.environ.get('GOOGLE_APPLICATION_CREDENTIALS', 'secrets/*.json')
    matching_paths = sorted(glob.glob(credentials_path))
    if not matching_paths:
        raise RuntimeError(
            'No service-account key found at GOOGLE_APPLICATION_CREDENTIALS '
            f'({credentials_path}); add a JSON key under secrets/ or set the variable'
        )
    credentials_path = matching_paths[0]
    try:
        credentials = service_account.Credentials.from_service_account_file(
            credentials_path,
            scopes=[SHEETS_SCOPE],
        )
    except (GoogleAuthError, OSError, ValueError) as exc:
        raise RuntimeError('Could not load the Google service-account credentials') from exc
    http = google_auth_httplib2.AuthorizedHttp(credentials, http=httplib2.Http(timeout=GOOGLE_TIMEOUT))
    return build('sheets', 'v4', http=http, cache_discovery=False)


def get_pricing_csv():
    response = (
        get_sheets_service()
        .spreadsheets()
        .values()
        .get(
            spreadsheetId=SPREADSHEET_ID,
            range=sheet_range(),
            valueRenderOption='UNFORMATTED_VALUE',
        )
        .execute()
    )
    values = response.get('values', [])
    if not values:
        raise ValueError('The configured Google Sheet is empty')

    headers = [str(value) for value in values[0]]
    if headers[:3] != ['Service', 'Technology', 'Unit'] or len(headers) < 4:
        raise ValueError('The Google Sheet must start with Service, Technology, Unit, and at least one price tier')

    output = io.StringIO(newline='')
    writer = csv.writer(output, lineterminator='\n')
    writer.writerow(headers)
    for row in values[1:]:
        if not any(str(value).strip() for value in row):
            continue
        if len(row) > len(headers):
            raise ValueError('The Google Sheet contains a data value beyond its header columns')
        writer.writerow(row + [''] * (len(headers) - len(row)))
    return output.getvalue()


def load_pricing_csv():
    """(text, source, error): Google when reachable, otherwise data/pricing_data.csv."""
    gen = _SAVE_GEN
    try:
        pending = push_unsynced()
        if pending:
            raise RuntimeError(pending)
        text = get_pricing_csv()
    except (GoogleAuthError, HttpError, httplib2.HttpLib2Error, OSError, RuntimeError, ValueError) as exc:
        try:
            with open('data/pricing_data.csv', 'r', encoding='utf-8', newline='') as f:
                local = f.read()
        except OSError:
            local = ''
        if not local.strip():
            raise
        print(f'Google Sheets unavailable, serving data/pricing_data.csv: {exc}', file=sys.stderr)
        return local, 'local', str(exc)
    mirror_local('data/pricing_data.csv', text, gen)
    return text, 'google', ''


def parse_pricing_csv(csv_text):
    rows = list(csv.reader(io.StringIO(csv_text)))
    if not rows:
        raise ValueError('CSV must include a header row')

    headers = rows[0]
    if headers[:3] != ['Service', 'Technology', 'Unit'] or len(headers) < 4:
        raise ValueError('CSV must start with Service, Technology, Unit, and at least one price tier')
    rate_card_index = next(
        (index for index, header in enumerate(headers) if header.lower() == 'rate_card'),
        None,
    )
    remarks_index = next(
        (index for index, header in enumerate(headers) if header.lower() == 'remarks'),
        None,
    )
    result = [headers]
    for line_number, row in enumerate(rows[1:], start=2):
        if not any(value.strip() for value in row):
            continue
        if len(row) > len(headers):
            raise ValueError(f'CSV row {line_number} has more values than the header')
        row += [''] * (len(headers) - len(row))
        converted = []
        for index, value in enumerate(row):
            if index == rate_card_index:
                normalized = value.strip().lower()
                if normalized not in ('true', 'false'):
                    raise ValueError(f'CSV row {line_number} must use true or false for Rate_card')
                converted.append(normalized == 'true')
            elif index >= 3 and index != remarks_index:
                if not value.strip():
                    converted.append('')
                else:
                    try:
                        price = float(value)
                    except ValueError as exc:
                        raise ValueError(f'CSV row {line_number} has a non-numeric price') from exc
                    if not math.isfinite(price):
                        raise ValueError(f'CSV row {line_number} has a non-finite price')
                    converted.append(price)
            else:
                converted.append(value)
        result.append(converted)
    return result


def column_name(number):
    name = ''
    while number:
        number, remainder = divmod(number - 1, 26)
        name = chr(65 + remainder) + name
    return name


def write_tab(service, tab, rows):
    prefix = sheet_prefix(tab)
    old_values = (
        service.spreadsheets()
        .values()
        .get(
            spreadsheetId=SPREADSHEET_ID,
            range=f'{prefix}A:ZZ',
            valueRenderOption='UNFORMATTED_VALUE',
        )
        .execute()
        .get('values', [])
    )
    service.spreadsheets().values().update(
        spreadsheetId=SPREADSHEET_ID,
        range=f'{prefix}A1',
        valueInputOption='RAW',
        body={'values': rows},
    ).execute()

    old_row_count = len(old_values)
    new_row_count = len(rows)
    if old_row_count > new_row_count:
        service.spreadsheets().values().clear(
            spreadsheetId=SPREADSHEET_ID,
            range=f'{prefix}A{new_row_count + 1}:ZZ{old_row_count}',
            body={},
        ).execute()

    old_column_count = max((len(row) for row in old_values), default=0)
    new_column_count = max((len(row) for row in rows), default=0)
    if old_column_count > new_column_count and new_row_count:
        service.spreadsheets().values().clear(
            spreadsheetId=SPREADSHEET_ID,
            range=(
                f'{prefix}{column_name(new_column_count + 1)}1:'
                f'{column_name(old_column_count)}{max(old_row_count, new_row_count)}'
            ),
            body={},
        ).execute()


def save_pricing_rows(rows):
    write_tab(get_sheets_service(), SHEET_NAME, rows)


# ---------- cards and logs tabs ----------
CARD_HEADERS = ['card_id', 'card_order', 'name', 'desc', 'tier', 'samples', 'genome_mb', 'coverage',
                'item_order', 'service', 'tech', 'mode', 'n']
LOG_HEADERS = ['time', 'action', 'service', 'field', 'from', 'to']
_TAB_CACHE = {}


def resolve_tab(service, wanted):
    """Find the real tab title, ignoring case (the Sheets API is case-sensitive)."""
    if wanted in _TAB_CACHE:
        return _TAB_CACHE[wanted]
    meta = service.spreadsheets().get(
        spreadsheetId=SPREADSHEET_ID, fields='sheets.properties.title').execute()
    titles = [sheet['properties']['title'] for sheet in meta.get('sheets', [])]
    match = next((t for t in titles if t.lower() == wanted.lower()), None)
    if match:
        _TAB_CACHE[wanted] = match
    return match


def cell(value):
    return '' if value is None else value


def num_or_none(value):
    if value is None or (isinstance(value, str) and not value.strip()):
        return None
    if isinstance(value, (int, float)):
        return value
    try:
        number = float(value)
    except ValueError:
        return None
    return int(number) if number.is_integer() else number


def cards_to_rows(projects):
    rows = [CARD_HEADERS]
    for order, card in enumerate(projects, start=1):
        base = [cell(card.get('id')), order, cell(card.get('name')), cell(card.get('desc')), cell(card.get('tier')),
                cell(card.get('samples')), cell(card.get('genome')), cell(card.get('cov'))]
        items = card.get('items') or []
        if not items:
            rows.append(base + [''] * 5)
        for item_order, item in enumerate(items, start=1):
            rows.append(base + [item_order, cell(item.get('name')), cell(item.get('tech')),
                                cell(item.get('mode')), cell(item.get('n'))])
    return rows


def rows_to_cards(values):
    if not values:
        return []
    index = {str(h).strip().lower(): i for i, h in enumerate(values[0])}
    if 'card_id' not in index:
        raise ValueError('The cards tab needs a card_id column')

    def col(row, name):
        i = index.get(name)
        return row[i] if i is not None and i < len(row) else ''

    cards = {}
    for row in values[1:]:
        if not any(str(v).strip() for v in row):
            continue
        card_id = num_or_none(col(row, 'card_id'))
        if card_id is None:
            continue
        card_id = int(card_id)
        card = cards.get(card_id)
        if card is None:
            order = num_or_none(col(row, 'card_order'))
            card = cards[card_id] = {
                'id': card_id, 'name': str(col(row, 'name')), 'desc': str(col(row, 'desc')),
                'tier': str(col(row, 'tier')), 'samples': num_or_none(col(row, 'samples')),
                'genome': num_or_none(col(row, 'genome_mb')), 'cov': num_or_none(col(row, 'coverage')),
                'items': [], '_order': card_id if order is None else order,
            }
        service_name = str(col(row, 'service')).strip()
        if service_name:
            n = num_or_none(col(row, 'n'))
            item_order = num_or_none(col(row, 'item_order'))
            card['items'].append((len(card['items']) if item_order is None else item_order, {
                'name': service_name, 'tech': str(col(row, 'tech')),
                'mode': str(col(row, 'mode')) or 'fixed', 'n': 1 if n is None else n}))
    result = []
    for card in sorted(cards.values(), key=lambda c: c['_order']):
        card['items'] = [item for _, item in sorted(card['items'], key=lambda x: x[0])]
        del card['_order']
        result.append(card)
    return result


def log_to_rows(log):
    rows = [LOG_HEADERS]
    for entry in log:
        rows.append([cell(entry.get('t')), cell(entry.get('action')), cell(entry.get('service')),
                     cell(entry.get('field')), cell(entry.get('from')), cell(entry.get('to'))])
    return rows


def rows_to_log(values):
    if not values:
        return []
    index = {str(h).strip().lower(): i for i, h in enumerate(values[0])}
    keys = (('t', 'time'), ('action', 'action'), ('service', 'service'),
            ('field', 'field'), ('from', 'from'), ('to', 'to'))
    log = []
    for row in values[1:]:
        if not any(str(v).strip() for v in row):
            continue
        log.append({key: (str(row[index[name]]) if name in index and index[name] < len(row) else '')
                    for key, name in keys})
    return log


def read_local_app_data():
    try:
        with open('data/data.json', 'r', encoding='utf-8') as f:
            data = json.load(f)
        if isinstance(data, dict):
            return data
    except (OSError, ValueError):
        pass
    return {'log': [], 'projects': []}


def get_app_data():  # returns (data, source)
    """Cards and log from the Google Sheet tabs. A tab with no header yet (never saved) or an
    unreachable Sheet falls back to the local data/data.json copy."""
    gen = _SAVE_GEN
    data = read_local_app_data()
    source = 'local'
    try:
        pending = push_unsynced()
        if pending:
            raise RuntimeError(pending)
        service = get_sheets_service()
        tabs = {key: resolve_tab(service, name)
                for key, name in (('cards', CARDS_SHEET_NAME), ('logs', LOGS_SHEET_NAME))}
        found = {key: tab for key, tab in tabs.items() if tab}
        values = {}
        if found:
            response = service.spreadsheets().values().batchGet(
                spreadsheetId=SPREADSHEET_ID,
                ranges=[f'{sheet_prefix(tab)}A:ZZ' for tab in found.values()],
                valueRenderOption='UNFORMATTED_VALUE',
            ).execute()
            for key, value_range in zip(found, response.get('valueRanges', [])):
                values[key] = value_range.get('values', [])
        if values.get('cards'):
            data['projects'] = rows_to_cards(values['cards'])
        if values.get('logs'):
            data['log'] = rows_to_log(values['logs'])
        source = 'google'
        data.setdefault('projects', [])
        data.setdefault('log', [])
        mirror_local('data/data.json', json.dumps(data), gen)
    except (GoogleAuthError, HttpError, httplib2.HttpLib2Error, OSError, RuntimeError, ValueError) as exc:
        print(f'Could not read cards/logs from Google Sheets, using local copy: {exc}', file=sys.stderr)
    data.setdefault('projects', [])
    data.setdefault('log', [])
    return data, source


def save_app_data(data):
    service = get_sheets_service()
    for key, name, rows in (('cards', CARDS_SHEET_NAME, cards_to_rows(data.get('projects', []))),
                            ('logs', LOGS_SHEET_NAME, log_to_rows(data.get('log', [])))):
        tab = resolve_tab(service, name)
        if not tab:
            raise RuntimeError(f'Tab "{name}" not found in the spreadsheet')
        write_tab(service, tab, rows)


def check_auth(auth_header):
    if not auth_header or not auth_header.startswith('Basic '):
        return False
    try:
        decoded = base64.b64decode(auth_header[6:]).decode('utf-8')
        user, pwd = decoded.split(':', 1)
        if not os.path.exists('secrets/secrets.csv'):
            return False
        with open('secrets/secrets.csv', 'r', encoding='utf-8') as f:
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
}

class H(http.server.SimpleHTTPRequestHandler):
    def serve_public(self, name):
        if name == 'data/pricing_data.csv':
            return self.serve_pricing_csv()
        if name not in PUBLIC_FILES or not os.path.isfile(name):
            self.send_error(404)
            return
        if name == 'data/data.json':  # never expose the edit log publicly
            return self.serve_app_data(include_log=False)
        with open(name, 'rb') as f:
            body = f.read()
        self.send_response(200)
        self.send_header('Content-Type', PUBLIC_FILES[name])
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(body)

    def serve_app_data(self, include_log):
        data, source = get_app_data()
        if not include_log:
            data['log'] = []
        body = json.dumps(data).encode('utf-8')
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('X-Data-Source', source)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(body)

    def serve_pricing_csv(self):
        try:
            text, source, error = load_pricing_csv()
            body = text.encode('utf-8')
        except (GoogleAuthError, HttpError, httplib2.HttpLib2Error, OSError, RuntimeError, ValueError) as exc:
            message = f'Could not read pricing data from Google Sheets: {exc}'
            self.log_error('%s', message)
            body = message.encode('utf-8')
            self.send_response(502)
            self.send_header('Content-Type', 'text/plain; charset=utf-8')
            self.send_header('X-Google-Sheets-URL', f'https://docs.google.com/spreadsheets/d/{SPREADSHEET_ID}/edit')
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()
            self.wfile.write(body)
            return
        self.send_response(200)
        self.send_header('Content-Type', 'text/csv; charset=utf-8')
        self.send_header('X-Data-Source', source)
        if error:
            self.send_header('X-Data-Error', header_text(error))
        self.send_header('X-Google-Sheets-URL', f'https://docs.google.com/spreadsheets/d/{SPREADSHEET_ID}/edit')
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
        if path == '/data/pricing_data.csv':
            return self.serve_pricing_csv()
        if path == '/data/data.json':
            return self.serve_app_data(include_log=True)
        super().do_GET()

    def do_POST(self):
        if not self.check_authorization():
            return
        if self.path == '/save':
            try:
                length = int(self.headers.get('content-length', 0))
                req = json.loads(self.rfile.read(length).decode('utf-8'))
                if not isinstance(req, dict) or not isinstance(req.get('csv'), str):
                    raise ValueError('Request must include CSV text')
                rows = parse_pricing_csv(req['csv'])
                json_text = req.get('json', '{}')
                app_data = json.loads(json_text) if isinstance(json_text, str) else None
                if not isinstance(app_data, dict):
                    raise ValueError('Request must include a JSON object as text')
                for key in ('projects', 'log'):
                    items = app_data.get(key, [])
                    if not isinstance(items, list) or not all(isinstance(i, dict) for i in items):
                        raise ValueError(f'"{key}" must be a list of objects')
            except (
                UnicodeDecodeError,
                json.JSONDecodeError,
                ValueError,
            ) as exc:
                self.send_error(400, str(exc))
                return

            global _SAVE_GEN
            with _SAVE_LOCK:  # one save at a time
                _SAVE_GEN += 1
                local_error = google_error = None
                try:  # data/ always gets a copy, so work is never lost when Google is down
                    write_local('data/pricing_data.csv', rows_to_csv_text(rows))
                    write_local('data/data.json', json_text)
                    write_local(UNSYNCED, '')  # cleared once Google has the same data
                except OSError as exc:
                    local_error = str(exc)
                    self.log_error('Could not save to data/: %s', exc)
                try:
                    save_pricing_rows(rows)
                    save_app_data(app_data)
                    if os.path.exists(UNSYNCED):
                        os.remove(UNSYNCED)
                except (GoogleAuthError, HttpError, httplib2.HttpLib2Error, OSError, RuntimeError) as exc:
                    google_error = str(exc)
                    self.log_error('Could not save to Google Sheets: %s', exc)
            if local_error and google_error:
                self.send_error(500, 'Could not save to Google Sheets or to data/')
                return
            if not google_error and not local_error:
                saved_to, message = 'both', 'Saved'
            elif local_error:
                saved_to, message = 'google', 'Saved to Google Sheets only; data/ could not be written'
            else:
                saved_to = 'local'
                message = ('Saved to data/ only; it will be sent to Google Sheets when reachable. Google error: '
                           + header_text(google_error))
            body = message.encode('utf-8')
            self.send_response(200)
            self.send_header('X-Saved-To', saved_to)
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        else:
            self.send_error(404)

if __name__ == '__main__':
    ensure_local_data_files()
    socketserver.ThreadingTCPServer.daemon_threads = True
    socketserver.ThreadingTCPServer(('', 3811), H).serve_forever()
