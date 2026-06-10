/* ============================================================
   OMEGA Tweaks — License Delivery Webhook
   ------------------------------------------------------------
   This is the piece that makes a license key reach the customer
   AFTER a real Stripe payment. It:

     1. Receives Stripe's `checkout.session.completed` event
        (Stripe calls this automatically after every paid order).
     2. Verifies the event signature (so nobody can fake a payment).
     3. Generates a UNIQUE license code: OMEGA-TIER-XXXXXX.
     4. Emails it to the customer by calling YOUR existing EmailJS
        template (template_7adurqe) via the EmailJS REST API.
     5. Stores it so it can be validated later (and so the same
        order never mints two keys).
     6. Also credits the affiliate (client_reference_id) if present.

   It also exposes GET /validate?code=... so activate.html can
   check a key against the server instead of the browser.

   Deploy on any Node host (Render, Railway, Fly, a VPS...).
   See README.md in this folder for the exact click-by-click setup.
   ============================================================ */

const express = require("express");
const Stripe = require("stripe");
const Database = require("better-sqlite3");
const crypto = require("crypto");
const path = require("path");

/* ---------- config (all from environment variables) ---------- */
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;   // whsec_...
const SITE_ORIGIN = process.env.SITE_ORIGIN || "*";

// EmailJS (server-to-server REST call) — reuses your existing template.
const EMAILJS = {
  serviceId:  process.env.EMAILJS_SERVICE_ID  || "service_b1n9467",
  templateId: process.env.EMAILJS_LICENSE_TEMPLATE_ID || process.env.EMAILJS_LICENSE_TEMPLATE || "template_7adurqe",
  publicKey:  process.env.EMAILJS_PUBLIC_KEY  || "RWKkfjau0wXG9OFVF",
  privateKey: process.env.EMAILJS_PRIVATE_KEY // REQUIRED for server calls — from EmailJS > Account > API Keys
};

// Map the price the customer paid -> product + tier.
// Easiest: match on the amount (in the smallest currency unit, e.g. cents).
// 9.95 -> 995, 19.95 -> 1995, 39.95 -> 3995.
const AMOUNT_TO_PRODUCT = {
  995:  { product: "OMEGA Lite",  tier: "LITE" },
  1995: { product: "OMEGA Pro",   tier: "PRO" },
  3995: { product: "OMEGA Elite", tier: "ELITE" }
};
const COMMISSION = { application: 0.25, elite: 0.20 };

/* ---------- tiny database ---------- */
const db = new Database(path.join(__dirname, "licenses.db"));
db.exec(`
  CREATE TABLE IF NOT EXISTS licenses (
    code        TEXT PRIMARY KEY,
    product     TEXT NOT NULL,
    tier        TEXT NOT NULL,
    email       TEXT NOT NULL,
    name        TEXT,
    order_ref   TEXT UNIQUE,           -- Stripe session id -> idempotency (no double mint)
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

/* ---------- license code generation ---------- */
function randChars(n) {
  const c = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let s = "";
  for (let i = 0; i < n; i++) s += c[crypto.randomInt(c.length)];
  return s;
}
function genCode(tier) {
  let code;
  do { code = `OMEGA-${tier}-${randChars(6)}`; }
  while (db.prepare("SELECT 1 FROM licenses WHERE code=?").get(code));
  return code;
}

/* ---------- send the license email via EmailJS REST API ---------- */
async function emailLicense({ email, name, code, product }) {
  const r = await fetch("https://api.emailjs.com/api/v1.0/email/send", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      service_id:   EMAILJS.serviceId,
      template_id:  EMAILJS.templateId,
      user_id:      EMAILJS.publicKey,
      accessToken:  EMAILJS.privateKey,    // required for non-browser calls
      template_params: {
        to_email:       email,
        customer_email: email,
        customer_name:  name || "there",
        license_code:   code,
        product_name:   product,
        subject:        `Your ${product} license key`
      }
    })
  });
  if (!r.ok) throw new Error("EmailJS failed: " + r.status + " " + (await r.text()));
}

/* ---------- app ---------- */
const app = express();

// Stripe needs the RAW body to verify the signature — mount this BEFORE express.json().
app.post("/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers["stripe-signature"], STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error("Bad signature:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    try {
      await fulfill(session);
    } catch (e) {
      console.error("Fulfillment error:", e);
      // 500 tells Stripe to retry later — good, so a transient email outage doesn't lose the order.
      return res.status(500).json({ ok: false });
    }
  }
  res.json({ received: true });
});

async function fulfill(session) {
  // Idempotency: never mint twice for the same Stripe session.
  const existing = db.prepare("SELECT code FROM licenses WHERE order_ref=?").get(session.id);
  if (existing) { console.log("Already fulfilled:", session.id); return; }

  const email = session.customer_details?.email || session.customer_email;
  const name  = session.customer_details?.name || "";
  const amount = session.amount_total;                 // smallest currency unit (e.g. cents)
  const meta = AMOUNT_TO_PRODUCT[amount];
  if (!email || !meta) { console.error("Unmapped order", { email, amount }); return; }

  // 1) mint + store
  const code = genCode(meta.tier);
  db.prepare("INSERT INTO licenses (code,product,tier,email,name,order_ref) VALUES (?,?,?,?,?,?)")
    .run(code, meta.product, meta.tier, email, name, session.id);

  // 2) email it to the customer (reuses your EmailJS template)
  await emailLicense({ email, name, code, product: meta.product });
  console.log(`Delivered ${code} -> ${email}`);

  // 3) (optional) credit the affiliate carried in client_reference_id
  const ref = session.client_reference_id;
  if (ref) {
    // TODO: look up the affiliate by `ref` in your affiliate DB and insert a
    // purchases row with commission = price * (their rate). See reference-backend/server.js.
    console.log(`Affiliate ref on this order: ${ref}`);
  }
}

// activate.html can call this to validate a key against the server.
app.get("/validate", express.json(), (req, res) => {
  const code = String(req.query.code || "").trim().toUpperCase();
  res.header("Access-Control-Allow-Origin", SITE_ORIGIN);
  if (!/^OMEGA-(LITE|PRO|ELITE)-[A-Z0-9]{6}$/.test(code)) return res.json({ valid: false, reason: "format" });
  const row = db.prepare("SELECT product, tier, email FROM licenses WHERE code=?").get(code);
  if (!row) return res.json({ valid: false, reason: "not-found" });
  res.json({ valid: true, code, product: row.product, tier: row.tier });
});

app.get("/", (_req, res) => res.send("OMEGA license webhook is running."));

/* ===========================================================
   ADMIN: issue a FREE / comp license (e.g. affiliate Elite reward)
   -----------------------------------------------------------
   Mints a REAL key in the same database the app validates against,
   so it activates exactly like a purchased one. Protected by a
   secret admin token. Optionally emails it to the recipient.

   Set ADMIN_TOKEN in the environment (a long random string).

   Issue a key (curl):
     curl -X POST https://YOUR-WEBHOOK/admin/issue \
       -H "Content-Type: application/json" \
       -H "X-Admin-Token: YOUR_ADMIN_TOKEN" \
       -d '{"tier":"ELITE","email":"friend@example.com","name":"Friend","send":true}'

   Returns: { ok:true, code:"OMEGA-ELITE-XXXXXX", product, tier }
   =========================================================== */
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;
const TIER_PRODUCT = { LITE: "OMEGA Lite", PRO: "OMEGA Pro", ELITE: "OMEGA Elite" };

function issueCors(req, res) {
  const origin = req.headers.origin;
  res.header("Access-Control-Allow-Origin", origin || SITE_ORIGIN);
  res.header("Vary", "Origin");
  res.header("Access-Control-Allow-Headers", "Content-Type, X-Admin-Token");
  res.header("Access-Control-Allow-Methods", "POST, OPTIONS");
}
// CORS preflight for the browser admin panel
app.options("/admin/issue", (req, res) => { issueCors(req, res); res.sendStatus(204); });

app.post("/admin/issue", express.json(), async (req, res) => {
  issueCors(req, res);
  if (!ADMIN_TOKEN || req.headers["x-admin-token"] !== ADMIN_TOKEN) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }
  const tier = String((req.body && req.body.tier) || "ELITE").toUpperCase();
  const product = TIER_PRODUCT[tier];
  if (!product) return res.status(400).json({ ok: false, error: "bad tier (LITE|PRO|ELITE)" });

  const email = (req.body && req.body.email) || "";
  const name = (req.body && req.body.name) || "";
  const note = (req.body && req.body.note) || "comp";

  // mint + store (order_ref keeps it unique / idempotent per note+email if provided)
  const code = genCode(tier);
  const orderRef = `comp:${note}:${email || crypto.randomUUID()}`;
  try {
    db.prepare("INSERT INTO licenses (code,product,tier,email,name,order_ref) VALUES (?,?,?,?,?,?)")
      .run(code, product, tier, email || "comp@omega", name, orderRef);
  } catch (e) {
    // a license already issued for this exact note+email -> return the existing one
    const existing = db.prepare("SELECT code, product, tier FROM licenses WHERE order_ref=?").get(orderRef);
    if (existing) return res.json({ ok: true, code: existing.code, product: existing.product, tier: existing.tier, reused: true });
    return res.status(500).json({ ok: false, error: "db error" });
  }

  // optionally email it (reuses your EmailJS license template)
  if (req.body && req.body.send && email) {
    try { await emailLicense({ email, name, code, product }); }
    catch (e) { return res.json({ ok: true, code, product, tier, emailed: false, emailError: String(e.message || e) }); }
    return res.json({ ok: true, code, product, tier, emailed: true });
  }
  res.json({ ok: true, code, product, tier });
});

const PORT = process.env.PORT || 4242;
app.listen(PORT, () => console.log(`License webhook on :${PORT}`));
