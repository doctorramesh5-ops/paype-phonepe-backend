// PayPe x PhonePe TSP — Payment Server v3
require("dotenv").config();
const express = require("express");
const crypto = require("crypto");
const path = require("path");
const db = require("./db");
const admin = require("./admin");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));
app.use(admin);

const {
  PHONEPE_CLIENT_ID, PHONEPE_CLIENT_VERSION, PHONEPE_CLIENT_SECRET,
  PHONEPE_MERCHANT_ID, PHONEPE_BASE_URL, MERCHANT_DOMAIN, PORT = 3000,
} = process.env;

// AUTH TOKEN (cached, refreshed ~4 min before expiry)
let cachedToken = null;
let tokenExpiresAt = 0;

async function getAuthToken() {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && now < tokenExpiresAt - 240) return cachedToken;
  const res = await fetch(`${PHONEPE_BASE_URL}/v1/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: PHONEPE_CLIENT_ID,
      client_version: PHONEPE_CLIENT_VERSION,
      client_secret: PHONEPE_CLIENT_SECRET,
      grant_type: "client_credentials",
    }),
  });
  const data = await res.json();
  if (!res.ok || !data.access_token) {
    console.error("❌ Auth failed:", data);
    throw new Error("PhonePe auth token request failed");
  }
  cachedToken = data.access_token;
  tokenExpiresAt = data.expires_at;
  console.log("✅ Got new PhonePe auth token");
  return cachedToken;
}

function tspHeaders(token, req, overrides = {}) {
  return {
    "Content-Type": "application/json",
    "Authorization": `O-Bearer ${token}`,
    "X-MERCHANT-ID": overrides.mid || PHONEPE_MERCHANT_ID,
    "X-SOURCE": "API",
    "X-SOURCE-CHANNEL": "web",
    "X-BROWSER-FINGERPRINT": crypto.createHash("md5")
      .update((req && req.headers["user-agent"]) || "paype-server").digest("hex"),
    "USER-AGENT": (req && req.headers["user-agent"]) || "PayPe-Server",
    "X-MERCHANT-DOMAIN": MERCHANT_DOMAIN,
    "X-MERCHANT-IP": (req && req.ip) || "127.0.0.1",
    "X-SOURCE-REDIRECTION-TYPE": "MERCHANT_REDIRECTION",
  };
}

// CREATE PAYMENT — saves order as PENDING in Firestore
app.post("/api/create-payment", async (req, res) => {
  try {
    const amountRupees = Number(req.body.amount);
    if (!amountRupees || amountRupees <= 0) {
      return res.status(400).json({ error: "Please send a valid amount" });
    }
    // ===== DYNAMIC MERCHANT: the registry drives the payment =====
    const requestedMerchant = (req.body.merchantId || "").trim();
    let overrides = {};
    let merchantRecord = null;
    if (requestedMerchant) {
      merchantRecord = await db.getMerchant(requestedMerchant);
      if (!merchantRecord) {
        return res.status(404).json({ error: "Unknown merchant" });
      }
      if (merchantRecord.status !== "ACTIVE") {
        return res.status(403).json({ error: "Merchant is suspended" });
      }
      overrides = { mid: merchantRecord.mid, domain: merchantRecord.domain };
    }

    const token = await getAuthToken();
    const merchantOrderId = "PAYPE" + Date.now();
    const amountPaise = Math.round(amountRupees * 100);

    const payload = {
      merchantOrderId,
      amount: amountPaise,
      expireAfter: 1200,
      metaInfo: { udf1: "paype-order" },
      paymentFlow: {
        type: "PG_CHECKOUT",
        message: "PayPe payment",
        merchantUrls: {
          redirectUrl: `${process.env.BASE_URL || "http://localhost:" + PORT}/result.html?orderId=${merchantOrderId}`,
        },
      },
    };

    const ppRes = await fetch(`${PHONEPE_BASE_URL}/checkout/v2/pay`, {
      method: "POST",
      headers: tspHeaders(token, req, overrides),
      body: JSON.stringify(payload),
    });
    const data = await ppRes.json();
    console.log("💳 Create payment:", merchantOrderId, "→", data.state || data);

    if (!ppRes.ok || !data.redirectUrl) {
      return res.status(502).json({ error: "PhonePe pay API failed", details: data });
    }

    await db.saveOrder({
      merchantOrderId,
      phonepeOrderId: data.orderId,
      amount: amountPaise,
      state: "PENDING",
      merchantId: requestedMerchant || "DIRECT",
      merchantName: merchantRecord ? merchantRecord.businessName : "PayPe direct",
    });

    res.json({ merchantOrderId, redirectUrl: data.redirectUrl });
  } catch (err) {
    console.error("❌ create-payment error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Shared: fetch status from PhonePe, update DB (root-level state only)
async function fetchAndStoreOrderStatus(merchantOrderId) {
  const token = await getAuthToken();
  const ppRes = await fetch(
    `${PHONEPE_BASE_URL}/checkout/v2/order/${merchantOrderId}/status`,
    {
      headers: {
        "Content-Type": "application/json",
        "Authorization": `O-Bearer ${token}`,
        "X-MERCHANT-ID": PHONEPE_MERCHANT_ID,
      },
    }
  );
  const data = await ppRes.json();
  const state = data.state;
  if (state) await db.updateOrder(merchantOrderId, { state });
  return data;
}

app.get("/api/order-status/:merchantOrderId", async (req, res) => {
  try {
    const data = await fetchAndStoreOrderStatus(req.params.merchantOrderId);
    console.log("🔍 Order status:", req.params.merchantOrderId, "→", data.state);
    res.json(data);
  } catch (err) {
    console.error("❌ order-status error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// RECONCILIATION — external cron calls this every minute
app.get("/api/reconcile", async (req, res) => {
  if (req.query.key !== process.env.RECONCILE_SECRET) {
    return res.status(401).json({ error: "unauthorized" });
  }
  try {
    const pending = await db.getPendingOrders();
    const results = [];
    for (const order of pending) {
      const data = await fetchAndStoreOrderStatus(order.merchantOrderId);
      results.push({ merchantOrderId: order.merchantOrderId, state: data.state });
      console.log("🔁 Reconcile:", order.merchantOrderId, "→", data.state);
    }
    res.json({ checked: results.length, results });
  } catch (err) {
    console.error("❌ reconcile error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// WEBHOOK — authenticated: Authorization = SHA256(username:password)
app.post("/api/phonepe-webhook", async (req, res) => {
  const expected = crypto.createHash("sha256")
    .update(`${process.env.WEBHOOK_USERNAME}:${process.env.WEBHOOK_PASSWORD}`)
    .digest("hex");
  const received = (req.headers["authorization"] || "")
    .replace(/^SHA256\s*/i, "").trim();

  if (received.toLowerCase() !== expected.toLowerCase()) {
    console.log("🚫 Webhook REJECTED: credentials did not match");
    return res.status(401).json({ error: "unauthorized" });
  }

  const event = req.body.event;
  const payload = req.body.payload || {};
  const state = payload.state;
  console.log("🔔 VERIFIED webhook:", event, "→", payload.merchantOrderId || payload.merchantRefundId, state);

  try {
    if (event && event.startsWith("checkout.order") && payload.merchantOrderId) {
      await db.updateOrder(payload.merchantOrderId, { state, lastWebhookEvent: event });
    }
    if (event && event.startsWith("pg.refund") && payload.merchantRefundId) {
      await db.updateRefund(payload.merchantRefundId, { state, lastWebhookEvent: event });
    }
  } catch (err) {
    console.error("⚠️ webhook DB update failed:", err.message);
  }

  res.status(200).json({ received: true });
});

// REFUND — POST /payments/v2/refund
app.post("/api/refund", async (req, res) => {
  try {
    const { merchantOrderId, amount } = req.body;
    const amountPaise = Math.round(Number(amount) * 100);
    if (!merchantOrderId || !amountPaise || amountPaise <= 0) {
      return res.status(400).json({ error: "merchantOrderId and valid amount required" });
    }

    // ===== VALIDATION: never trust input, verify our own records =====
    // Rule 1: the order must exist in OUR database
    const order = await db.getOrder(merchantOrderId);
    if (!order) {
      return res.status(404).json({ error: "Order not found in our records" });
    }
    // Rule 2: only COMPLETED orders can be refunded
    if (order.state !== "COMPLETED") {
      return res.status(400).json({ error: `Order state is ${order.state} - only COMPLETED orders can be refunded` });
    }
    // Rule 3: total refunds must never exceed the order amount
    const previousRefunds = await db.getRefundsForOrder(merchantOrderId);
    if (previousRefunds === null) {
      // fail CLOSED: if we cannot verify, we do not move money
      return res.status(503).json({ error: "Refund history unavailable - try again shortly" });
    }
    const alreadyRefunded = previousRefunds
      .filter(r => r.state !== "FAILED")
      .reduce((sum, r) => sum + (r.amount || 0), 0);
    const remaining = order.amount - alreadyRefunded;
    if (amountPaise > remaining) {
      return res.status(400).json({
        error: "Refund exceeds refundable balance",
        orderAmount: order.amount,
        alreadyRefunded,
        remainingRefundable: remaining,
      });
    }
    // ===== validation passed - proceed =====

    const token = await getAuthToken();
    const merchantRefundId = "REFUND" + Date.now();

    const ppRes = await fetch(`${PHONEPE_BASE_URL}/payments/v2/refund`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `O-Bearer ${token}`,
        "X-MERCHANT-ID": PHONEPE_MERCHANT_ID,
      },
      body: JSON.stringify({
        merchantRefundId,
        originalMerchantOrderId: merchantOrderId,
        amount: amountPaise,
      }),
    });
    const data = await ppRes.json();
    console.log("💸 Refund initiated:", merchantRefundId, "→", data.state || data);

    if (!ppRes.ok) {
      return res.status(502).json({ error: "PhonePe refund API failed", details: data });
    }

    await db.saveRefund({
      merchantRefundId,
      originalMerchantOrderId: merchantOrderId,
      amount: amountPaise,
      state: data.state || "PENDING",
      phonepeRefundId: data.refundId,
    });

    res.json({ merchantRefundId, ...data });
  } catch (err) {
    console.error("❌ refund error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/refund-status/:merchantRefundId", async (req, res) => {
  try {
    const token = await getAuthToken();
    const ppRes = await fetch(
      `${PHONEPE_BASE_URL}/payments/v2/refund/${req.params.merchantRefundId}/status`,
      {
        headers: {
          "Content-Type": "application/json",
          "Authorization": `O-Bearer ${token}`,
          "X-MERCHANT-ID": PHONEPE_MERCHANT_ID,
        },
      }
    );
    const data = await ppRes.json();
    if (data.state) await db.updateRefund(req.params.merchantRefundId, { state: data.state });
    console.log("🔍 Refund status:", req.params.merchantRefundId, "→", data.state);
    res.json(data);
  } catch (err) {
    console.error("❌ refund-status error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log("\n🚀 PayPe server v3 running → http://localhost:" + PORT + "\n");
  });
}
module.exports = app;
