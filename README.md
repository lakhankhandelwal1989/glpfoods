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
├── docker-compose.yml     ← local Postgres for development (see below)
├── README.md
├── db/
│   └── schema.sql         ← reference schema (server creates idempotently)
└── public/
    ├── index.html         ← landing page (bilingual, chatbot, cart & checkout)
    ├── admin.html         ← admin login + dashboard SPA
    ├── GLP_Logo.png
    └── js/
        ├── translations.js   ← all EN+HI strings
        ├── i18n.js           ← language switcher
        ├── chatbot.js        ← lead-capture widget
        └── qrcode.js         ← vendored QR generator (UPI checkout)
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

You need a Postgres database to point the app at. Easiest way — a disposable
one via Docker:

```bash
docker compose up -d          # starts Postgres on localhost:5432 (user/pass/db: glp/glp/glp)
```

(No Docker? Any Postgres works — a local install, or a free instance from
[Neon](https://neon.tech) or [Supabase](https://supabase.com). Just put its
connection string in `DATABASE_URL` below.)

Then:

```bash
cp .env.example .env
# DATABASE_URL=postgres://glp:glp@localhost:5432/glp   (if using docker compose above)
# JWT_SECRET=anything                                   (any string is fine for local)
# NODE_ENV=development

npm install
npm start
```

Open `http://localhost:3000` for the site and `http://localhost:3000/admin`
for the admin panel (default login `Lakhan` / `Lakhan`). The server creates
every table it needs on first boot and seeds three sample products, so
there's nothing else to set up.

To wipe local data and start over: `docker compose down -v` (destroys the
volume), then `docker compose up -d` again and restart `npm start`.

---

## Testing a branch before it goes to production

Do this **before merging into `main`** (which is what Railway deploys from).
Pull the branch, run it locally against a throwaway database as above, then
work through whichever of these applies to what changed:

**Add to Bag toggle** (`/admin` → Settings → Store Controls)
- [ ] Toggle **on**: every product card shows a working "Add to Bag" button; the bag icon appears in the nav.
- [ ] Toggle **off**: buttons everywhere switch to "Notify Me"; the bag icon disappears from the nav entirely; if you had items in the bag already, they're just inaccessible, not deleted — they reappear if you switch it back on.
- [ ] "Notify Me" opens a form (name optional, phone required, email optional, city dropdown); submitting shows a success message and the lead appears in the **Leads** tab with source `Notify Me - <product name>`.

**Cart & review** (toggle must be on)
- [ ] "Add to Bag" on a product opens the cart drawer with that item in it.
- [ ] Adding the same product+size again increases its quantity instead of creating a duplicate row.
- [ ] The +/− steppers change quantity; "Remove" deletes the row; removing everything shows the empty-bag state and disables "Proceed to Checkout".
- [ ] Subtotal/shipping/total update live. Shipping is ₹49 under ₹999 subtotal, free at or above it.
- [ ] The bag icon's badge count matches the total quantity in the cart, and survives a page reload (it's saved in the browser).

**Checkout — Cash on Delivery**
- [ ] "Proceed to Checkout" shows the form with a live item/total recap.
- [ ] Submitting with an invalid or missing phone/address/city is rejected with a clear message; a valid submission shows an order-confirmation screen with an order number and "Pay ₹X on delivery."
- [ ] The order appears in `/admin` → **Orders** with payment "Cash on Delivery" and status "Placed".

**Checkout — UPI** (`/admin` → Settings → Payments)
- [ ] With no UPI ID set, "Pay via UPI" doesn't appear at checkout at all.
- [ ] Set a UPI ID (any fake one is fine for testing, e.g. `test@upi`) and optionally a payee name → Save.
- [ ] Back at checkout, "Pay via UPI" now appears; selecting it renders a QR code and the UPI ID with a working "Copy" button.
- [ ] Placing the order shows "We'll confirm your UPI payment shortly," and the order lands in **Orders** as "UPI · Pending" with a **Mark Paid** button.
- [ ] Clicking **Mark Paid** flips it to "UPI · Paid" and the "UPI Awaiting Verification" stat at the top decreases.

**Admin → Orders**
- [ ] The status dropdown (Placed/Confirmed/Shipped/Delivered/Cancelled) saves on change.
- [ ] "Export CSV" downloads a file with every order and its line items.
- [ ] Deleting an order removes it after confirmation.

**Cross-check**
- [ ] With the toggle off, try placing an order anyway by re-enabling only the API (skip this unless you're comfortable with `curl`) — `/api/checkout` should refuse with a 403 even if someone bypasses the UI, since the toggle is enforced server-side too.
- [ ] Switch the language to हिं and click back through the flows above — labels should be in Hindi (a few concatenated sentences read a little stiffly by design, since this codebase builds them from fixed fragments rather than full translated sentences).

Once everything on the relevant list checks out, merge to `main` — Railway
picks it up automatically from there.

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
