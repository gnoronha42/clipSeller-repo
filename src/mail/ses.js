import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';

const DRY_RUN = String(process.env.MAIL_DRY_RUN || 'false').toLowerCase() === 'true';
const REGION = process.env.AWS_REGION || 'us-east-1';
const FROM_ADDR = process.env.MAIL_FROM || 'no-reply@example.com';
const FROM_NAME = process.env.MAIL_FROM_NAME || 'ClipSeller';
const CONFIG_SET = (process.env.SES_CONFIGURATION_SET || '').trim();

const client = DRY_RUN
  ? null
  : new SESv2Client({
      region: REGION,
      credentials:
        process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY
          ? {
              accessKeyId: process.env.AWS_ACCESS_KEY_ID,
              secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
            }
          : undefined,
    });

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function send(to, subject, html, text) {
  if (DRY_RUN || !client) {
    console.log(`[mail][DRY] to=${to} subject="${subject}"\n${text}`);
    return;
  }
  await client.send(
    new SendEmailCommand({
      FromEmailAddress: `${FROM_NAME} <${FROM_ADDR}>`,
      ...(CONFIG_SET ? { ConfigurationSetName: CONFIG_SET } : {}),
      Destination: { ToAddresses: [to] },
      Content: {
        Simple: {
          Subject: { Data: subject, Charset: 'UTF-8' },
          Body: {
            Html: { Data: html, Charset: 'UTF-8' },
            Text: { Data: text, Charset: 'UTF-8' },
          },
        },
      },
    }),
  );
}

function renderLinkHtml({ title, greeting, intro, ctaUrl, ctaLabel, footerNote }) {
  return `<!doctype html><html lang="pt-BR"><body style="font-family:Inter,system-ui,sans-serif;background:#0a0a0e;color:#e6e6ef;padding:24px;">
  <div style="max-width:520px;margin:0 auto;background:#13131a;border-radius:18px;padding:32px;border:1px solid #1f1f2c;">
    <h1 style="margin:0 0 12px;color:#f9fafb;font-size:22px;">${escapeHtml(title)}</h1>
    <p style="color:#cbd5e1;margin:0 0 18px;">${escapeHtml(greeting)}</p>
    <p style="color:#cbd5e1;margin:0 0 24px;line-height:1.55;">${escapeHtml(intro)}</p>
    <p style="text-align:center;margin:24px 0;">
      <a href="${escapeHtml(ctaUrl)}"
         style="display:inline-block;padding:12px 24px;background:#7c3aed;color:#fff;border-radius:12px;text-decoration:none;font-weight:600;">
        ${escapeHtml(ctaLabel)}
      </a>
    </p>
    <p style="color:#94a3b8;font-size:12px;margin:24px 0 0;">${escapeHtml(footerNote)}</p>
    <p style="color:#475569;font-size:11px;margin:24px 0 0;word-break:break-all;">
      Se o botão não funcionar, copie este link no navegador:<br>${escapeHtml(ctaUrl)}
    </p>
  </div>
</body></html>`;
}

function publicUrl() {
  return (process.env.PUBLIC_URL || 'https://clipseller.com.br').replace(/\/$/, '');
}

function setPasswordLink(email, token) {
  return `${publicUrl()}/set-password.html?email=${encodeURIComponent(email)}&token=${encodeURIComponent(token)}`;
}

function formatExpiry(expiresAt) {
  try {
    return new Date(expiresAt).toLocaleString('pt-BR', {
      day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
    });
  } catch {
    return 'em breve';
  }
}

export async function sendWelcomeEmail({ to, name, token, expiresAt }) {
  const link = setPasswordLink(to, token);
  const expires = formatExpiry(expiresAt);
  const html = renderLinkHtml({
    title: 'Bem-vindo ao ClipSeller!',
    greeting: `Olá, ${name || 'membro'}!`,
    intro: 'Sua conta foi criada. Para definir sua senha de acesso, clique no botão abaixo:',
    ctaUrl: link,
    ctaLabel: 'Definir minha senha',
    footerNote: `O link expira em ${expires}. Se ele expirar, peça um novo em "Esqueci minha senha".`,
  });
  const text = `Bem-vindo ao ClipSeller!\n\nDefina sua senha em:\n${link}\n\nO link expira em ${expires}.`;
  await send(to, 'Defina sua senha de acesso ao ClipSeller', html, text);
}

export async function sendPasswordResetEmail({ to, name, token, expiresAt }) {
  const link = setPasswordLink(to, token);
  const expires = formatExpiry(expiresAt);
  const html = renderLinkHtml({
    title: 'Redefinir senha do ClipSeller',
    greeting: `Olá, ${name || 'membro'}!`,
    intro: 'Recebemos um pedido para redefinir sua senha. Clique no botão abaixo para criar uma nova:',
    ctaUrl: link,
    ctaLabel: 'Redefinir minha senha',
    footerNote: `O link expira em ${expires}. Se você não pediu este reset, ignore esta mensagem — sua senha atual continua válida.`,
  });
  const text = `Redefinir senha do ClipSeller.\n\nAcesse:\n${link}\n\nO link expira em ${expires}.`;
  await send(to, 'Redefinir sua senha do ClipSeller', html, text);
}
