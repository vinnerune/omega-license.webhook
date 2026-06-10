# OMEGA Tweaks — License Delivery Webhook

This is the missing piece that **makes the license key reach the customer** after a
real Stripe payment. Without it, buyers pay but never get a key.

```
Customer pays on Stripe
        │
        ▼
Stripe → POST /webhook  (checkout.session.completed)
        │
        ├─ 1. verify signature (rejects fake calls)
        ├─ 2. generate OMEGA-TIER-XXXXXX
        ├─ 3. email it via your EmailJS template (template_7adurqe)
        └─ 4. store it  →  GET /validate?code=... powers activate.html
```

It **reuses the EmailJS template you already built** — no new email system needed.

---

## What you need (one-time)

1. A **Stripe account** (you already have the 3 Payment Links).
2. A place to run a tiny Node app — **Render**, **Railway**, or **Fly.io** all have a free/cheap tier. (Any always-on Node host works.)
3. Your **EmailJS private key** (EmailJS → *Account → API Keys*). Also toggle on
   **“Allow EmailJS API for non-browser applications.”**

---

## Setup, click by click

### 1. Deploy this folder
- Push `license-webhook/` to a GitHub repo (or upload it to your host).
- On Render/Railway: “New Web Service” → point it at this folder → build `npm install`, start `npm start`.

### 2. Set environment variables (on your host)
| Variable | Where to get it | Example |
|---|---|---|
| `STRIPE_SECRET_KEY` | Stripe → Developers → API keys | `sk_live_...` |
| `STRIPE_WEBHOOK_SECRET` | created in step 3 below | `whsec_...` |
| `EMAILJS_PRIVATE_KEY` | EmailJS → Account → API Keys | `xxxxxxxx` |
| `EMAILJS_SERVICE_ID` | (already defaulted) | `service_b1n9467` |
| `EMAILJS_LICENSE_TEMPLATE` | (already defaulted) | `template_7adurqe` |
| `EMAILJS_PUBLIC_KEY` | (already defaulted) | `RWKkfjau0wXG9OFVF` |
| `SITE_ORIGIN` | your live site URL | `https://omegatweaks.com` |

### 3. Register the webhook in Stripe
- Stripe → **Developers → Webhooks → Add endpoint**.
- Endpoint URL: `https://YOUR-DEPLOYED-APP/webhook`
- Events to send: **`checkout.session.completed`**.
- Save, then copy the **Signing secret** (`whsec_...`) into `STRIPE_WEBHOOK_SECRET` and redeploy.

### 4. Send buyers to the thank-you page
- For each of your 3 **Payment Links** → *After payment* → **Redirect** to
  `https://omegatweaks.com/success.html`.

### 5. (Recommended) Point activation at the server
- In `omega-checkout.js`, change `validateLicense` to call
  `GET https://YOUR-DEPLOYED-APP/validate?code=...` instead of reading the browser store,
  so keys are validated against the real database. (Ask and I’ll wire this for you.)

---

## Test it
- Use Stripe **test mode** keys + a test Payment Link.
- Pay with card `4242 4242 4242 4242`, any future expiry, any CVC.
- Check: the buyer’s inbox gets the key, and `licenses.db` has a new row.
- Stripe → Webhooks shows a **200** response.

---

## How the product is identified
The webhook maps the **amount paid** to the product:

| Amount | Product |
|---|---|
| €9.95 | OMEGA Lite |
| €19.95 | OMEGA Pro |
| €39.95 | OMEGA Elite |

If you change prices, update `AMOUNT_TO_PRODUCT` in `server.js`. (You can also map by
Stripe Price ID if you prefer — say the word.)

## Notes
- **Idempotent:** Stripe may deliver an event more than once; the webhook keys off the
  Stripe session id so a customer never gets two keys for one order.
- **Affiliate credit:** the buyer’s referral rides along as Stripe `client_reference_id`;
  there’s a `TODO` marked where you join it to the affiliate DB from `reference-backend`.
- **Security:** the signature check means only genuine Stripe events are honored — a key
  can’t be minted by hitting the URL directly.

---

## Issuing a FREE / comp license  (affiliate Elite reward)

Affiliate Elite keys made in the website admin panel are **local only** and will NOT
activate the app — the app trusts this server, and those keys were never stored here.
To give someone a working free key, mint a REAL one with the admin endpoint.

**1. Set an admin secret** (one env var, alongside the others):
```
ADMIN_TOKEN = <a long random string>
```
Redeploy so the new `/admin/issue` route goes live.

**2. Issue a key** (run from your computer / any terminal):
```bash
curl -X POST https://omega-license-webhook-1.onrender.com/admin/issue \
  -H "Content-Type: application/json" \
  -H "X-Admin-Token: YOUR_ADMIN_TOKEN" \
  -d '{"tier":"ELITE","email":"friend@example.com","name":"Friend","send":true}'
```
- `tier`  : `LITE` | `PRO` | `ELITE`
- `send`  : `true` also emails the key via your EmailJS template; omit to just get it back
- Response: `{ "ok": true, "code": "OMEGA-ELITE-XXXXXX", ... }`

The returned `OMEGA-ELITE-XXXXXX` is stored in this server's database, so it activates
the desktop app exactly like a purchased key.

**Later (automatic):** once the affiliate backend is deployed, its "Approve" step can call
this same endpoint server-side, so approved affiliates get a real, working Elite key
automatically — no manual curl. (The admin token stays on the server, never in a browser.)

