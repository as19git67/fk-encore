import nodemailer from "nodemailer";

const SMTP_HOST = process.env.SMTP_HOST || "";
const SMTP_PORT = Number(process.env.SMTP_PORT || "587");
const SMTP_USER = process.env.SMTP_USER || "";
const SMTP_PASS = process.env.SMTP_PASS || "";
const SMTP_FROM = process.env.SMTP_FROM || "noreply@example.com";
const APP_URL = process.env.APP_URL || process.env.RP_ORIGIN || "http://localhost:5173";

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
  const resetLink = `${APP_URL}/forgot-password?token=${encodeURIComponent(token)}`;

  if (!isSmtpConfigured()) {
    console.warn(`[Mail] SMTP not configured. Reset link for ${email}: ${resetLink}`);
    return;
  }

  const html = `
    <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
      <h2>Passwort zurücksetzen</h2>
      <p>Du hast eine Anfrage zum Zurücksetzen deines Passworts gestellt.</p>
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
    subject: "Passwort zurücksetzen",
    html,
    text: `Passwort zurücksetzen\n\nKlicke auf diesen Link: ${resetLink}\n\nDer Link ist eine Stunde gültig.`,
  });
}
