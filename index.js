/**
 * Asoltu notify server — email / SMS / WhatsApp / FCM HTTP API.
 *
 * Privileged credentials stay on this host. Flutter never sees
 * RESEND_API_KEY or Firebase Admin keys.
 *
 * Env:
 *   PORT
 *   ERP_COMMS_API_KEY          (required in production)
 *   EMAIL_FROM
 *   RESEND_API_KEY             (preferred)
 *   SENDGRID_API_KEY           (optional)
 *   SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASS / SMTP_SECURE
 *   FIREBASE_SERVICE_ACCOUNT_B64   (preferred, Admin SDK JSON base64)
 *   FIREBASE_SERVICE_ACCOUNT_JSON  (raw JSON string)
 */
const http = require("http");
const nodemailer = require("nodemailer");
const admin = require("firebase-admin");

const PORT = Number(process.env.PORT || 8787);
const API_KEY = (process.env.ERP_COMMS_API_KEY || process.env.ERP_UPLOAD_API_KEY || "").trim();
const EMAIL_FROM =
  process.env.EMAIL_FROM || "Asoltu School ERP <noreply@asoltuschool.com>";

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, body) {
  const raw = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, X-Api-Key, X-ERP-Upload-Key",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  });
  res.end(raw);
}

function authorized(req) {
  if (!API_KEY) return process.env.NODE_ENV !== "production";
  const key =
    req.headers["x-api-key"] ||
    req.headers["x-erp-upload-key"] ||
    "";
  return key === API_KEY;
}

function isPlaceholder(value) {
  const v = String(value || "").trim().toUpperCase();
  return !v || v.includes("YOUR_") || v.includes("PLACEHOLDER");
}

async function sendEmail({ to, subject, text, html }) {
  const resend = process.env.RESEND_API_KEY || "";
  if (resend && !isPlaceholder(resend) && resend.startsWith("re_")) {
    const from = process.env.EMAIL_FROM || "Asoltu School ERP <onboarding@resend.dev>";
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resend}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: [to],
        subject,
        text: text || subject,
        html: html || undefined,
      }),
    });
    const body = await res.text();
    if (!res.ok) throw new Error(`Resend ${res.status}: ${body}`);
    let id = `re_${Date.now()}`;
    try {
      const parsed = JSON.parse(body);
      if (parsed.id) id = parsed.id;
    } catch (_) {}
    return { id, provider: "resend", delivered: true };
  }

  const sendgrid = process.env.SENDGRID_API_KEY || process.env.EMAIL_API_KEY || "";
  if (sendgrid && !isPlaceholder(sendgrid) && sendgrid.startsWith("SG.")) {
    const res = await fetch("https://api.sendgrid.com/v3/mail/send", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${sendgrid}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: to }] }],
        from: { email: EMAIL_FROM.includes("<") ? "noreply@asoltuschool.com" : EMAIL_FROM },
        subject,
        content: [
          { type: "text/plain", value: text || subject },
          { type: "text/html", value: html || text || subject },
        ],
      }),
    });
    if (!res.ok) throw new Error(`SendGrid ${res.status}: ${await res.text()}`);
    return { id: `sg_${Date.now()}`, provider: "sendgrid" };
  }

  const host = process.env.SMTP_HOST || "";
  const user = process.env.SMTP_USER || "";
  const pass = process.env.SMTP_PASS || "";
  if (host && user && pass && !isPlaceholder(pass)) {
    const transporter = nodemailer.createTransport({
      host,
      port: Number(process.env.SMTP_PORT || 587),
      secure: process.env.SMTP_SECURE === "true",
      auth: { user, pass },
    });
    const info = await transporter.sendMail({
      from: EMAIL_FROM,
      to,
      subject,
      text,
      html,
    });
    return { id: info.messageId || `smtp_${Date.now()}`, provider: "smtp" };
  }

  console.warn("[notify] no SMTP/SendGrid — accepted but not delivered", { to, subject });
  return { id: `queued_${Date.now()}`, provider: "queued", delivered: false };
}

function fcmReady() {
  if (admin.apps.length) return true;
  try {
    const rawJson = (process.env.FIREBASE_SERVICE_ACCOUNT_JSON || "").trim();
    const rawB64 = (process.env.FIREBASE_SERVICE_ACCOUNT_B64 || "").trim();
    let creds = null;
    if (rawJson) {
      creds = JSON.parse(rawJson);
    } else if (rawB64) {
      creds = JSON.parse(Buffer.from(rawB64, "base64").toString("utf8"));
    }
    if (creds && creds.client_email && creds.private_key) {
      admin.initializeApp({ credential: admin.credential.cert(creds) });
      console.info("[notify] Firebase Admin initialized for FCM");
      return true;
    }
    if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
      admin.initializeApp({ credential: admin.credential.applicationDefault() });
      console.info("[notify] Firebase Admin initialized via ADC");
      return true;
    }
  } catch (e) {
    console.error("[notify] Firebase Admin init failed:", e.message || e);
  }
  return false;
}

function asStringMap(obj) {
  const out = {};
  if (!obj || typeof obj !== "object") return out;
  for (const [k, v] of Object.entries(obj)) {
    if (v == null) continue;
    if (typeof v === "object") continue;
    out[String(k)] = String(v);
  }
  return out;
}

async function collectTokens(userIds, schoolId) {
  const tokens = [];
  const db = admin.firestore();
  for (const uid of userIds) {
    if (!uid) continue;
    const snap = await db.collection("users").doc(uid).collection("tokens").get();
    for (const doc of snap.docs) {
      const data = doc.data() || {};
      const token = String(data.token || doc.id || "").trim();
      if (!token) continue;
      const tokenSchool = String(data.schoolId || data.tenantId || "").trim();
      if (schoolId && tokenSchool && tokenSchool !== schoolId) continue;
      tokens.push(token);
    }
    if (snap.empty) {
      const user = await db.collection("users").doc(uid).get();
      const fallback = String((user.data() || {}).fcmToken || "").trim();
      if (fallback) tokens.push(fallback);
    }
  }
  return [...new Set(tokens)];
}

async function sendFcm(body) {
  if (!fcmReady()) {
    console.warn("[notify] FCM skipped — Firebase Admin credentials missing");
    return {
      id: `fcm_unconfigured_${Date.now()}`,
      provider: "fcm",
      delivered: false,
      error: "firebase_admin_unconfigured",
    };
  }

  const data = body.data && typeof body.data === "object" ? body.data : {};
  const userIds = [];
  if (Array.isArray(data.userIds)) {
    for (const id of data.userIds) userIds.push(String(id));
  }
  if (body.to) userIds.push(String(body.to).trim());
  const uniqueIds = [...new Set(userIds.filter(Boolean))];
  if (!uniqueIds.length) {
    return {
      id: `fcm_norecipients_${Date.now()}`,
      provider: "fcm",
      delivered: false,
      error: "no_recipients",
    };
  }

  const title = String(body.subject || "Asoltu School ERP");
  const text = String(body.text || "");
  const schoolId = String(body.schoolId || data.schoolId || "").trim();
  const type = String(body.type || data.type || "general");
  const deepLink = String(data.deepLink || "");

  let tokens = [];
  try {
    tokens = await collectTokens(uniqueIds, schoolId);
  } catch (e) {
    console.error("[notify] FCM token lookup failed:", e.message || e);
    return {
      id: `fcm_lookup_${Date.now()}`,
      provider: "fcm",
      delivered: false,
      error: "token_lookup_failed",
    };
  }

  if (!tokens.length) {
    console.info("[notify] FCM no tokens", { users: uniqueIds.length, schoolId, type });
    return {
      id: `fcm_notokens_${Date.now()}`,
      provider: "fcm",
      delivered: false,
      error: "no_tokens",
    };
  }

  const payloadData = asStringMap({
    type,
    title,
    body: text,
    message: text,
    schoolId,
    deepLink,
    relatedUserId: data.relatedUserId || "",
    serverPersisted: "true",
  });

  try {
    const result = await admin.messaging().sendEachForMulticast({
      tokens,
      notification: { title, body: text },
      data: payloadData,
      android: { priority: "high" },
      apns: {
        headers: { "apns-priority": "10" },
        payload: { aps: { sound: "default", badge: 1 } },
      },
    });
    console.info("[notify] FCM", {
      type,
      schoolId,
      tokens: tokens.length,
      success: result.successCount,
      failure: result.failureCount,
    });
    return {
      id: `fcm_${Date.now()}`,
      provider: "fcm",
      delivered: result.successCount > 0,
      successCount: result.successCount,
      failureCount: result.failureCount,
    };
  } catch (e) {
    console.error("[notify] FCM send failed:", e.message || e);
    return {
      id: `fcm_error_${Date.now()}`,
      provider: "fcm",
      delivered: false,
      error: "send_failed",
    };
  }
}

async function handleNotify(body) {
  const channel = String(body.channel || "email").toLowerCase();
  const to = String(body.to || "").trim();
  const subject = String(body.subject || "Asoltu School ERP");
  const text = String(body.text || "");
  const html = body.html ? String(body.html) : undefined;

  if (channel === "fcm" || channel === "push") {
    return sendFcm(body);
  }

  if (!to) {
    const err = new Error("to is required");
    err.status = 400;
    throw err;
  }
  if (channel === "email") {
    return sendEmail({ to, subject, text, html });
  }
  // SMS / WhatsApp: accept and log until provider keys are set on this host.
  console.info("[notify] accepted", { channel, to, subject });
  return { id: `${channel}_${Date.now()}`, provider: channel, delivered: false };
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    sendJson(res, 204, {});
    return;
  }
  const url = new URL(req.url || "/", "http://localhost");
  if (req.method === "GET" && (url.pathname === "/health" || url.pathname === "/")) {
    sendJson(res, 200, {
      ok: true,
      service: "asoltu-notify",
      firebase: false,
      fcm: Boolean(
        process.env.FIREBASE_SERVICE_ACCOUNT_B64 ||
          process.env.FIREBASE_SERVICE_ACCOUNT_JSON ||
          process.env.GOOGLE_APPLICATION_CREDENTIALS
      ),
      swappable: true,
    });
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/notify") {
    if (!authorized(req)) {
      sendJson(res, 401, { error: "unauthorized" });
      return;
    }
    try {
      const body = await readJson(req);
      const result = await handleNotify(body);
      sendJson(res, 200, { ok: true, ...result });
    } catch (e) {
      sendJson(res, e.status || 500, { error: e.message || String(e) });
    }
    return;
  }
  sendJson(res, 404, { error: "not found" });
});

server.listen(PORT, () => {
  console.log(`[asoltu-notify] listening on :${PORT}`);
});
