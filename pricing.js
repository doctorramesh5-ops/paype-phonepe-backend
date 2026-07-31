const CATEGORIES = ["ECOM", "EDUCATION", "GROCERY", "GOVT", "NBFC", "B2B"];
const CATEGORY_LABELS = {
  ECOM: "E-Com / Hotel / Travel / NGO", EDUCATION: "Education", GROCERY: "Grocery",
  GOVT: "Government", NBFC: "NBFC (Lending)", B2B: "B2B",
};
const RATES = {
  UPI:                 { ECOM:{t:"percent",v:0.30}, EDUCATION:{t:"percent",v:0.12}, GROCERY:{t:"percent",v:0.12}, GOVT:{t:"percent",v:0.00}, NBFC:{t:"percent",v:0.14}, B2B:{t:"percent",v:0.30} },
  CC_VISA:             { ECOM:{t:"percent",v:2.18}, EDUCATION:{t:"percent",v:1.12}, GROCERY:{t:"percent",v:1.53}, GOVT:{t:"percent",v:1.27}, NBFC:{t:"na"}, B2B:{t:"percent",v:2.18} },
  CC_RUPAY:            { ECOM:{t:"percent",v:2.18}, EDUCATION:{t:"percent",v:1.12}, GROCERY:{t:"percent",v:1.53}, GOVT:{t:"percent",v:1.27}, NBFC:{t:"na"}, B2B:{t:"percent",v:2.18} },
  CC_MASTER:           { ECOM:{t:"percent",v:2.18}, EDUCATION:{t:"percent",v:1.12}, GROCERY:{t:"percent",v:1.53}, GOVT:{t:"percent",v:1.27}, NBFC:{t:"na"}, B2B:{t:"percent",v:2.18} },
  CC_AMEX:             { ECOM:{t:"percent",v:3.07}, EDUCATION:{t:"percent",v:3.07}, GROCERY:{t:"percent",v:2.54}, GOVT:{t:"percent",v:1.53}, NBFC:{t:"na"}, B2B:{t:"percent",v:3.07} },
  CC_DINERS:           { ECOM:{t:"percent",v:2.30}, EDUCATION:{t:"percent",v:2.30}, GROCERY:{t:"percent",v:2.30}, GOVT:{t:"percent",v:1.53}, NBFC:{t:"na"}, B2B:{t:"percent",v:2.30} },
  CC_CORP:             { ECOM:{t:"percent",v:2.71}, EDUCATION:{t:"percent",v:1.06}, GROCERY:{t:"percent",v:1.79}, GOVT:{t:"percent",v:1.53}, NBFC:{t:"na"}, B2B:{t:"percent",v:2.71} },
  DC_RUPAY:            { ECOM:{t:"percent",v:0.30}, EDUCATION:{t:"percent",v:0.12}, GROCERY:{t:"percent",v:0.12}, GOVT:{t:"percent",v:0.00}, NBFC:{t:"percent",v:0.14}, B2B:{t:"percent",v:0.30} },
  DC_VISA_MASTER_LOW:  { ECOM:{t:"percent",v:0.47}, EDUCATION:{t:"percent",v:0.47}, GROCERY:{t:"percent",v:0.47}, GOVT:{t:"percent",v:0.47}, NBFC:{t:"percent",v:0.47}, B2B:{t:"percent",v:0.47} },
  DC_VISA_MASTER_HIGH: { ECOM:{t:"percent",v:1.06}, EDUCATION:{t:"percent",v:1.06}, GROCERY:{t:"percent",v:1.06}, GOVT:{t:"percent",v:1.06}, NBFC:{t:"percent",v:1.06}, B2B:{t:"percent",v:1.06} },
  RUPAY_CC_ON_UPI:     { ECOM:{t:"percent",v:2.30}, EDUCATION:{t:"percent",v:1.12}, GROCERY:{t:"percent",v:1.36}, GOVT:{t:"percent",v:0.94}, NBFC:{t:"na"}, B2B:{t:"percent",v:2.30} },
  PPI_ON_UPI:          { ECOM:{t:"percent",v:1.77}, EDUCATION:{t:"percent",v:1.59}, GROCERY:{t:"percent",v:1.77}, GOVT:{t:"percent",v:1.77}, NBFC:{t:"percent",v:1.77}, B2B:{t:"percent",v:1.77} },
  NET_BANKING:         { ECOM:{t:"percent",v:1.95}, EDUCATION:{t:"percent",v:1.06}, GROCERY:{t:"percent",v:1.95}, GOVT:{t:"flat",v:1298}, NBFC:{t:"flat",v:2596}, B2B:{t:"flat",v:4720} },
};
const INSTRUMENT_LABELS = {
  UPI: "UPI", CC_VISA: "Credit Card (Visa)", CC_RUPAY: "Credit Card (RuPay)",
  CC_MASTER: "Credit Card (Mastercard)", CC_AMEX: "Credit Card (Amex)",
  CC_DINERS: "Credit Card (Diners)", CC_CORP: "Credit Card (Corporate)",
  DC_RUPAY: "Debit Card (RuPay)", DC_VISA_MASTER_LOW: "Debit Card Visa/Master (< ₹2,000)",
  DC_VISA_MASTER_HIGH: "Debit Card Visa/Master (≥ ₹2,000)",
  RUPAY_CC_ON_UPI: "RuPay Credit Card on UPI", PPI_ON_UPI: "Wallet/PPI on UPI",
  NET_BANKING: "Net Banking",
};
function instrumentKeyFor(paymentMode, amountPaise, cardNetwork) {
  const mode = String(paymentMode || "").toUpperCase();
  const network = String(cardNetwork || "").toUpperCase();
  if (mode.includes("UPI")) return "UPI";
  if (mode.includes("NET_BANKING") || mode.includes("NETBANKING")) return "NET_BANKING";
  if (mode.includes("WALLET")) return "PPI_ON_UPI";
  if (mode.includes("DEBIT") || mode === "CARD_DEBIT") {
    if (network.includes("RUPAY")) return "DC_RUPAY";
    return amountPaise >= 200000 ? "DC_VISA_MASTER_HIGH" : "DC_VISA_MASTER_LOW";
  }
  if (mode.includes("CREDIT") || mode === "CARD" || mode === "CARD_CREDIT") {
    if (network.includes("AMEX")) return "CC_AMEX";
    if (network.includes("DINERS")) return "CC_DINERS";
    if (network.includes("RUPAY")) return "CC_RUPAY";
    if (network.includes("MASTER")) return "CC_MASTER";
    return "CC_VISA";
  }
  return null;
}
function calculateFee({ category, paymentMode, amountPaise, cardNetwork }) {
  if (!CATEGORIES.includes(category)) return { error: `Unknown pricing category: ${category}` };
  const instrumentKey = instrumentKeyFor(paymentMode, amountPaise, cardNetwork);
  if (!instrumentKey) return { error: `Could not map payment mode "${paymentMode}" to a rate card entry` };
  const cell = RATES[instrumentKey] && RATES[instrumentKey][category];
  if (!cell || cell.t === "na") return { error: `${INSTRUMENT_LABELS[instrumentKey] || instrumentKey} is not available for ${CATEGORY_LABELS[category]}` };
  let feePaise;
  if (cell.t === "flat") feePaise = cell.v;
  else feePaise = Math.round((amountPaise * cell.v) / 100);
  return { feePaise, netPaise: amountPaise - feePaise, rateApplied: cell, instrumentKey, instrumentLabel: INSTRUMENT_LABELS[instrumentKey], category, categoryLabel: CATEGORY_LABELS[category] };
}
function getRateCardForCategory(category) {
  const rows = Object.keys(RATES).map((key) => ({ instrument: key, label: INSTRUMENT_LABELS[key], cell: RATES[key][category] }));
  return { category, categoryLabel: CATEGORY_LABELS[category], rows };
}
function getFullRateCard() { return CATEGORIES.map((c) => getRateCardForCategory(c)); }
module.exports = { CATEGORIES, CATEGORY_LABELS, INSTRUMENT_LABELS, RATES, instrumentKeyFor, calculateFee, getRateCardForCategory, getFullRateCard };
