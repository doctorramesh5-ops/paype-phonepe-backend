// db.js — PayPe's memory (Firestore database)
const admin = require("firebase-admin");
let db = null;

function getDb() {
  if (db) return db;
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) {
    console.warn("⚠️  FIREBASE_SERVICE_ACCOUNT not set — database features disabled");
    return null;
  }
  const serviceAccount = JSON.parse(raw);
  if (!admin.apps.length) {
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  }
  db = admin.firestore();
  return db;
}

async function saveOrder(order) {
  const d = getDb();
  if (!d) return;
  await d.collection("orders").doc(order.merchantOrderId).set({
    ...order, createdAt: Date.now(), updatedAt: Date.now(),
  });
}

async function updateOrder(merchantOrderId, fields) {
  const d = getDb();
  if (!d) return;
  await d.collection("orders").doc(merchantOrderId).set(
    { ...fields, updatedAt: Date.now() }, { merge: true }
  );
}

async function getPendingOrders() {
  const d = getDb();
  if (!d) return [];
  const cutoff = Date.now() - 22 * 60 * 1000;
  const snap = await d.collection("orders")
    .where("state", "==", "PENDING")
    .where("createdAt", ">", cutoff).get();
  return snap.docs.map((doc) => doc.data());
}

async function saveRefund(refund) {
  const d = getDb();
  if (!d) return;
  await d.collection("refunds").doc(refund.merchantRefundId).set({
    ...refund, createdAt: Date.now(), updatedAt: Date.now(),
  });
}

async function updateRefund(merchantRefundId, fields) {
  const d = getDb();
  if (!d) return;
  await d.collection("refunds").doc(merchantRefundId).set(
    { ...fields, updatedAt: Date.now() }, { merge: true }
  );
}

module.exports = { saveOrder, updateOrder, getPendingOrders, saveRefund, updateRefund };

// ---- Admin dashboard queries (newest first) ----
async function getRecentOrders(limit = 100) {
  const d = getDb();
  if (!d) return [];
  const snap = await d.collection("orders").orderBy("createdAt", "desc").limit(limit).get();
  return snap.docs.map((doc) => doc.data());
}

async function getRecentRefunds(limit = 100) {
  const d = getDb();
  if (!d) return [];
  const snap = await d.collection("refunds").orderBy("createdAt", "desc").limit(limit).get();
  return snap.docs.map((doc) => doc.data());
}

module.exports.getRecentOrders = getRecentOrders;
module.exports.getRecentRefunds = getRecentRefunds;

// ---- Refund validation lookups ----
async function getOrder(merchantOrderId) {
  const d = getDb();
  if (!d) return null;
  const doc = await d.collection("orders").doc(merchantOrderId).get();
  return doc.exists ? doc.data() : null;
}

async function getRefundsForOrder(merchantOrderId) {
  const d = getDb();
  if (!d) return null; // null = "database unavailable", different from [] = "no refunds"
  const snap = await d.collection("refunds")
    .where("originalMerchantOrderId", "==", merchantOrderId).get();
  return snap.docs.map((doc) => doc.data());
}

module.exports.getOrder = getOrder;
module.exports.getRefundsForOrder = getRefundsForOrder;
