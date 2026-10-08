# Pricing

## Setup and run

Requires Python 3. From the project directory, install dependencies, configure
Google Sheets access, and start the server:

```sh
python3 -m pip install -r requirements.txt
export GOOGLE_APPLICATION_CREDENTIALS="/absolute/path/to/project/secrets/key.json"
python3 server.py
```

Keep private files in the project-level `secrets/` directory, which is ignored
by Git. Set `GOOGLE_APPLICATION_CREDENTIALS` to the absolute path of the
service-account JSON key in that directory.

Open `http://localhost:3811/`. The editable page prompts for credentials from
`secrets/secrets.csv`, which should contain one `username,password` pair per
line. Create this file in the `secrets/` directory.

## Google Sheets

Pricing data is read from and saved to Google Sheets. The default spreadsheet ID is
`19ByaGb1-X7Z_6_Dwhba1Efn78EQ2Ue9n9uXdAIHCk-U`, and the default tab is
`Sheet1`. Configure a different spreadsheet or tab with
`GOOGLE_SPREADSHEET_ID` or `GOOGLE_SHEET_NAME`.

To authorize the server:

1. Enable the Google Sheets API in Google Cloud and create a service account.
2. Create a JSON key for the service account and store it as
   `secrets/tgs-pricing-1f2045547346.json` on the machine running the server.
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

On startup, the server creates the `data/` directory and these files if they
are missing:

```json
{
  "log": [],
  "projects": []
}
```

`data/data.json` stores edit logs and example cards. The server also creates an
empty `data/pricing_data.csv` placeholder; it does not supply pricing data.
Pricing is fetched from Google Sheets by the server.

## Deployment and access

Provide the `secrets/` directory separately; do not commit credentials or
private data. The server initializes missing local data files automatically.
Install dependencies and set
`GOOGLE_APPLICATION_CREDENTIALS` in the server environment, then run
`python3 server.py` from the project directory. The server listens on port
3811.

The editable page requires HTTP Basic Authentication. `/view/` is a public,
read-only page, and its pricing data is publicly readable through the app.s
The built-in server does not provide HTTPS; use a TLS-terminating reverse proxy
when exposing it outside a trusted network.
