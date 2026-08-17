// ── Kinda CM Agent — Notificaciones de fallo/éxito (Email) ──────────────
// Avisa a kindamusic.mkt@gmail.com cuando el ciclo diario falla o publica,
// sin tener que entrar a revisar GitHub Actions manualmente.
//
// Requiere en config.js: gmailUser, gmailAppPassword, notifyEmailTo
// Setup: crear un App Password en https://myaccount.google.com/apppasswords
// (requiere verificación en 2 pasos activada en la cuenta de Gmail)

'use strict';
const nodemailer = require('nodemailer');
const config      = require('./config');

function getTransport() {
  if (!config.gmailUser || !config.gmailAppPassword) return null;
  return nodemailer.createTransport({
    host:   'smtp.gmail.com',
    port:   465,
    secure: true,
    auth: {
      user: config.gmailUser,
      pass: config.gmailAppPassword,
    },
  });
}

async function sendEmail(subject, html) {
  const transport = getTransport();
  const to = config.notifyEmailTo || 'kindamusic.mkt@gmail.com';

  if (!transport) {
    console.warn('[notify] Gmail no configurado (gmailUser/gmailAppPassword) — email no enviado');
    console.warn(`[notify] Hubiera enviado a ${to}: ${subject}`);
    return false;
  }

  try {
    await transport.sendMail({
      from:    `"Kinda CM Agent" <${config.gmailUser}>`,
      to,
      subject,
      html,
    });
    return true;
  } catch (e) {
    console.warn('[notify] Falló el envío de email:', e.message);
    return false;
  }
}

// ── Notificaciones específicas del agente ──────────────────────────────────

async function notifyFailure(phase, err, elapsedSec) {
  const html = `
    <h2 style="color:#c0392b;">❌ Kinda CM Agent — Ciclo falló</h2>
    <p><b>Fase:</b> ${escapeHtml(phase)}</p>
    <p><b>Error:</b> ${escapeHtml(err.message || String(err))}</p>
    <p><b>Tiempo transcurrido:</b> ${elapsedSec}s</p>
    <p>Revisa el log completo en GitHub Actions.</p>
  `;
  return sendEmail('❌ Kinda CM Agent — Ciclo falló', html);
}

async function notifySuccess({ tema, postId, tiktokPostId, elapsedSec, backlogPending }) {
  const html = `
    <h2 style="color:#27ae60;">✅ Kinda CM Agent — Post publicado</h2>
    <p><b>Tema:</b> ${escapeHtml(tema)}</p>
    <p><b>Instagram:</b> ${postId}</p>
    ${tiktokPostId ? `<p><b>TikTok:</b> ${tiktokPostId}</p>` : ''}
    <p><b>Duración:</b> ${elapsedSec}s</p>
    <p><b>Backlog pendiente:</b> ${backlogPending} ideas</p>
  `;
  return sendEmail(`✅ Kinda CM Agent — "${tema}" publicado`, html);
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

module.exports = { sendEmail, notifyFailure, notifySuccess };
