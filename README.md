# Asoltu notify server

HTTP API for **email / SMS / WhatsApp**. Firebase is not used.

The ERP app posts to `{COMMS_BASE_URL}/api/notify`.

## Change the mail server later

No app rewrite needed. Either:

1. Super Admin → Communication settings → **Notify / email server URL**
2. Rebuild with `--dart-define=ERP_COMMS_BASE_URL=https://your-new-host`

## Run locally

```bash
cd server/notify
cp .env.example .env
# set ERP_COMMS_API_KEY + SMTP_* or SENDGRID_API_KEY
node --env-file=.env index.js
```

## Deploy (Render / any Node host)

- Start command: `node index.js`
- Set the same env vars as `.env.example`
- Point the ERP `ERP_COMMS_BASE_URL` at that host

## API

`POST /api/notify`

Headers: `X-Api-Key: <ERP_COMMS_API_KEY>`

```json
{
  "channel": "email",
  "to": "office@school.com",
  "subject": "New teacher signup",
  "text": "...",
  "html": "<p>...</p>",
  "type": "role_signup",
  "schoolId": "..."
}
```

`GET /health` → `{ ok: true, firebase: false, swappable: true }`
