// ============================================================
//  merchantauth.js — merchant sign-in and self-service portal
//  ----------------------------------------------------------
//  Sign-in is passwordless: the merchant proves they control a
//  contact already on their registry record, and we issue a
//  session cookie scoped to that one merchant.
//
//  Three details matter more than the rest:
//
//  1. THE OTP IS HASHED, like an API secret. A database leak
//     must not hand anyone a working code.
//
//  2. MERCHANT AND ADMIN TOKENS ARE SIGNED DIFFERENTLY.
//     Both use SESSION_SECRET, but a merchant token signs
//     "merchant:<id>:<exp>" while admin signs just "<exp>".
//     Without that separation a merchant cookie could be
//     replayed as an admin cookie - a token confusion attack.
//
//  3. WE NEVER CONFIRM WHETHER A CONTACT EXISTS. Unknown
//     contacts get the same reply as known ones, so nobody can
//     use the login form to enumerate PayPe's merchant list.
// ============================================================

const express = require("express");
const crypto = require("crypto");
const db = require("./db");
const notify = require("./notify");
const { issueKey } = require("./apikeys");

const router = express.Router();

const OTP_TTL_MS = 10 * 60 * 1000;   // code valid 10 minutes
const OTP_RESEND_MS = 60 * 1000;     // one code per minute per contact
const OTP_MAX_ATTEMPTS = 5;          // then the code is burned
const SESSION_MS = 12 * 60 * 60 * 1000;

function sha(v) {
  return crypto.createHash("sha256").update(String(v)).digest("hex");
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  if (x.length !== y.length) return false;
  return crypto.timingSafeEqual(x, y);
}

// ---- Session tokens: merchantId.exp.signature ----
function signSession(merchantId, exp) {
  return crypto
    .createHmac("sha256", process.env.SESSION_SECRET || "dev-secret")
    .update(`merchant:${merchantId}:${exp}`)
    .digest("hex");
}

function makeSession(merchantId) {
  const exp = Date.now() + SESSION_MS;
  return `${merchantId}.${exp}.${signSession(merchantId, exp)}`;
}

function readSession(token) {
  if (!token) return null;
  const parts = String(token).split(".");
  if (parts.length !== 3) return null;
  const [merchantId, exp, sig] = parts;
  if (!merchantId || !exp || !sig) return null;
  if (Number(exp) < Date.now()) return null;
  if (!safeEqual(sig, signSession(merchantId, exp))) return null;
  return merchantId;
}

function cookieValue(req, name) {
  const raw = req.headers.cookie || "";
  const hit = raw.split(";").map((c) => c.trim()).find((c) => c.startsWith(name + "="));
  return hit ? hit.slice(name.length + 1) : null;
}

async function requireMerchant(req, res, next) {
  try {
    const merchantId = readSession(cookieValue(req, "paype_merchant"));
    if (!merchantId) return res.status(401).json({ error: "unauthorized" });

    const merchant = await db.getMerchant(merchantId);
    if (!merchant) return res.status(401).json({ error: "unauthorized" });
    if (merchant.status !== "ACTIVE") {
      return res.status(403).json({ error: "Your account is suspended. Contact PayPe support." });
    }

    req.merchant = merchant;
    next();
  } catch (err) {
    console.error("❌ merchant session error:", err.message);
    res.status(503).json({ error: "Sign-in temporarily unavailable" });
  }
}

// ============================================================
//  POST /api/merchant/request-code
// ============================================================
router.post("/api/merchant/request-code", async (req, res) => {
  // Identical reply in every branch. Do not leak whether the contact is known.
  const generic = { ok: true, message: "If that contact is registered, a code is on its way." };

  try {
    const contact = String((req.body && req.body.contact) || "").trim().toLowerCase();
    if (!contact) return res.status(400).json({ error: "Enter your registered email or mobile number" });

    const merchant = await db.getMerchantByContact(contact);
    if (!merchant || merchant.status !== "ACTIVE") {
      console.log("🔐 code requested for unknown/inactive contact");
      return res.json(generic);
    }

    // Throttle resends so the form cannot be used to spam a merchant.
    const existing = await db.getOtp(contact);
    if (existing && Date.now() - (existing.createdAt || 0) < OTP_RESEND_MS) {
      return res.json(generic);
    }

    const code = String(crypto.randomInt(100000, 1000000)); // six digits
    await db.saveOtp(contact, {
      codeHash: sha(code),
      merchantId: merchant.merchantId,
      expiresAt: Date.now() + OTP_TTL_MS,
      attempts: 0,
    });

    const looksLikeEmail = contact.includes("@");
    const out = await notify.sendLoginCode({
      email: looksLikeEmail ? contact : merchant.email || null,
      phone: looksLikeEmail ? null : contact,
      code,
      businessName: merchant.businessName,
    });

    if (!out.delivered) {
      console.error("⚠️  login code generated but not delivered for", merchant.merchantId);
    } else {
      console.log("🔐 login code sent to", merchant.merchantId);
    }

    res.json(generic);
  } catch (err) {
    console.error("❌ request-code error:", err.message);
    res.status(503).json({ error: "Could not send a code just now. Try again shortly." });
  }
});

// ============================================================
//  POST /api/merchant/verify-code
// ============================================================
router.post("/api/merchant/verify-code", async (req, res) => {
  try {
    const contact = String((req.body && req.body.contact) || "").trim().toLowerCase();
    const code = String((req.body && req.body.code) || "").trim();
    if (!contact || !code) return res.status(400).json({ error: "Enter the code we sent you" });

    const record = await db.getOtp(contact);
    const wrong = () => res.status(401).json({ error: "That code is not valid" });

    if (!record) return wrong();
    if (record.expiresAt < Date.now()) {
      await db.deleteOtp(contact);
      return res.status(401).json({ error: "That code has expired. Request a new one." });
    }
    if ((record.attempts || 0) >= OTP_MAX_ATTEMPTS) {
      await db.deleteOtp(contact);
      return res.status(429).json({ error: "Too many attempts. Request a new code." });
    }
    if (!safeEqual(sha(code), record.codeHash)) {
      await db.bumpOtpAttempts(contact);
      return wrong();
    }

    // Correct: burn the code immediately so it cannot be replayed.
    await db.deleteOtp(contact);

    const merchant = await db.getMerchant(record.merchantId);
    if (!merchant || merchant.status !== "ACTIVE") {
      return res.status(403).json({ error: "Your account is not active. Contact PayPe support." });
    }

    res.setHeader(
      "Set-Cookie",
      `paype_merchant=${makeSession(merchant.merchantId)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${SESSION_MS / 1000}`
    );
    console.log("🔓 merchant signed in:", merchant.merchantId);
    res.json({ ok: true, businessName: merchant.businessName });
  } catch (err) {
    console.error("❌ verify-code error:", err.message);
    res.status(503).json({ error: "Could not verify the code just now" });
  }
});

router.post("/api/merchant/logout", (req, res) => {
  res.setHeader("Set-Cookie", "paype_merchant=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0");
  res.json({ ok: true });
});

// ============================================================
//  Merchant self-service — every route scoped to req.merchant
// ============================================================
router.get("/api/merchant/me", requireMerchant, (req, res) => {
  res.json({
    merchantId: req.merchant.merchantId,
    businessName: req.merchant.businessName,
    domain: req.merchant.domain,
    email: req.merchant.email || null,
    checkoutUrl: `${process.env.BASE_URL || ""}/?merchant=${req.merchant.merchantId}`,
  });
});

router.get("/api/merchant/orders", requireMerchant, async (req, res) => {
  try {
    const orders = await db.getOrdersForMerchant(req.merchant.merchantId, 100);
    res.json({ orders });
  } catch (err) {
    console.error("❌ merchant orders error:", err.message);
    res.status(500).json({ error: "Could not load your payments" });
  }
});

router.get("/api/merchant/refunds", requireMerchant, async (req, res) => {
  try {
    const refunds = await db.getRefundsForMerchant(req.merchant.merchantId, 100);
    res.json({ refunds });
  } catch (err) {
    console.error("❌ merchant refunds error:", err.message);
    res.status(500).json({ error: "Could not load your refunds" });
  }
});

// Merchants manage their own keys — no admin involvement needed.
router.get("/api/merchant/keys", requireMerchant, async (req, res) => {
  try {
    const keys = await db.getApiKeysForMerchant(req.merchant.merchantId);
    res.json({ keys });
  } catch (err) {
    res.status(500).json({ error: "Could not load your keys" });
  }
});

router.post("/api/merchant/keys", requireMerchant, async (req, res) => {
  try {
    const existing = await db.getApiKeysForMerchant(req.merchant.merchantId);
    const active = existing.filter((k) => k.status === "ACTIVE");
    if (active.length >= 5) {
      return res.status(400).json({ error: "You already have 5 active keys. Revoke one first." });
    }
    // Merchants may only ever mint test keys for themselves.
    const key = await issueKey(req.merchant.merchantId, "test");
    console.log("🔑 merchant self-issued key:", key.keyId);
    res.json({ ok: true, ...key, warning: "Copy the secret now - it cannot be shown again" });
  } catch (err) {
    console.error("❌ merchant key error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

router.post("/api/merchant/keys/:keyId/revoke", requireMerchant, async (req, res) => {
  try {
    const key = await db.getApiKey(req.params.keyId);
    // Ownership check: a merchant must not revoke someone else's key.
    if (!key || key.merchantId !== req.merchant.merchantId) {
      return res.status(404).json({ error: "Key not found" });
    }
    await db.revokeApiKey(req.params.keyId);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "Could not revoke that key" });
  }
});

module.exports = router;
module.exports.requireMerchant = requireMerchant;

router.get("/api/merchant/reports", requireMerchant, async (req, res) => {
  try {
    const period = ["daily", "monthly", "yearly"].includes(req.query.period) ? req.query.period : "monthly";
    const report = await db.getReport(period, req.merchant.merchantId);
    if (!report) return res.status(503).json({ error: "Database unavailable" });
    res.json({ report });
  } catch (err) { res.status(500).json({ error: "Could not load report" }); }
});

router.get("/api/merchant/reports", requireMerchant, async (req, res) => {
  try {
    const period = ["daily", "monthly", "yearly"].includes(req.query.period) ? req.query.period : "monthly";
    const report = await db.getReport(period, req.merchant.merchantId);
    if (!report) return res.status(503).json({ error: "Database unavailable" });
    res.json({ report });
  } catch (err) { res.status(500).json({ error: "Could not load report" }); }
});
