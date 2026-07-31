const express = require("express");
const crypto = require("crypto");
const db = require("./db");

const TIERS = {
  STANDARD: { label: "Standard (E-Com/Education/Grocery/Government)", basePaise: 499900 },
  NBFC:     { label: "NBFC", basePaise: 999900 },
  B2B:      { label: "B2B", basePaise: 1499900 },
};
const GST_RATE = 0.18;

function amountWithGst(basePaise) { return Math.round(basePaise * (1 + GST_RATE)); }
function razorpayConfigured() { return Boolean(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET); }

const ALLOWED_ORIGINS = new Set([
  "https://pg.paype.co.in",
  "https://paype.co.in",
  "https://www.paype.co.in",
  "https://api.paype.co.in",
]);

function corsMiddleware(req, res, next) {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  }
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
}

module.exports = function activation(gw) {
  const { getAuthToken, tspHeaders, baseUrl } = gw;
  const router = express.Router();
  router.use(corsMiddleware);

  router.post("/api/activation/create-order", async (req, res) => {
    try {
      if (!razorpayConfigured()) return res.status(503).json({ error: "Payment collection is not configured yet. Contact admin@paype.co.in." });
      const tierKey = String((req.body && req.body.tier) || "").toUpperCase();
      const tier = TIERS[tierKey];
      if (!tier) return res.status(400).json({ error: "Unknown pricing tier" });
      const { businessName, contactName, phone } = req.body || {};
      const email = String((req.body && req.body.email) || "").trim().toLowerCase();
      if (!businessName || !email) return res.status(400).json({ error: "Business name and email are required" });

      const amountPaise = amountWithGst(tier.basePaise);
      const receiptId = "ACTRP" + Date.now();
      const auth = Buffer.from(`${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`).toString("base64");
      const rpRes = await fetch("https://api.razorpay.com/v1/orders", {
        method: "POST", headers: { "Content-Type": "application/json", "Authorization": `Basic ${auth}` },
        body: JSON.stringify({ amount: amountPaise, currency: "INR", receipt: receiptId, notes: { tier: tierKey, businessName, contactName: contactName || "", email, phone: phone || "" } }),
      });
      const data = await rpRes.json();
      if (!rpRes.ok || !data.id) { console.error("❌ Razorpay order creation failed:", data); return res.status(502).json({ error: "Could not start payment. Please try again shortly." }); }

      await db.saveActivation({ receiptId, razorpayOrderId: data.id, gateway: "RAZORPAY", tier: tierKey, tierLabel: tier.label, amountPaise, businessName, contactName: contactName || "", email, phone: phone || "", status: "PENDING" });
      console.log("💳 Activation order created (Razorpay):", receiptId, tierKey, "₹" + (amountPaise / 100).toFixed(2));
      res.json({ orderId: data.id, amountPaise, currency: "INR", keyId: process.env.RAZORPAY_KEY_ID, receiptId, businessName, email, phone: phone || "" });
    } catch (err) { console.error("❌ create-order error:", err.message); res.status(500).json({ error: "Could not start payment" }); }
  });

  router.post("/api/activation/verify", async (req, res) => {
    try {
      const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body || {};
      if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) return res.status(400).json({ error: "Missing payment verification fields" });
      const expected = crypto.createHmac("sha256", process.env.RAZORPAY_KEY_SECRET).update(`${razorpay_order_id}|${razorpay_payment_id}`).digest("hex");
      const a = Buffer.from(expected); const b = Buffer.from(String(razorpay_signature));
      const valid = a.length === b.length && crypto.timingSafeEqual(a, b);
      if (!valid) { console.warn("🚫 Activation payment signature mismatch for order", razorpay_order_id); return res.status(400).json({ error: "Payment could not be verified" }); }
      await db.updateActivationByOrderId(razorpay_order_id, { status: "PAID", razorpayPaymentId: razorpay_payment_id, paidAt: Date.now() });
      console.log("✅ Activation payment verified (Razorpay):", razorpay_order_id, "→", razorpay_payment_id);
      res.json({ ok: true });
    } catch (err) { console.error("❌ verify error:", err.message); res.status(500).json({ error: "Could not verify payment" }); }
  });

  router.post("/api/activation/create-phonepe-order", async (req, res) => {
    try {
      const tierKey = String((req.body && req.body.tier) || "").toUpperCase();
      const tier = TIERS[tierKey];
      if (!tier) return res.status(400).json({ error: "Unknown pricing tier" });
      const { businessName, contactName, phone } = req.body || {};
      const email = String((req.body && req.body.email) || "").trim().toLowerCase();
      if (!businessName || !email) return res.status(400).json({ error: "Business name and email are required" });

      const amountPaise = amountWithGst(tier.basePaise);
      const merchantOrderId = "ACTPP" + Date.now();
      const token = await getAuthToken();
      const ppRes = await fetch(`${baseUrl}/checkout/v2/pay`, {
        method: "POST", headers: tspHeaders(token, req),
        body: JSON.stringify({ merchantOrderId, amount: amountPaise, expireAfter: 1200, metaInfo: { udf1: "paype-activation-" + tierKey },
          paymentFlow: { type: "PG_CHECKOUT", message: "PayPe " + tier.label + " activation", merchantUrls: { redirectUrl: `${process.env.BASE_URL || ""}/activation-result.html?orderId=${merchantOrderId}` } } }),
      });
      const data = await ppRes.json();
      if (!ppRes.ok || !data.redirectUrl) { console.error("❌ activation PhonePe order failed:", data); return res.status(502).json({ error: "Could not start payment. Please try again shortly." }); }

      await db.saveActivation({ receiptId: merchantOrderId, merchantOrderId, phonepeOrderId: data.orderId, gateway: "PHONEPE", tier: tierKey, tierLabel: tier.label, amountPaise, businessName, contactName: contactName || "", email, phone: phone || "", status: "PENDING" });
      console.log("💳 Activation order created (PhonePe):", merchantOrderId, tierKey, "₹" + (amountPaise / 100).toFixed(2));
      res.json({ redirectUrl: data.redirectUrl, merchantOrderId });
    } catch (err) { console.error("❌ activation phonepe create error:", err.message); res.status(500).json({ error: "Could not start payment" }); }
  });

  router.get("/api/activation/phonepe-status/:merchantOrderId", async (req, res) => {
    try {
      const { merchantOrderId } = req.params;
      const token = await getAuthToken();
      const ppRes = await fetch(`${baseUrl}/checkout/v2/order/${merchantOrderId}/status`, {
        headers: { "Content-Type": "application/json", "Authorization": `O-Bearer ${token}`, "X-MERCHANT-ID": process.env.PHONEPE_MERCHANT_ID },
      });
      const data = await ppRes.json();
      const state = data.state;
      if (state === "COMPLETED") await db.updateActivationByReceiptId(merchantOrderId, { status: "PAID", paidAt: Date.now() });
      else if (state === "FAILED") await db.updateActivationByReceiptId(merchantOrderId, { status: "FAILED" });
      console.log("🔍 Activation status (PhonePe):", merchantOrderId, "→", state);
      res.json({ state });
    } catch (err) { console.error("❌ activation phonepe status error:", err.message); res.status(500).json({ error: "Could not check status" }); }
  });

  return router;
};

module.exports.TIERS = TIERS;
module.exports.amountWithGst = amountWithGst;
