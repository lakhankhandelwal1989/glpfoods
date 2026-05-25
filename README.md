# Ganga Lehari Pansari (GLP) — D2C Site

A heritage Rajasthani spice & premix brand from Alwar, going direct-to-consumer.
Express + PostgreSQL app with a bilingual (EN/HI) landing page, a chatbot that captures customer leads, and an admin panel for managing those leads.

---

## What's in here

```
/
├── server.js              ← Express app, all routes & auth
├── package.json
├── .env.example           ← env-var template
├── README.md
├── db/
│   └── schema.sql         ← reference schema (server creates idempotently)
└── public/
    ├── index.html         ← landing page (bilingual, chatbot mounted)
    ├── admin.html         ← admin login + dashboard SPA
    ├── GLP_Logo.png
    └── js/
        ├── translations.js   ← all EN+HI strings
        ├── i18n.js           ← language switcher
        └── chatbot.js        ← lead-capture widget
```

---

## What it does

### Public site (`/`)
- Heritage-style landing page in English + Hindi.
- Top-right **EN / हिं** toggle persists the choice in `localStorage`.
- Floating **chatbot** (bottom-right) collects `name → phone → location` from visitors and POSTs to `/api/leads`. The bot speaks whichever language the page is in.
- Fully responsive: hamburger menu under 960px, full-screen chatbot under 700px, tightened typography and section padding on small viewports.

### Admin panel (`/admin`)
- Login form (default `Lakhan / Lakhan`, seeded on first boot).
- **Leads** tab: stats cards (total, today, EN, HI) + sortable table with search, CSV export, and per-row delete.
- **Settings** tab: change username and/or password (current password required to confirm).
- Session lives in an httpOnly JWT cookie for 7 days.

---

## Deploy to Railway

1. **Push this project to GitHub.** Create a repo and push the contents of this folder.

2. **Create a new Railway project** → "Deploy from GitHub repo" → select the repo.

3. **Add a PostgreSQL plugin** to the project (Railway will inject `DATABASE_URL` automatically).

4. **Set environment variables** in the Railway service:
   - `JWT_SECRET` — a long random string. Generate one with:
     ```bash
     node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
     ```
   - `NODE_ENV` — set to `production`
   - `PORT` — Railway sets this automatically; do not override.
   - `DATABASE_URL` — auto-injected by the Postgres plugin.

5. **Deploy.** Railway will run `npm install` and `npm start`. On first boot the server creates the `customers` and `admins` tables and seeds the default admin (`Lakhan / Lakhan`).

6. **Set the custom domain** (optional) in Railway's Settings → Domains.

7. **Log in to `/admin`** and immediately change the default credentials in the Settings tab.

---

## Local development

```bash
cp .env.example .env
# fill in DATABASE_URL with a local Postgres instance
# fill in a JWT_SECRET (any string is fine for local)

npm install
npm start
```

Then open `http://localhost:3000`. The admin panel is at `http://localhost:3000/admin`.

---

## Endpoints

### Public
| Method | Path                  | Body                                 | Notes |
|-------:|-----------------------|--------------------------------------|-------|
| GET    | `/`                   | —                                    | Landing page |
| GET    | `/admin`              | —                                    | Admin SPA |
| GET    | `/healthz`            | —                                    | Health check |
| POST   | `/api/leads`          | `{name, phone, location, language}`  | Chatbot lead capture |

### Admin (require auth cookie)
| Method | Path                          | Body                                            |
|-------:|-------------------------------|-------------------------------------------------|
| POST   | `/admin/api/login`            | `{username, password}` → sets cookie            |
| POST   | `/admin/api/logout`           | clears cookie                                   |
| GET    | `/admin/api/me`               | current admin                                   |
| GET    | `/admin/api/leads`            | `?limit=&offset=`                               |
| GET    | `/admin/api/leads.csv`        | CSV export                                      |
| DELETE | `/admin/api/leads/:id`        | remove a lead                                   |
| POST   | `/admin/api/credentials`      | `{currentPassword, newUsername?, newPassword?}` |

---

## Database schema

```sql
customers:
  id          SERIAL PK
  name        VARCHAR(200) NOT NULL
  phone       VARCHAR(20)  NOT NULL
  location    VARCHAR(200)
  language    VARCHAR(10)  DEFAULT 'en'
  source      VARCHAR(50)  DEFAULT 'chatbot'
  created_at  TIMESTAMPTZ  DEFAULT NOW()

admins:
  id             SERIAL PK
  username       VARCHAR(100) UNIQUE NOT NULL
  password_hash  TEXT NOT NULL
  created_at     TIMESTAMPTZ DEFAULT NOW()
  updated_at     TIMESTAMPTZ DEFAULT NOW()
```

---

## Default credentials

On first boot the server seeds:

- **Username:** `Lakhan`
- **Password:** `Lakhan`

These are intended for first login only. **Change them immediately** in `/admin → Settings → Change Credentials`. Once changed, the default is overwritten and the new password must be used.

---

## i18n: adding or editing strings

1. Open `public/js/translations.js`.
2. Add the key under both `en` and `hi`.
3. Reference it in HTML with `data-i18n="your.key"` (innerHTML), `data-i18n-placeholder="..."` (input placeholder), or `data-i18n-aria="..."` (aria-label).
4. No build step — refresh the page.

The chatbot pulls all its strings from `chat.*` keys, including the templated `chat.askPhone` and `chat.thanks` which use `{name}` substitution.

---

## Security notes

- Passwords are stored as bcrypt hashes (10 rounds).
- Admin sessions use httpOnly, `sameSite=lax`, `secure` (in prod) JWT cookies that expire in 7 days.
- `/api/leads` validates name length (2–200), phone digits (10–13), and language whitelist.
- Set a strong `JWT_SECRET` in production; the default in code is a placeholder.
- The default `Lakhan / Lakhan` admin is a one-time seed. Once you change either field, the seed is overwritten.
