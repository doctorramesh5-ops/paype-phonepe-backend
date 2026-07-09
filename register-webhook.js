// One-time script: registers our webhook URL with PhonePe.
// Run with:  node register-webhook.js
require("dotenv").config();

const WEBHOOK_URL = "https://paype-phonepe-backend.vercel.app/api/phonepe-webhook";

async function main() {
  // 1. Get auth token (same as server.js)
  const tokenRes = await fetch(`${process.env.PHONEPE_BASE_URL}/v1/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.PHONEPE_CLIENT_ID,
      client_version: process.env.PHONEPE_CLIENT_VERSION,
      client_secret: process.env.PHONEPE_CLIENT_SECRET,
      grant_type: "client_credentials",
    }),
  });
  const tokenData = await tokenRes.json();
  if (!tokenData.access_token) {
    console.error("❌ Auth failed:", tokenData);
    return;
  }
  console.log("✅ Got auth token");

  // 2. Register the webhook
  const res = await fetch(`${process.env.PHONEPE_BASE_URL}/configs/v1/webhooks`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `O-Bearer ${tokenData.access_token}`,
    },
    body: JSON.stringify({
      url: WEBHOOK_URL,
      username: process.env.WEBHOOK_USERNAME,
      password: process.env.WEBHOOK_PASSWORD,
      events: [
        "checkout.order.completed",
        "checkout.order.failed",
        "pg.refund.completed",
        "pg.refund.failed",
      ],
      description: "PayPe UAT webhook",
    }),
  });

  const data = await res.json();
  console.log("📋 PhonePe response:", JSON.stringify(data, null, 2));
  if (data.id) console.log("🎉 Webhook registered! ID:", data.id);
}

main();
