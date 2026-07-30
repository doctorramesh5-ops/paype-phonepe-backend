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

function normalizeMode(raw) {
  const m = String(raw || "UNKNOWN").toUpperCase();
  if (m.includes("UPI")) return "UPI";
  if (m.includes("CREDIT")) return "CREDIT_CARD";
  if (m.includes("DEBIT")) return "DEBIT_CARD";
  if (m.includes("CARD")) return "CARD";
  if (m.includes("NET_BANKING") || m.includes("NETBANKING")) return "NET_BANKING";
  if (m.includes("WALLET")) return "WALLET";
  return "OTHER";
}

async function getReport(period, merchantId) {
  const d = getDb();
  if (!d) return null;
  const now = new Date();
  let rangeStart;
  if (period === "yearly") rangeStart = new Date(now.getFullYear(), 0, 1).getTime();
  else if (period === "monthly") rangeStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  else rangeStart = now.getTime() - 24 * 60 * 60 * 1000;
  let query = d.collection("orders").where("createdAt", ">=", rangeStart);
  if (merchantId) query = query.where("merchantId", "==", merchantId);
  const snap = await query.orderBy("createdAt", "desc").limit(2000).get();
  const orders = snap.docs.map((doc) => doc.data());
  const completed = orders.filter((o) => o.state === "COMPLETED");
  const byMode = {};
  for (const o of completed) {
    const mode = normalizeMode(o.paymentMode);
    if (!byMode[mode]) byMode[mode] = { mode, amount: 0, count: 0 };
    byMode[mode].amount += o.amount || 0;
    byMode[mode].count += 1;
  }
  const byPaymentMethod = Object.values(byMode).sort((a, b) => b.amount - a.amount);
  const buckets = {};
  const bucketKey = (ts) => {
    const dt = new Date(ts);
    if (period === "yearly") return dt.toLocaleDateString("en-IN", { month: "short" });
    if (period === "monthly") return String(dt.getDate());
    return dt.toLocaleTimeString("en-IN", { hour: "2-digit", hour12: false }) + ":00";
  };
  for (const o of completed) {
    const key = bucketKey(o.createdAt || rangeStart);
    if (!buckets[key]) buckets[key] = { label: key, amount: 0, count: 0 };
    buckets[key].amount += o.amount || 0;
    buckets[key].count += 1;
  }
  return {
    period, rangeStart,
    totals: { orders: orders.length, completed: completed.length, failed: orders.filter((o) => o.state === "FAILED").length, pending: orders.filter((o) => o.state === "PENDING").length, volume: completed.reduce((s, o) => s + (o.amount || 0), 0) },
    byPaymentMethod, timeline: Object.values(buckets),
  };
}
module.exports.getReport = getReport;

// ---- Platform-wide overview (admin CEO dashboard) ----
async function getPlatformOverview() {
  const d = getDb();
  if (!d) return null;
  const [merchantsSnap, ordersSnap, refundsSnap] = await Promise.all([
    d.collection("merchants").get(),
    d.collection("orders").orderBy("createdAt", "desc").limit(1000).get(),
    d.collection("refunds").orderBy("createdAt", "desc").limit(500).get(),
  ]);
  const merchants = merchantsSnap.docs.map((doc) => doc.data());
  const orders = ordersSnap.docs.map((doc) => doc.data());
  const refunds = refundsSnap.docs.map((doc) => doc.data());
  const dayMs = 86400000;
  const now = Date.now();
  const startOfToday = now - (now % dayMs);
  const completed = orders.filter((o) => o.state === "COMPLETED");
  const failed = orders.filter((o) => o.state === "FAILED");
  const pending = orders.filter((o) => o.state === "PENDING");
  const todayOrders = orders.filter((o) => (o.createdAt || 0) >= startOfToday);
  const todayCompleted = todayOrders.filter((o) => o.state === "COMPLETED");
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const dayStart = startOfToday - i * dayMs;
    const dayEnd = dayStart + dayMs;
    const dayOrders = completed.filter((o) => (o.createdAt || 0) >= dayStart && (o.createdAt || 0) < dayEnd);
    days.push({ label: new Date(dayStart).toLocaleDateString("en-IN", { weekday: "short" }), amount: dayOrders.reduce((s, o) => s + (o.amount || 0), 0), count: dayOrders.length });
  }
  const byMerchant = {};
  for (const o of completed) {
    const mid = o.merchantId || "DIRECT";
    if (!byMerchant[mid]) byMerchant[mid] = { merchantId: mid, amount: 0, count: 0 };
    byMerchant[mid].amount += o.amount || 0;
    byMerchant[mid].count += 1;
  }
  const merchantNameById = {};
  merchants.forEach((m) => { merchantNameById[m.merchantId] = m.businessName; });
  const leaderboard = Object.values(byMerchant)
    .map((m) => ({ ...m, businessName: merchantNameById[m.merchantId] || (m.merchantId === "DIRECT" ? "Direct / unattributed" : m.merchantId) }))
    .sort((a, b) => b.amount - a.amount).slice(0, 8);
  return {
    merchants: { total: merchants.length, active: merchants.filter((m) => m.status === "ACTIVE").length, suspended: merchants.filter((m) => m.status === "SUSPENDED").length },
    orders: { total: orders.length, completed: completed.length, failed: failed.length, pending: pending.length, volumeCompleted: completed.reduce((s, o) => s + (o.amount || 0), 0) },
    today: { orders: todayOrders.length, completed: todayCompleted.length, volume: todayCompleted.reduce((s, o) => s + (o.amount || 0), 0) },
    refunds: { total: refunds.length, volume: refunds.filter((r) => r.state === "COMPLETED").reduce((s, r) => s + (r.amount || 0), 0) },
    last7Days: days, leaderboard,
  };
}
module.exports.getPlatformOverview = getPlatformOverview;

function normalizeMode(raw) {
  const m = String(raw || "UNKNOWN").toUpperCase();
  if (m.includes("UPI")) return "UPI";
  if (m.includes("CREDIT")) return "CREDIT_CARD";
  if (m.includes("DEBIT")) return "DEBIT_CARD";
  if (m.includes("CARD")) return "CARD";
  if (m.includes("NET_BANKING") || m.includes("NETBANKING")) return "NET_BANKING";
  if (m.includes("WALLET")) return "WALLET";
  return "OTHER";
}

async function getReport(period, merchantId) {
  const d = getDb();
  if (!d) return null;
  const now = new Date();
  let rangeStart;
  if (period === "yearly") rangeStart = new Date(now.getFullYear(), 0, 1).getTime();
  else if (period === "monthly") rangeStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  else rangeStart = now.getTime() - 24 * 60 * 60 * 1000;
  let query = d.collection("orders").where("createdAt", ">=", rangeStart);
  if (merchantId) query = query.where("merchantId", "==", merchantId);
  const snap = await query.orderBy("createdAt", "desc").limit(2000).get();
  const orders = snap.docs.map((doc) => doc.data());
  const completed = orders.filter((o) => o.state === "COMPLETED");
  const byMode = {};
  for (const o of completed) {
    const mode = normalizeMode(o.paymentMode);
    if (!byMode[mode]) byMode[mode] = { mode, amount: 0, count: 0 };
    byMode[mode].amount += o.amount || 0;
    byMode[mode].count += 1;
  }
  const byPaymentMethod = Object.values(byMode).sort((a, b) => b.amount - a.amount);
  const buckets = {};
  const bucketKey = (ts) => {
    const dt = new Date(ts);
    if (period === "yearly") return dt.toLocaleDateString("en-IN", { month: "short" });
    if (period === "monthly") return String(dt.getDate());
    return dt.toLocaleTimeString("en-IN", { hour: "2-digit", hour12: false }) + ":00";
  };
  for (const o of completed) {
    const key = bucketKey(o.createdAt || rangeStart);
    if (!buckets[key]) buckets[key] = { label: key, amount: 0, count: 0 };
    buckets[key].amount += o.amount || 0;
    buckets[key].count += 1;
  }
  return {
    period, rangeStart,
    totals: { orders: orders.length, completed: completed.length, failed: orders.filter((o) => o.state === "FAILED").length, pending: orders.filter((o) => o.state === "PENDING").length, volume: completed.reduce((s, o) => s + (o.amount || 0), 0) },
    byPaymentMethod, timeline: Object.values(buckets),
  };
}
module.exports.getReport = getReport;

// ---- Platform settings (single document, admin-editable) ----
const SETTINGS_DOC = "platform";
async function getSettings() {
  const d = getDb();
  if (!d) return null;
  const doc = await d.collection("settings").doc(SETTINGS_DOC).get();
  return doc.exists ? doc.data() : {};
}
async function updateSettings(fields) {
  const d = getDb();
  if (!d) throw new Error("database unavailable");
  await d.collection("settings").doc(SETTINGS_DOC).set({ ...fields, updatedAt: Date.now() }, { merge: true });
}
module.exports.getSettings = getSettings;
module.exports.updateSettings = updateSettings;

// ---- Merchant deletion support ----
async function merchantHasOrders(merchantId) {
  const d = getDb();
  if (!d) return true; // fail safe: assume history exists if we cannot check
  const snap = await d.collection("orders").where("merchantId", "==", merchantId).limit(1).get();
  return !snap.empty;
}

async function hardDeleteMerchant(merchantId) {
  const d = getDb();
  if (!d) throw new Error("database unavailable");
  await d.collection("merchants").doc(merchantId).delete();
  const keys = await d.collection("apikeys").where("merchantId", "==", merchantId).get();
  const batch = d.batch();
  keys.docs.forEach((doc) => batch.delete(doc.ref));
  await batch.commit();
}

module.exports.merchantHasOrders = merchantHasOrders;
module.exports.hardDeleteMerchant = hardDeleteMerchant;
