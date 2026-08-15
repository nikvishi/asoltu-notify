/**
 * Asoltu notify server — email / SMS / WhatsApp HTTP API.
 *
 * Firebase is not used. Swap this host later by changing ERP_COMMS_BASE_URL
 * (or Super Admin → Communication → Notify / email server URL).
 *
 * Env:
 *   PORT
 *   ERP_COMMS_API_KEY          (required in production)
 *   EMAIL_FROM
 *   RESEND_API_KEY             (preferred)
 *   SENDGRID_API_KEY           (optional)
 *   SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASS / SMTP_SECURE
 */
const http = require("http");
const nodemailer = require("nodemailer");

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

async function handleNotify(body) {
  const channel = String(body.channel || "email").toLowerCase();
  const to = String(body.to || "").trim();
  const subject = String(body.subject || "Asoltu School ERP");
  const text = String(body.text || "");
  const html = body.html ? String(body.html) : undefined;
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
