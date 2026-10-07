# Pricing

## Run

Requires Python 3. Start the server from the project directory:

```sh
python3 server.py
```

Open `http://localhost:3811/`. The editable page requires credentials from
`secrets.csv`, with one `username,password` pair per line.

## Data files

Both files belong in `data/`.

`pricing_data.csv` is UTF-8 CSV with a header row and one service per row:

```csv
"Service","Technology","Unit","Tier1","Tier2","Rate_card"
"Capillary Sequencing","Sanger","per sample",4.55,5.05,"true"
```

The first three columns must be `Service`, `Technology`, and `Unit`. Following
columns are price tiers; names become the tier labels shown in the page. Leave
a price cell empty when that service is unavailable in a tier. An optional
`Rate_card` column marks a row as part of the rate card (`true` or `false`); it
defaults to `true` when omitted.

`data.json` stores edit logs and example cards as a JSON object:

```json
{
  "log": [
  ],
  "projects": [
  ]
}
```

Both `log` and `projects` may be empty arrays initially.

## Deploy

Deploy and add `data.json` and `pricing_data.csv` in the `data/` directory. 
The data files and `secrets.csv` are git-ignored, so provide
them separately. Run `python3 server.py` from the project directory; it listens
on port 3811.

Use a TLS-terminating reverse proxy when exposing the service outside a trusted
network. The built-in server uses HTTP Basic Authentication and does not provide
HTTPS itself. `/view/` is a public, read-only view.
