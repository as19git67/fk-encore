import nodemailer from "nodemailer";

console.log("[boot] user/mail.ts: all imports resolved");

const SMTP_HOST = process.env.SMTP_HOST || "";
const SMTP_PORT = Number(process.env.SMTP_PORT || "587");
const SMTP_USER = process.env.SMTP_USER || "";
const SMTP_PASS = process.env.SMTP_PASS || "";
const SMTP_FROM = process.env.SMTP_FROM || "noreply@example.com";
const APP_URL = process.env.APP_URL || process.env.RP_ORIGIN || "http://localhost:5173";
const APP_NAME = process.env.RP_NAME || "App";

function isSmtpConfigured(): boolean {
  return !!(SMTP_HOST && SMTP_USER && SMTP_PASS);
}

let transporter: nodemailer.Transporter | null = null;

function getTransporter(): nodemailer.Transporter {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: SMTP_PORT === 465,
      auth: {
        user: SMTP_USER,
        pass: SMTP_PASS,
      },
    });
  }
  return transporter;
}

export async function sendPasswordResetEmail(email: string, token: string): Promise<void> {
  const resetLink = `${APP_URL}/app/forgot-password?token=${encodeURIComponent(token)}`;

  if (!isSmtpConfigured()) {
    console.warn(`[Mail] SMTP not configured. Reset link for ${email}: ${resetLink}`);
    return;
  }

  const html = `
    <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
      <h2>${APP_NAME} – Passwort zurücksetzen</h2>
      <p>Du hast eine Anfrage zum Zurücksetzen deines Passworts für <strong>${APP_NAME}</strong> gestellt.</p>
      <p>Klicke auf den folgenden Link, um ein neues Passwort zu setzen:</p>
      <p style="margin: 1.5em 0;">
        <a href="${resetLink}"
           style="display: inline-block; padding: 0.75em 1.5em; background: #4f46e5; color: #fff; text-decoration: none; border-radius: 6px; font-weight: 600;">
          Passwort zurücksetzen
        </a>
      </p>
      <p style="font-size: 0.85em; color: #666;">
        Dieser Link ist eine Stunde lang gültig. Falls du diese Anfrage nicht gestellt hast, kannst du diese E-Mail ignorieren.
      </p>
    </div>
  `;

  await getTransporter().sendMail({
    from: SMTP_FROM,
    to: email,
    subject: `${APP_NAME} – Passwort zurücksetzen`,
    html,
    text: `${APP_NAME} – Passwort zurücksetzen\n\nKlicke auf diesen Link: ${resetLink}\n\nDer Link ist eine Stunde gültig.`,
  });
}

export interface GuestVerifyMailParams {
  email: string;
  displayName: string;
  albumName: string;
  /** Public-link token of the album the guest registered through. */
  linkToken: string;
  /** Single-use verification token issued by register(). */
  verifyToken: string;
}

/**
 * Magic-link mail sent when a guest registers on a public album link.
 * Clicking the link verifies the guest and drops a session cookie on
 * the clicking device.
 */
export async function sendGuestVerifyEmail(params: GuestVerifyMailParams): Promise<void> {
  const verifyLink = `${APP_URL}/share/${encodeURIComponent(params.linkToken)}/guests/verify?t=${encodeURIComponent(params.verifyToken)}`;

  if (!isSmtpConfigured()) {
    console.warn(`[Mail] SMTP not configured. Guest verify link for ${params.email}: ${verifyLink}`);
    return;
  }

  const safeName = escapeHtml(params.displayName);
  const safeAlbum = escapeHtml(params.albumName);
  const html = `
    <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
      <h2>${APP_NAME} – Zugang bestätigen</h2>
      <p>Hallo ${safeName},</p>
      <p>du hast dich für das Album <strong>${safeAlbum}</strong> angemeldet. Bitte bestätige deine E-Mail-Adresse, um zu kommentieren und Benachrichtigungen zu bekommen.</p>
      <p style="margin: 1.5em 0;">
        <a href="${verifyLink}"
           style="display: inline-block; padding: 0.75em 1.5em; background: #4f46e5; color: #fff; text-decoration: none; border-radius: 6px; font-weight: 600;">
          Zugang bestätigen
        </a>
      </p>
      <p style="font-size: 0.85em; color: #666;">
        Falls du diese Anfrage nicht gestellt hast, kannst du diese E-Mail ignorieren.
      </p>
    </div>
  `;

  await getTransporter().sendMail({
    from: SMTP_FROM,
    to: params.email,
    subject: `${APP_NAME} – Zugang zum Album „${params.albumName}" bestätigen`,
    html,
    text:
      `${APP_NAME} – Zugang bestätigen\n\n` +
      `Hallo ${params.displayName},\n\n` +
      `du hast dich für das Album "${params.albumName}" angemeldet. ` +
      `Bitte bestätige deine E-Mail-Adresse über diesen Link:\n\n${verifyLink}\n\n` +
      `Falls du diese Anfrage nicht gestellt hast, kannst du diese E-Mail ignorieren.`,
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export interface GuestDigestGroup {
  albumName: string;
  /** Public-link token the mail recipient has access to. */
  albumLinkToken: string;
  newPhotos: number;
  newComments: Array<{ authorName: string; excerpt: string }>;
}

export interface GuestDigestMailParams {
  to: string;
  displayName: string;
  unsubscribeToken: string;
  groups: GuestDigestGroup[];
}

export async function sendGuestDigestEmail(params: GuestDigestMailParams): Promise<void> {
  if (params.groups.length === 0) return;

  const unsubUrl = `${APP_URL}/share/unsubscribe?t=${encodeURIComponent(params.unsubscribeToken)}`;
  const subject =
    params.groups.length === 1
      ? `${APP_NAME} – Neuigkeiten in „${params.groups[0].albumName}"`
      : `${APP_NAME} – Neuigkeiten in ${params.groups.length} geteilten Alben`;

  if (!isSmtpConfigured()) {
    console.warn(
      `[Mail] SMTP not configured. Guest digest for ${params.to} (${params.groups.length} albums) would link unsubscribe: ${unsubUrl}`,
    );
    return;
  }

  const html = renderGuestDigestHtml(params, unsubUrl);
  const text = renderGuestDigestText(params, unsubUrl);

  await getTransporter().sendMail({
    from: SMTP_FROM,
    to: params.to,
    subject,
    html,
    text,
    // RFC 8058 one-click unsubscribe. Gmail & Outlook surface a native
    // unsubscribe button when both headers are set.
    headers: {
      "List-Unsubscribe": `<${unsubUrl}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    },
  });
}

function renderGuestDigestHtml(params: GuestDigestMailParams, unsubUrl: string): string {
  const name = escapeHtml(params.displayName);
  const sections = params.groups
    .map((g) => {
      const albumUrl = `${APP_URL}/app/share/${encodeURIComponent(g.albumLinkToken)}`;
      const parts: string[] = [];
      if (g.newPhotos > 0) {
        parts.push(
          `<li>${g.newPhotos} neue${g.newPhotos === 1 ? "s" : ""} Foto${g.newPhotos === 1 ? "" : "s"}</li>`,
        );
      }
      if (g.newComments.length > 0) {
        const commentItems = g.newComments
          .slice(0, 5)
          .map(
            (c) =>
              `<li><strong>${escapeHtml(c.authorName)}:</strong> ${escapeHtml(c.excerpt)}</li>`,
          )
          .join("");
        const more =
          g.newComments.length > 5
            ? `<li style="color:#666">…und ${g.newComments.length - 5} weitere</li>`
            : "";
        parts.push(
          `<li>${g.newComments.length} neue${g.newComments.length === 1 ? "r Kommentar" : " Kommentare"}<ul>${commentItems}${more}</ul></li>`,
        );
      }
      return `
        <section style="margin: 1.2em 0; padding: 1em; background: #f7f7f9; border-radius: 8px;">
          <h3 style="margin: 0 0 .5em;">${escapeHtml(g.albumName)}</h3>
          <ul style="margin: 0 0 .8em; padding-left: 1.2em;">${parts.join("")}</ul>
          <a href="${albumUrl}" style="color: #4f46e5; font-weight: 600; text-decoration: none;">Album öffnen →</a>
        </section>`;
    })
    .join("");

  return `<div style="font-family: sans-serif; max-width: 560px; margin: 0 auto; padding: 1em; color: #222;">
  <h2 style="margin: 0 0 .5em;">Hallo ${name},</h2>
  <p style="margin: 0 0 1em;">es gibt Neuigkeiten in deinen geteilten Alben:</p>
  ${sections}
  <p style="margin: 2em 0 0; font-size: .85em; color: #666;">
    Keine Benachrichtigungen mehr? <a href="${unsubUrl}" style="color: #666;">Abmelden</a>
  </p>
</div>`;
}

function renderGuestDigestText(params: GuestDigestMailParams, unsubUrl: string): string {
  const lines: string[] = [];
  lines.push(`Hallo ${params.displayName},`);
  lines.push("");
  lines.push("es gibt Neuigkeiten in deinen geteilten Alben:");
  lines.push("");
  for (const g of params.groups) {
    lines.push(`Album „${g.albumName}"`);
    if (g.newPhotos > 0) {
      lines.push(`  ${g.newPhotos} neue${g.newPhotos === 1 ? "s Foto" : " Fotos"}`);
    }
    if (g.newComments.length > 0) {
      lines.push(
        `  ${g.newComments.length} neue${g.newComments.length === 1 ? "r Kommentar" : " Kommentare"}:`,
      );
      for (const c of g.newComments.slice(0, 5)) {
        lines.push(`    - ${c.authorName}: ${c.excerpt}`);
      }
      if (g.newComments.length > 5) {
        lines.push(`    …und ${g.newComments.length - 5} weitere`);
      }
    }
    lines.push(`  Album öffnen: ${APP_URL}/app/share/${encodeURIComponent(g.albumLinkToken)}`);
    lines.push("");
  }
  lines.push(`Abmelden: ${unsubUrl}`);
  return lines.join("\n");
}
