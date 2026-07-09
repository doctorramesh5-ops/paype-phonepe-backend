// ============================================================
//  PayPe x PhonePe TSP — UAT Test Server
//  ----------------------------------------------------------
//  This is your backend. It does 4 jobs:
//    1. Get an auth token from PhonePe        (getAuthToken)
//    2. Create a payment                       (POST /api/create-payment)
//    3. Check payment status                   (GET  /api/order-status/...)
//    4. Receive webhook updates from PhonePe   (POST /api/phonepe-webhook)
//
//  Why a backend at all? Because the clientSecret must NEVER
//  be visible in the browser. The browser talks to THIS server,
//  and this server talks to PhonePe.
// ============================================================

require("dotenv").config();          // loads the .env file into process.env
const express = require("express"); // the web server framework
const crypto = require("crypto");   // built-in, used for browser fingerprint
const path = require("path");
const app = express();
app.use(express.json());            // lets us read JSON sent by the browser
app.use(express.static(path.join(__dirname, "public")));  // serves the checkout page (public folder)

// ---- Read credentials from .env (never hard-code secrets) ----
const {
  PHONEPE_CLIENT_ID,
  PHONEPE_CLIENT_VERSION,
  PHONEPE_CLIENT_SECRET,
  PHONEPE_MERCHANT_ID,
  PHONEPE_BASE_URL,
  MERCHANT_DOMAIN,
  PORT = 3000,
} = process.env;

// ============================================================
//  STEP 1 — AUTH TOKEN
//  PhonePe docs: POST /v1/oauth/token (form-urlencoded)
//  The token is reusable until "expires_at", so we cache it.
// ============================================================
let cachedToken = null;
let tokenExpiresAt = 0; // epoch seconds

async function getAuthToken() {
  const now = Math.floor(Date.now() / 1000);

  // Reuse the cached token if it's still valid (with a 120s safety margin)
  if (cachedToken && now < tokenExpiresAt - 120) {
    return cachedToken;
  }

  const body = new URLSearchParams({
    client_id: PHONEPE_CLIENT_ID,
    client_version: PHONEPE_CLIENT_VERSION,
    client_secret: PHONEPE_CLIENT_SECRET,
    grant_type: "client_credentials",
  });

  const res = await fetch(`${PHONEPE_BASE_URL}/v1/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  const data = await res.json();
  if (!res.ok || !data.access_token) {
    console.error("❌ Auth failed:", data);
    throw new Error("PhonePe auth token request failed");
  }

  cachedToken = data.access_token;
  tokenExpiresAt = data.expires_at;
  console.log("✅ Got new PhonePe auth token (valid until", new Date(tokenExpiresAt * 1000).toLocaleString(), ")");
  return cachedToken;
}

// ============================================================
//  TSP HEADERS
//  PhonePe TSP docs: these headers are MANDATORY on /checkout/v2/pay
//  In production, X-MERCHANT-ID becomes each real client's MID.
// ============================================================
function tspHeaders(token, req) {
  return {
    "Content-Type": "application/json",
    "Authorization": `O-Bearer ${token}`,
    "X-MERCHANT-ID": PHONEPE_MERCHANT_ID,
    "X-SOURCE": "API",
    "X-SOURCE-CHANNEL": "web",
    "X-BROWSER-FINGERPRINT": crypto
      .createHash("md5")
      .update(req.headers["user-agent"] || "unknown")
      .digest("hex"),
    "USER-AGENT": req.headers["user-agent"] || "PayPe-UAT-Test",
    "X-MERCHANT-DOMAIN": MERCHANT_DOMAIN,
    "X-MERCHANT-IP": req.ip || "127.0.0.1",
    "X-SOURCE-REDIRECTION-TYPE": "MERCHANT_REDIRECTION",
  };
}

// ============================================================
//  STEP 2 — CREATE PAYMENT
//  Browser sends { amount } in rupees → we convert to paise,
//  call PhonePe /checkout/v2/pay, and return their redirectUrl.
// ============================================================
app.post("/api/create-payment", async (req, res) => {
  try {
    const amountRupees = Number(req.body.amount);
    if (!amountRupees || amountRupees <= 0) {
      return res.status(400).json({ error: "Please send a valid amount" });
    }

    const token = await getAuthToken();

    // Every order needs a unique ID — we generate one with the time
    const merchantOrderId = "PAYPE" + Date.now();

    const payload = {
      merchantOrderId,
      amount: Math.round(amountRupees * 100), // PhonePe wants PAISE (₹10 = 1000)
      expireAfter: 1200,                      // order valid for 20 minutes
      metaInfo: { udf1: "paype-uat-test" },
      paymentFlow: {
        type: "PG_CHECKOUT",
        message: "PayPe UAT test payment",
        merchantUrls: {
          // Where PhonePe sends the customer AFTER payment
          // BASE_URL comes from Vercel settings once deployed; falls back to localhost
          redirectUrl: `${process.env.BASE_URL || "http://localhost:" + PORT}/result.html?orderId=${merchantOrderId}`,
        },
      },
    };

    const ppRes = await fetch(`${PHONEPE_BASE_URL}/checkout/v2/pay`, {
      method: "POST",
      headers: tspHeaders(token, req),
      body: JSON.stringify(payload),
    });

    const data = await ppRes.json();
    console.log("💳 Create payment response:", JSON.stringify(data, null, 2));

    if (!ppRes.ok || !data.redirectUrl) {
      return res.status(502).json({ error: "PhonePe pay API failed", details: data });
    }

    // Send PhonePe's checkout page URL back to the browser
    res.json({ merchantOrderId, redirectUrl: data.redirectUrl });
  } catch (err) {
    console.error("❌ create-payment error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  STEP 3 — ORDER STATUS
//  Docs: GET /checkout/v2/order/{merchantOrderId}/status
//  Only Authorization + X-MERCHANT-ID headers are needed here.
// ============================================================
app.get("/api/order-status/:merchantOrderId", async (req, res) => {
  try {
    const token = await getAuthToken();
    const { merchantOrderId } = req.params;

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
    console.log("🔍 Order status:", merchantOrderId, "→", data.state);
    res.json(data);
  } catch (err) {
    console.error("❌ order-status error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  STEP 4 — WEBHOOK RECEIVER
//  PhonePe will POST payment updates here (once you register
//  this URL using their Create Webhook API). For now we just
//  log whatever arrives and reply 200 OK.
// ============================================================
app.post("/api/phonepe-webhook", (req, res) => {
  // SECURITY GUARD: is this knock really from PhonePe?
  // PhonePe sends Authorization = SHA256 hash of "username:password"
  const expected = crypto
    .createHash("sha256")
    .update(`${process.env.WEBHOOK_USERNAME}:${process.env.WEBHOOK_PASSWORD}`)
    .digest("hex");

  const received = (req.headers["authorization"] || "")
    .replace(/^SHA256\s*/i, "")
    .trim();

  if (received.toLowerCase() !== expected.toLowerCase()) {
    console.log("🚫 Webhook REJECTED: credentials did not match");
    return res.status(401).json({ error: "unauthorized" });
  }

  console.log("🔔 VERIFIED webhook from PhonePe:");
  console.log(JSON.stringify(req.body, null, 2));
  res.status(200).json({ received: true });
});

// ---- Start the server ----
// On your MacBook: this starts listening on port 3000.
// On Vercel: Vercel imports the app itself, so we just export it.
if (require.main === module) {
  app.listen(PORT, () => {
    console.log("");
    console.log("🚀 PayPe UAT server running → http://localhost:" + PORT);
    console.log("   Open that link in your browser to see the test checkout.");
    console.log("");
  });
}
module.exports = app;
