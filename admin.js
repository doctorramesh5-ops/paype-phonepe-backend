// admin.js — PayPe Admin: login, sessions, protected APIs
// Session = cookie "exp.signature" where signature = HMAC-SHA256(exp, SESSION_SECRET)
const express = require("express");
const crypto = require("crypto");
const db = require("./db");

const router = express.Router();

function sign(exp) {
  return crypto.createHmac("sha256", process.env.SESSION_SECRET || "dev-secret")
    .update(String(exp)).digest("hex");
}

function makeToken() {
  const exp = Date.now() + 8 * 60 * 60 * 1000; // 8 hours
  return `${exp}.${sign(exp)}`;
}

function verifyToken(token) {
  if (!token) return false;
  const [exp, sig] = token.split(".");
  if (!exp || !sig) return false;
  if (Number(exp) < Date.now()) return false;
  return sig === sign(exp);
}

function getSessionToken(req) {
  const cookies = req.headers.cookie || "";
  const match = cookies.split(";").map(c => c.trim()).find(c => c.startsWith("paype_admin="));
  return match ? match.split("=")[1] : null;
}

function requireAdmin(req, res, next) {
  if (verifyToken(getSessionToken(req))) return next();
  res.status(401).json({ error: "unauthorized" });
}

router.post("/api/admin/login", (req, res) => {
  const { username, password } = req.body || {};
  if (
    username === process.env.ADMIN_USERNAME &&
    password === process.env.ADMIN_PASSWORD &&
    process.env.ADMIN_USERNAME
  ) {
    const token = makeToken();
    res.setHeader("Set-Cookie",
      `paype_admin=${token}; HttpOnly; Secure; Path=/; Max-Age=${8 * 60 * 60}`);
    return res.json({ ok: true });
  }
  console.log("🚫 Admin login failed for user:", username);
  res.status(401).json({ error: "Invalid username or password" });
});

router.post("/api/admin/logout", (req, res) => {
  res.setHeader("Set-Cookie", "paype_admin=; HttpOnly; Secure; Path=/; Max-Age=0");
  res.json({ ok: true });
});

router.get("/api/admin/me", (req, res) => {
  res.json({ loggedIn: verifyToken(getSessionToken(req)) });
});

router.get("/api/admin/orders", requireAdmin, async (req, res) => {
  try {
    const orders = await db.getRecentOrders(100);
    res.json({ orders });
  } catch (err) {
    console.error("❌ admin orders error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get("/api/admin/refunds", requireAdmin, async (req, res) => {
  try {
    const refunds = await db.getRecentRefunds(100);
    res.json({ refunds });
  } catch (err) {
    console.error("❌ admin refunds error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

// ============================================================
//  MERCHANT MANAGEMENT (all admin-protected)
// ============================================================
router.post("/api/admin/merchants", requireAdmin, async (req, res) => {
  try {
    const { businessName, mid, domain, contactName, email, phone } = req.body || {};
    if (!businessName || !businessName.trim()) {
      return res.status(400).json({ error: "Business name is required" });
    }
    if (!mid || !/^[A-Za-z0-9_-]{3,40}$/.test(mid.trim())) {
      return res.status(400).json({ error: "MID is required (3-40 letters/numbers)" });
    }
    if (!domain || !/^https:\/\/[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/.test(domain.trim())) {
      return res.status(400).json({ error: "Domain must be a valid https:// URL" });
    }
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      return res.status(400).json({ error: "Invalid email address" });
    }

    const merchantId = "MER" + Date.now();
    const merchant = {
      merchantId,
      businessName: businessName.trim(),
      mid: mid.trim(),
      domain: domain.trim().replace(/\/+$/, ""),
      contactName: (contactName || "").trim(),
      email: (email || "").trim().toLowerCase(),
      phone: (phone || "").trim(),
      status: "ACTIVE",
    };
    await db.saveMerchant(merchant);
    console.log("🏪 Merchant onboarded:", merchantId, merchant.businessName);
    res.json({ ok: true, merchant });
  } catch (err) {
    console.error("❌ create merchant error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get("/api/admin/merchants", requireAdmin, async (req, res) => {
  try {
    const merchants = await db.getMerchants(200);
    res.json({ merchants });
  } catch (err) {
    console.error("❌ list merchants error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

router.post("/api/admin/merchants/:merchantId/status", requireAdmin, async (req, res) => {
  try {
    const { status } = req.body || {};
    if (!["ACTIVE", "SUSPENDED"].includes(status)) {
      return res.status(400).json({ error: "status must be ACTIVE or SUSPENDED" });
    }
    await db.updateMerchant(req.params.merchantId, { status });
    console.log("🏪 Merchant", req.params.merchantId, "→", status);
    res.json({ ok: true });
  } catch (err) {
    console.error("❌ merchant status error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============ API KEY MANAGEMENT (admin only) ============
const { issueKey } = require("./apikeys");

router.post("/api/admin/merchants/:merchantId/keys", requireAdmin, async (req, res) => {
  try {
    const merchant = await db.getMerchant(req.params.merchantId);
    if (!merchant) return res.status(404).json({ error: "Merchant not found" });
    const env = req.body && req.body.env === "live" ? "live" : "test";
    const key = await issueKey(merchant.merchantId, env);
    console.log("🔑 Key issued:", key.keyId, "→", merchant.merchantId);
    res.json({ ok: true, ...key, warning: "Copy the secret now - it cannot be shown again" });
  } catch (err) {
    console.error("❌ issue key error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get("/api/admin/merchants/:merchantId/keys", requireAdmin, async (req, res) => {
  try {
    res.json({ keys: await db.getApiKeysForMerchant(req.params.merchantId) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post("/api/admin/keys/:keyId/revoke", requireAdmin, async (req, res) => {
  try {
    await db.revokeApiKey(req.params.keyId);
    console.log("🔑 Key revoked:", req.params.keyId);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports.requireAdmin = requireAdmin;

router.get("/api/admin/reports", requireAdmin, async (req, res) => {
  try {
    const period = ["daily", "monthly", "yearly"].includes(req.query.period) ? req.query.period : "monthly";
    const merchantId = req.query.merchant || null;
    const report = await db.getReport(period, merchantId);
    if (!report) return res.status(503).json({ error: "Database unavailable" });
    res.json({ report });
  } catch (err) { res.status(500).json({ error: "Could not load report" }); }
});

// ============ PLATFORM OVERVIEW (admin CEO dashboard) ============
router.get("/api/admin/overview", requireAdmin, async (req, res) => {
  try {
    const overview = await db.getPlatformOverview();
    if (!overview) return res.status(503).json({ error: "Database unavailable" });
    res.json({ overview });
  } catch (err) {
    console.error("❌ overview error:", err.message);
    res.status(500).json({ error: "Could not load overview" });
  }
});

router.get("/api/admin/reports", requireAdmin, async (req, res) => {
  try {
    const period = ["daily", "monthly", "yearly"].includes(req.query.period) ? req.query.period : "monthly";
    const merchantId = req.query.merchant || null;
    const report = await db.getReport(period, merchantId);
    if (!report) return res.status(503).json({ error: "Database unavailable" });
    res.json({ report });
  } catch (err) { res.status(500).json({ error: "Could not load report" }); }
});
