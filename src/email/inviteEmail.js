import emailjs from "@emailjs/browser";

/** Trim and strip wrapping quotes — common .env copy/paste mistakes. */
function emailJsEnv(value) {
  if (value == null || value === "") return "";
  let s = String(value).trim();
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    s = s.slice(1, -1).trim();
  }
  return s;
}

const publicKey = emailJsEnv(import.meta.env.VITE_EMAILJS_PUBLIC_KEY);
const serviceId = emailJsEnv(import.meta.env.VITE_EMAILJS_SERVICE_ID);
const templateId = emailJsEnv(import.meta.env.VITE_EMAILJS_TEMPLATE_ID);

/**
 * Candidate invite URL for emails: uses VITE_PUBLIC_APP_URL when set, else stored link.
 */
export function resolveCandidateInviteLink(testId, candidateId, fallbackLink) {
  const base = emailJsEnv(import.meta.env.VITE_PUBLIC_APP_URL);
  if (base) {
    return `${base.replace(/\/+$/, "")}?test=${encodeURIComponent(testId)}&cid=${encodeURIComponent(candidateId)}`;
  }
  return fallbackLink;
}

/** True if URL is localhost / 127.0.0.1 — not usable when emailed to another device. */
export function isUnshareableLocalLink(url) {
  if (url == null || String(url).trim() === "") return true;
  let s = String(url).trim();
  try {
    const u = new URL(s.includes("://") ? s : `http://${s}`);
    const h = u.hostname.toLowerCase();
    return h === "localhost" || h === "127.0.0.1" || h === "::1";
  } catch {
    return /localhost|127\.0\.0\.1/i.test(s);
  }
}

/** opts + link replaced by shareable URL when env is set. */
export function getShareableInviteOpts(opts) {
  const link = resolveCandidateInviteLink(opts.testId, opts.candidateId, opts.link);
  return { ...opts, link };
}

export function getInviteBlockedReason(link) {
  if (isUnshareableLocalLink(link)) {
    return (
      "This test link is localhost, which does not work on another device.\n\n" +
      "Add VITE_PUBLIC_APP_URL to .env (e.g. http://192.168.1.5:5173 or https://your-site.web.app), " +
      "restart npm run dev, then send again."
    );
  }
  return null;
}

export function isEmailJsConfigured() {
  return Boolean(publicKey && serviceId && templateId);
}

export function isProbablyValidEmail(s) {
  const t = String(s ?? "").trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t);
}

export function buildAssessmentInvitePlainBody(opts) {
  const { position, candidateName, testId, candidateId, password, link } = opts;
  const name = (candidateName && String(candidateName).trim()) || "there";
  return (
    `Hi ${name},\n\n` +
    `You've been invited to complete an online assessment${position ? ` for the ${position} role` : ""}.\n\n` +
    `Test link (open in your browser):\n${link}\n\n` +
    `Sign-in details:\n` +
    `• Candidate ID: ${candidateId}\n` +
    `• Password: ${password}\n\n` +
    `Reference — Test ID: ${testId}\n\n` +
    `On the login page, choose Candidate, enter your Candidate ID and password above. The link may fill in some fields for you.\n\n` +
    `Good luck,\nRecruitment team`
  );
}

/** Opens the user's mail app with pre-filled invitation (fallback when EmailJS is not set up). */
export function buildAssessmentInviteMailto(toEmail, opts) {
  const o = getShareableInviteOpts(opts);
  const block = getInviteBlockedReason(o.link);
  if (block) {
    return { error: block };
  }
  const to = encodeURIComponent(toEmail.trim());
  const subject = encodeURIComponent(`Assessment invitation: ${o.position || "Your test"}`);
  const body = encodeURIComponent(buildAssessmentInvitePlainBody(o));
  return { href: `mailto:${to}?subject=${subject}&body=${body}` };
}

/**
 * Sends invite via EmailJS (template must include variables: to_email, subject, message, message_html).
 * In EmailJS: set the template "To" field to {{to_email}}.
 */
export async function sendAssessmentInviteEmail(toEmail, opts) {
  if (!isEmailJsConfigured()) {
    return {
      ok: false,
      code: "NOT_CONFIGURED",
      message:
        "Direct send is not configured. Add VITE_EMAILJS_PUBLIC_KEY, VITE_EMAILJS_SERVICE_ID, and VITE_EMAILJS_TEMPLATE_ID to your .env file.",
    };
  }
  const o = getShareableInviteOpts(opts);
  const block = getInviteBlockedReason(o.link);
  if (block) {
    return { ok: false, code: "LOCAL_LINK", message: block };
  }
  const plain = buildAssessmentInvitePlainBody(o);
  const subject = `Assessment invitation: ${o.position || "Your test"}`;
  try {
    await emailjs.send(
      serviceId,
      templateId,
      {
        to_email: toEmail.trim(),
        subject,
        message: plain,
        message_html: plain.replace(/\n/g, "<br />"),
        candidate_name: (o.candidateName && String(o.candidateName).trim()) || "there",
        position: o.position || "",
        test_link: o.link,
        candidate_id: o.candidateId,
        password: o.password,
        test_id: o.testId,
      },
      { publicKey },
    );
    return { ok: true };
  } catch (err) {
    const text =
      err?.text ||
      err?.message ||
      (typeof err === "string" ? err : "") ||
      "Email could not be sent.";
    return { ok: false, code: err?.status ?? "EMAILJS_ERROR", message: text };
  }
}

export const EMAILJS_DOCS_URL = "https://www.emailjs.com/docs/";
