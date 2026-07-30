// ============================================================
//  notify.js — outbound email and SMS
//  ----------------------------------------------------------
//  Both channels are optional. If a channel is not configured,
//  sending returns { sent:false, reason } instead of throwing,
//  so a missing SMS key can never take down merchant login.
//
//  Never log an OTP in production. The console lines below print
//  only when ALLOW_OTP_LOGGING is set, for local debugging.
// ============================================================

const nodemailer = require("nodemailer");

let mailer = null;

function emailConfigured() {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

function getMailer() {
  if (mailer) return mailer;
  if (!emailConfigured()) return null;
  mailer = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 465),
    secure: String(process.env.SMTP_SECURE || "true") === "true",
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
  return mailer;
}

async function sendEmail(to, subject, text, html) {
  const t = getMailer();
  if (!t) return { sent: false, reason: "email not configured" };
  try {
    await t.sendMail({
      from: process.env.SMTP_FROM || `PayPe <${process.env.SMTP_USER}>`,
      to,
      subject,
      text,
      html: html || undefined,
    });
    return { sent: true };
  } catch (err) {
    console.error("❌ email send failed:", err.message);
    return { sent: false, reason: err.message };
  }
}

// ---- SMS via MSG91 ----
function smsConfigured() {
  return Boolean(process.env.MSG91_AUTHKEY && process.env.MSG91_OTP_TEMPLATE_ID);
}

// MSG91 expects a 10-digit number with the country code prefixed, no plus.
function normalisePhone(phone) {
  const digits = String(phone || "").replace(/\D/g, "");
  if (digits.length === 10) return "91" + digits;
  if (digits.length === 12 && digits.startsWith("91")) return digits;
  if (digits.length === 13 && digits.startsWith("091")) return digits.slice(1);
  return null;
}

async function sendOtpSms(phone, code) {
  if (!smsConfigured()) return { sent: false, reason: "sms not configured" };
  const mobile = normalisePhone(phone);
  if (!mobile) return { sent: false, reason: "invalid phone number" };

  try {
    const res = await fetch("https://control.msg91.com/api/v5/otp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "authkey": process.env.MSG91_AUTHKEY,
      },
      body: JSON.stringify({
        template_id: process.env.MSG91_OTP_TEMPLATE_ID,
        mobile,
        otp: code,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.type === "error") {
      console.error("❌ sms send failed:", data);
      return { sent: false, reason: data.message || "MSG91 rejected the request" };
    }
    return { sent: true };
  } catch (err) {
    console.error("❌ sms send failed:", err.message);
    return { sent: false, reason: err.message };
  }
}

// ============================================================
//  Composed message: merchant sign-in code
// ============================================================
async function sendLoginCode({ email, phone, code, businessName }) {
  const results = { email: null, sms: null };

  if (email) {
    results.email = await sendEmail(
      email,
      "Your PayPe sign-in code",
      `Your PayPe sign-in code is ${code}\n\n` +
        `It expires in 10 minutes and can be used once.\n` +
        `If you did not request it, ignore this email and no one gets access.\n\n` +
        `PayPe Technologies Pvt. Ltd.`,
      `<div style="font-family:system-ui,sans-serif;max-width:440px">
         <p style="color:#544D74">Sign-in code for <strong>${businessName || "your PayPe account"}</strong></p>
         <p style="font-family:ui-monospace,monospace;font-size:32px;font-weight:600;
                   letter-spacing:.16em;color:#3E1FA0;margin:18px 0">${code}</p>
         <p style="color:#544D74;font-size:14px">Expires in 10 minutes. Can be used once.</p>
         <p style="color:#8A83A6;font-size:13px">If you did not request this, ignore it and no one gets access.</p>
         <p style="color:#8A83A6;font-size:12px;margin-top:22px">PayPe Technologies Pvt. Ltd., Coimbatore</p>
       </div>`
    );
  }

  if (phone) {
    results.sms = await sendOtpSms(phone, code);
  }

  const delivered = Boolean(
    (results.email && results.email.sent) || (results.sms && results.sms.sent)
  );

  if (!delivered && process.env.ALLOW_OTP_LOGGING === "true") {
    console.log("🔐 [dev] login code for", email || phone, "=", code);
  }

  return { delivered, results };
}

module.exports = {
  sendEmail,
  sendOtpSms,
  sendLoginCode,
  emailConfigured,
  smsConfigured,
  normalisePhone,
};
