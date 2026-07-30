// ============================================================
//  apikeys.js — per-merchant API key authentication
//  ----------------------------------------------------------
//  Two ideas do the heavy lifting here:
//
//  1. WE NEVER STORE THE SECRET.
//     We store only a SHA-256 hash of it. If our database ever
//     leaks, the attacker gets hashes, not usable keys. The
//     merchant sees the secret exactly once, at creation.
//
//  2. THE MERCHANT COMES FROM THE KEY, NOT THE REQUEST.
//     Previously merchantId arrived in the request body, so a
//     caller could name any merchant. Now identity is derived
//     from the authenticated key and the body cannot override it.
// ============================================================

const crypto = require("crypto");
const db = require("./db");

// SHA-256 is right for API keys (unlike passwords, which need bcrypt):
// the secret is 24 random bytes, so brute force is not feasible.
function hash(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

// Compare two hashes in constant time.
// A plain !== leaks information: it returns faster when the first
// characters differ, and a patient attacker can measure that.
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// Generate a new key pair for a merchant.
// Returns the plaintext secret ONCE — the caller must show it and forget it.
async function issueKey(merchantId, env) {
  const mode = env === "live" ? "live" : "test";
  const keyId = `pk_${mode}_` + crypto.randomBytes(9).toString("hex");
  const secret = `sk_${mode}_` + crypto.randomBytes(24).toString("hex");

  await db.saveApiKey({
    keyId,
    merchantId,
    secretHash: hash(secret),
    env: mode,
    status: "ACTIVE",
  });

  return { keyId, secret, env: mode };
}

// ============================================================
//  MIDDLEWARE — guards every merchant API route
// ============================================================
async function requireMerchantKey(req, res, next) {
  try {
    const keyId = req.headers["x-paype-key-id"];
    const secret = req.headers["x-paype-secret"];

    if (!keyId || !secret) {
      return res.status(401).json({
        error: "Missing credentials",
        detail: "Send X-PayPe-Key-Id and X-PayPe-Secret headers",
      });
    }

    const record = await db.getApiKey(String(keyId));

    // Same generic reply whether the key is unknown, revoked, or the
    // secret is wrong. Distinguishing them would help an attacker
    // learn which key IDs exist.
    const reject = () => res.status(401).json({ error: "Invalid credentials" });

    if (!record || record.status !== "ACTIVE") return reject();
    if (!safeEqual(hash(String(secret)), record.secretHash)) return reject();

    const merchant = await db.getMerchant(record.merchantId);
    if (!merchant) return reject();

    // A suspended merchant gets a clear 403 — they are authenticated,
    // just not permitted, and they need to know the difference.
    if (merchant.status !== "ACTIVE") {
      return res.status(403).json({ error: "Merchant is suspended" });
    }

    req.merchant = merchant;
    req.apiKey = record;

    // Fire-and-forget: record usage without delaying the response
    db.touchApiKey(record.keyId).catch(() => {});

    next();
  } catch (err) {
    console.error("❌ key auth error:", err.message);
    res.status(503).json({ error: "Authentication temporarily unavailable" });
  }
}

// ============================================================
//  OWNERSHIP — the check that keeps merchants apart
//  Returns 404, never 403, when a record belongs to someone else.
//  A 403 would confirm the record exists, letting a merchant probe
//  for other merchants' order IDs.
// ============================================================
function ownsRecord(req, record) {
  if (!record) return false;
  return record.merchantId === req.merchant.merchantId;
}

module.exports = { issueKey, requireMerchantKey, ownsRecord, hash, safeEqual };
