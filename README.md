# Pricing

## Setup and run

Requires Python 3. From the project directory, install dependencies, configure
Google Sheets access, and start the server:

```sh
python3 -m pip install -r requirements.txt
export GOOGLE_APPLICATION_CREDENTIALS="/absolute/path/to/service-account-key.json"
python3 server.py
```

Replace the example credentials path with the actual absolute path to the
service-account JSON key. The key should be stored securely and kept out of
source control.

Open `http://localhost:3811/`. The editable page prompts for credentials from
`secrets.csv`, which should contain one `username,password` pair per line.
Create this file in the project directory.

## Google Sheets

Pricing data is read from and saved to Google Sheets; the server does not use
`data/pricing_data.csv` as its live data source. The default spreadsheet ID is
`19ByaGb1-X7Z_6_Dwhba1Efn78EQ2Ue9n9uXdAIHCk-U`, and the default tab is
`Sheet1`. Configure a different spreadsheet or tab with
`GOOGLE_SPREADSHEET_ID` or `GOOGLE_SHEET_NAME`.

To authorize the server:

1. Enable the Google Sheets API in Google Cloud and create a service account.
2. Create a JSON key for the service account and store it securely on the
   machine running the server.
3. Share the spreadsheet with the service account email address as an Editor.
   Keep the spreadsheet private; the server uses the service-account key to
   access it.
4. Set `GOOGLE_APPLICATION_CREDENTIALS` to the key's absolute path before
   starting the server, as shown in the setup commands above.

The sheet's first row must start with `Service`, `Technology`, and `Unit`,
followed by one or more price-tier columns. An optional `Rate_card` column
accepts `true` or `false`; blank price cells mean the service is unavailable
in that tier.

## Local application state

Create `data/data.json` in the project directory. It stores edit logs and
example cards, independently of the pricing Sheet:

```json
{
  "log": [],
  "projects": []
}
```

The data directory is git-ignored, so provide this file separately when
deploying.

## Deployment and access

Provide `secrets.csv`, `data/data.json`, and the service-account key separately;
do not commit credentials or private data. Install dependencies and set
`GOOGLE_APPLICATION_CREDENTIALS` in the server environment, then run
`python3 server.py` from the project directory. The server listens on port
3811.

The editable page requires HTTP Basic Authentication. `/view/` is a public,
read-only page, and its pricing data is publicly readable through the app.s
The built-in server does not provide HTTPS; use a TLS-terminating reverse proxy
when exposing it outside a trusted network.
