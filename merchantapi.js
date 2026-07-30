// ============================================================
//  merchantapi.js — PayPe's authenticated merchant API (v1)
//  ----------------------------------------------------------
//  Everything here requires a valid API key. The merchant is
//  taken from the key, never from the request body, and every
//  record is checked for ownership before it is read or changed.
//
//  Written as a factory so it shares the single cached gateway
//  token from server.js rather than opening a second one.
// ============================================================

const express = require("express");
const db = require("./db");
const { requireMerchantKey, ownsRecord } = require("./apikeys");

module.exports = function merchantApi(gw) {
  const router = express.Router();
  const { getAuthToken, tspHeaders, baseUrl } = gw;

  // Every route below is guarded.
  router.use("/api/v1", requireMerchantKey);

  // ----------------------------------------------------------
  //  GET /api/v1/me — let a merchant verify their keys work
  // ----------------------------------------------------------
  router.get("/api/v1/me", (req, res) => {
    res.json({
      merchantId: req.merchant.merchantId,
      businessName: req.merchant.businessName,
      domain: req.merchant.domain,
      environment: req.apiKey.env,
    });
  });

  // ----------------------------------------------------------
  //  POST /api/v1/payments — create a payment
  // ----------------------------------------------------------
  router.post("/api/v1/payments", async (req, res) => {
    try {
      const amountRupees = Number(req.body.amount);
      if (!amountRupees || amountRupees <= 0) {
        return res.status(400).json({ error: "amount must be a positive number of rupees" });
      }

      // A merchant may supply their own order reference.
      let merchantOrderId = (req.body.merchantOrderId || "").trim();
      if (merchantOrderId) {
        if (merchantOrderId.length > 62 || !/^[A-Za-z0-9_-]+$/.test(merchantOrderId)) {
          return res.status(400).json({
            error: "merchantOrderId must be under 63 characters, letters/numbers/-/_ only",
          });
        }
        // Reject a reused ID rather than silently creating a duplicate charge.
        const existing = await db.getOrder(merchantOrderId);
        if (existing) {
          return res.status(409).json({ error: "merchantOrderId already used" });
        }
      } else {
        merchantOrderId = "PAYPE" + Date.now();
      }

      const amountPaise = Math.round(amountRupees * 100);
      const token = await getAuthToken();

      // The merchant's own MID and domain — from the registry, via the key.
      const overrides = { mid: req.merchant.mid, domain: req.merchant.domain };

      const redirectUrl =
        (req.body.redirectUrl || "").trim() ||
        `${process.env.BASE_URL || ""}/result.html?orderId=${merchantOrderId}`;

      // A merchant-supplied redirect must point at their own registered domain,
      // otherwise a stolen key could send paying customers to an attacker's site.
      if (req.body.redirectUrl && !redirectUrl.startsWith(req.merchant.domain)) {
        return res.status(400).json({
          error: "redirectUrl must begin with your registered domain",
          registeredDomain: req.merchant.domain,
        });
      }

      const ppRes = await fetch(`${baseUrl}/checkout/v2/pay`, {
        method: "POST",
        headers: tspHeaders(token, req, overrides),
        body: JSON.stringify({
          merchantOrderId,
          amount: amountPaise,
          expireAfter: 1200,
          metaInfo: { udf1: req.merchant.merchantId },
          paymentFlow: {
            type: "PG_CHECKOUT",
            message: "Payment to " + req.merchant.businessName,
            merchantUrls: { redirectUrl },
          },
        }),
      });

      const data = await ppRes.json();
      if (!ppRes.ok || !data.redirectUrl) {
        console.error("❌ v1 pay failed:", data);
        return res.status(502).json({ error: "Gateway rejected the payment", details: data });
      }

      await db.saveOrder({
        merchantOrderId,
        phonepeOrderId: data.orderId,
        amount: amountPaise,
        state: "PENDING",
        merchantId: req.merchant.merchantId,
        merchantName: req.merchant.businessName,
        source: "api",
      });

      console.log("💳 v1 payment:", merchantOrderId, "for", req.merchant.merchantId);
      res.status(201).json({ merchantOrderId, redirectUrl: data.redirectUrl, amount: amountPaise });
    } catch (err) {
      console.error("❌ v1 create error:", err.message);
      res.status(500).json({ error: "Could not create payment" });
    }
  });

  // ----------------------------------------------------------
  //  GET /api/v1/payments/:merchantOrderId — status
  // ----------------------------------------------------------
  router.get("/api/v1/payments/:merchantOrderId", async (req, res) => {
    try {
      const { merchantOrderId } = req.params;
      const order = await db.getOrder(merchantOrderId);

      // Not yours, or not real — same answer either way.
      if (!ownsRecord(req, order)) {
        return res.status(404).json({ error: "Order not found" });
      }

      const token = await getAuthToken();
      const ppRes = await fetch(`${baseUrl}/checkout/v2/order/${merchantOrderId}/status`, {
        headers: {
          "Content-Type": "application/json",
          "Authorization": `O-Bearer ${token}`,
          "X-MERCHANT-ID": req.merchant.mid,
        },
      });
      const data = await ppRes.json();
      if (data.state) await db.updateOrder(merchantOrderId, { state: data.state });

      res.json({
        merchantOrderId,
        state: data.state,
        amount: order.amount,
        orderId: data.orderId || order.phonepeOrderId,
        paymentDetails: data.paymentDetails || [],
      });
    } catch (err) {
      console.error("❌ v1 status error:", err.message);
      res.status(500).json({ error: "Could not fetch order status" });
    }
  });

  // ----------------------------------------------------------
  //  POST /api/v1/refunds — refund, with the three checks
  // ----------------------------------------------------------
  router.post("/api/v1/refunds", async (req, res) => {
    try {
      const merchantOrderId = (req.body.merchantOrderId || "").trim();
      const amountPaise = Math.round(Number(req.body.amount) * 100);

      if (!merchantOrderId || !amountPaise || amountPaise <= 0) {
        return res.status(400).json({ error: "merchantOrderId and a positive amount are required" });
      }

      const order = await db.getOrder(merchantOrderId);
      if (!ownsRecord(req, order)) {
        return res.status(404).json({ error: "Order not found" });
      }
      if (order.state !== "COMPLETED") {
        return res.status(400).json({
          error: `Order state is ${order.state} - only COMPLETED orders can be refunded`,
        });
      }

      const previous = await db.getRefundsForOrder(merchantOrderId);
      if (previous === null) {
        // Fail closed: if we cannot verify history, we do not move money.
        return res.status(503).json({ error: "Refund history unavailable - try again shortly" });
      }
      const alreadyRefunded = previous
        .filter((r) => r.state !== "FAILED")
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

      const merchantRefundId = "REFUND" + Date.now();
      const token = await getAuthToken();

      const ppRes = await fetch(`${baseUrl}/payments/v2/refund`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `O-Bearer ${token}`,
          "X-MERCHANT-ID": req.merchant.mid,
        },
        body: JSON.stringify({
          merchantRefundId,
          originalMerchantOrderId: merchantOrderId,
          amount: amountPaise,
        }),
      });

      const data = await ppRes.json();
      if (!ppRes.ok) {
        console.error("❌ v1 refund failed:", data);
        return res.status(502).json({ error: "Gateway rejected the refund", details: data });
      }

      await db.saveRefund({
        merchantRefundId,
        originalMerchantOrderId: merchantOrderId,
        amount: amountPaise,
        state: data.state || "PENDING",
        phonepeRefundId: data.refundId,
        merchantId: req.merchant.merchantId,
      });

      console.log("💸 v1 refund:", merchantRefundId, "for", req.merchant.merchantId);
      res.status(201).json({
        merchantRefundId,
        amount: amountPaise,
        state: data.state || "PENDING",
      });
    } catch (err) {
      console.error("❌ v1 refund error:", err.message);
      res.status(500).json({ error: "Could not create refund" });
    }
  });

  // ----------------------------------------------------------
  //  GET /api/v1/refunds/:merchantRefundId — refund status
  // ----------------------------------------------------------
  router.get("/api/v1/refunds/:merchantRefundId", async (req, res) => {
    try {
      const { merchantRefundId } = req.params;
      const refund = await db.getRefund(merchantRefundId);
      if (!ownsRecord(req, refund)) {
        return res.status(404).json({ error: "Refund not found" });
      }

      const token = await getAuthToken();
      const ppRes = await fetch(
        `${baseUrl}/payments/v2/refund/${merchantRefundId}/status`,
        {
          headers: {
            "Content-Type": "application/json",
            "Authorization": `O-Bearer ${token}`,
            "X-MERCHANT-ID": req.merchant.mid,
          },
        }
      );
      const data = await ppRes.json();
      if (data.state) await db.updateRefund(merchantRefundId, { state: data.state });

      res.json({
        merchantRefundId,
        state: data.state,
        amount: refund.amount,
        originalMerchantOrderId: refund.originalMerchantOrderId,
        splitInstruments: data.splitInstruments || [],
      });
    } catch (err) {
      console.error("❌ v1 refund status error:", err.message);
      res.status(500).json({ error: "Could not fetch refund status" });
    }
  });

  return router;
};
