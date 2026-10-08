import http.server
import socketserver
import json
import base64
import csv
import io
import math
import os

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
SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets'


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


def sheet_prefix():
    escaped_name = SHEET_NAME.replace("'", "''")
    return f"'{escaped_name}'!"


def sheet_range():
    return f'{sheet_prefix()}A:ZZ'


def get_sheets_service():
    credentials_path = os.environ.get('GOOGLE_APPLICATION_CREDENTIALS')
    if not credentials_path:
        raise RuntimeError('Set GOOGLE_APPLICATION_CREDENTIALS to the service-account key path')
    try:
        credentials = service_account.Credentials.from_service_account_file(
            credentials_path,
            scopes=[SHEETS_SCOPE],
        )
    except (GoogleAuthError, OSError, ValueError) as exc:
        raise RuntimeError('Could not load the Google service-account credentials') from exc
    return build('sheets', 'v4', credentials=credentials, cache_discovery=False)


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
            elif index >= 3:
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


def save_pricing_rows(rows):
    service = get_sheets_service()
    old_values = (
        service.spreadsheets()
        .values()
        .get(
            spreadsheetId=SPREADSHEET_ID,
            range=sheet_range(),
            valueRenderOption='UNFORMATTED_VALUE',
        )
        .execute()
        .get('values', [])
    )
    service.spreadsheets().values().update(
        spreadsheetId=SPREADSHEET_ID,
        range=f'{sheet_prefix()}A1',
        valueInputOption='RAW',
        body={'values': rows},
    ).execute()

    old_row_count = len(old_values)
    new_row_count = len(rows)
    if old_row_count > new_row_count:
        service.spreadsheets().values().clear(
            spreadsheetId=SPREADSHEET_ID,
            range=f'{sheet_prefix()}A{new_row_count + 1}:ZZ{old_row_count}',
            body={},
        ).execute()

    old_column_count = max((len(row) for row in old_values), default=0)
    new_column_count = max((len(row) for row in rows), default=0)
    if old_column_count > new_column_count and new_row_count:
        service.spreadsheets().values().clear(
            spreadsheetId=SPREADSHEET_ID,
            range=(
                f'{sheet_prefix()}{column_name(new_column_count + 1)}1:'
                f'{column_name(old_column_count)}{max(old_row_count, new_row_count)}'
            ),
            body={},
        ).execute()


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

    def serve_pricing_csv(self):
        try:
            body = get_pricing_csv().encode('utf-8')
        except (GoogleAuthError, HttpError, httplib2.HttpLib2Error, OSError, RuntimeError, ValueError) as exc:
            self.log_error('Could not read pricing data from Google Sheets: %s', exc)
            self.send_error(502, 'Unable to read pricing data from Google Sheets')
            return
        self.send_response(200)
        self.send_header('Content-Type', 'text/csv; charset=utf-8')
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
                if not isinstance(json_text, str) or not isinstance(json.loads(json_text), dict):
                    raise ValueError('Request must include a JSON object as text')
            except (
                UnicodeDecodeError,
                json.JSONDecodeError,
                ValueError,
            ) as exc:
                self.send_error(400, str(exc))
                return

            try:
                save_pricing_rows(rows)
            except (
                GoogleAuthError,
                HttpError,
                httplib2.HttpLib2Error,
                OSError,
                RuntimeError,
            ) as exc:
                self.log_error('Could not save pricing data to Google Sheets: %s', exc)
                self.send_error(502, 'Unable to save pricing data to Google Sheets')
                return
            try:
                with open('data/data.json', 'w', encoding='utf-8') as f:
                    f.write(json_text)
            except OSError as exc:
                self.log_error('Could not save local application data: %s', exc)
                self.send_error(500, 'Pricing saved, but local application data could not be saved')
                return
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b'Saved')
        else:
            self.send_error(404)

if __name__ == '__main__':
    ensure_local_data_files()
    socketserver.TCPServer(('', 3811), H).serve_forever()
