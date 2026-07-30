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

// ---- Merchants: PayPe's client registry ----
async function saveMerchant(merchant) {
  const d = getDb();
  if (!d) throw new Error("database unavailable");
  await d.collection("merchants").doc(merchant.merchantId).set({
    ...merchant, createdAt: Date.now(), updatedAt: Date.now(),
  });
}

async function getMerchants(limit = 200) {
  const d = getDb();
  if (!d) return [];
  const snap = await d.collection("merchants").orderBy("createdAt", "desc").limit(limit).get();
  return snap.docs.map((doc) => doc.data());
}

async function getMerchant(merchantId) {
  const d = getDb();
  if (!d) return null;
  const doc = await d.collection("merchants").doc(merchantId).get();
  return doc.exists ? doc.data() : null;
}

async function updateMerchant(merchantId, fields) {
  const d = getDb();
  if (!d) throw new Error("database unavailable");
  await d.collection("merchants").doc(merchantId).set(
    { ...fields, updatedAt: Date.now() }, { merge: true }
  );
}

module.exports.saveMerchant = saveMerchant;
module.exports.getMerchants = getMerchants;
module.exports.getMerchant = getMerchant;
module.exports.updateMerchant = updateMerchant;

// ---- Merchant sign-in support ----
// Look a merchant up by the email or mobile on their registry record.
async function getMerchantByContact(contact) {
  const d = getDb();
  if (!d) return null;
  const needle = String(contact || "").trim().toLowerCase();
  if (!needle) return null;

  const byEmail = await d.collection("merchants").where("email", "==", needle).limit(1).get();
  if (!byEmail.empty) return byEmail.docs[0].data();

  // Phones are stored as typed, so compare on digits only.
  const digits = needle.replace(/\D/g, "").slice(-10);
  if (digits.length !== 10) return null;
  const all = await d.collection("merchants").limit(500).get();
  const hit = all.docs.find((doc) => {
    const p = String(doc.data().phone || "").replace(/\D/g, "");
    return p.length >= 10 && p.slice(-10) === digits;
  });
  return hit ? hit.data() : null;
}

async function saveOtp(contact, data) {
  const d = getDb();
  if (!d) throw new Error("database unavailable");
  await d.collection("otps").doc(contact).set({ ...data, createdAt: Date.now() });
}

async function getOtp(contact) {
  const d = getDb();
  if (!d) throw new Error("database unavailable");
  const doc = await d.collection("otps").doc(contact).get();
  return doc.exists ? doc.data() : null;
}

async function bumpOtpAttempts(contact) {
  const d = getDb();
  if (!d) return;
  const ref = d.collection("otps").doc(contact);
  const doc = await ref.get();
  if (doc.exists) await ref.set({ attempts: (doc.data().attempts || 0) + 1 }, { merge: true });
}

async function deleteOtp(contact) {
  const d = getDb();
  if (!d) return;
  await d.collection("otps").doc(contact).delete();
}

// ---- Merchant-scoped listings ----
async function getOrdersForMerchant(merchantId, limit = 100) {
  const d = getDb();
  if (!d) return [];
  const snap = await d.collection("orders")
    .where("merchantId", "==", merchantId)
    .orderBy("createdAt", "desc").limit(limit).get();
  return snap.docs.map((doc) => doc.data());
}

async function getRefundsForMerchant(merchantId, limit = 100) {
  const d = getDb();
  if (!d) return [];
  const snap = await d.collection("refunds")
    .where("merchantId", "==", merchantId)
    .orderBy("createdAt", "desc").limit(limit).get();
  return snap.docs.map((doc) => doc.data());
}

module.exports.getMerchantByContact = getMerchantByContact;
module.exports.saveOtp = saveOtp;
module.exports.getOtp = getOtp;
module.exports.bumpOtpAttempts = bumpOtpAttempts;
module.exports.deleteOtp = deleteOtp;
module.exports.getOrdersForMerchant = getOrdersForMerchant;
module.exports.getRefundsForMerchant = getRefundsForMerchant;

// ---- API keys (per-merchant credentials) ----
async function saveApiKey(key) {
  const d = getDb();
  if (!d) throw new Error("database unavailable");
  await d.collection("apikeys").doc(key.keyId).set({ ...key, createdAt: Date.now(), lastUsedAt: null });
}
async function getApiKey(keyId) {
  const d = getDb();
  if (!d) throw new Error("database unavailable");
  const doc = await d.collection("apikeys").doc(keyId).get();
  return doc.exists ? doc.data() : null;
}
async function getApiKeysForMerchant(merchantId) {
  const d = getDb();
  if (!d) return [];
  const snap = await d.collection("apikeys").where("merchantId", "==", merchantId).get();
  return snap.docs.map((doc) => { const k = doc.data(); delete k.secretHash; return k; });
}
async function revokeApiKey(keyId) {
  const d = getDb();
  if (!d) throw new Error("database unavailable");
  await d.collection("apikeys").doc(keyId).set({ status: "REVOKED", revokedAt: Date.now() }, { merge: true });
}
async function touchApiKey(keyId) {
  const d = getDb();
  if (!d) return;
  await d.collection("apikeys").doc(keyId).set({ lastUsedAt: Date.now() }, { merge: true });
}
async function getRefund(merchantRefundId) {
  const d = getDb();
  if (!d) return null;
  const doc = await d.collection("refunds").doc(merchantRefundId).get();
  return doc.exists ? doc.data() : null;
}
module.exports.saveApiKey = saveApiKey;
module.exports.getApiKey = getApiKey;
module.exports.getApiKeysForMerchant = getApiKeysForMerchant;
module.exports.revokeApiKey = revokeApiKey;
module.exports.touchApiKey = touchApiKey;
module.exports.getRefund = getRefund;
