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
