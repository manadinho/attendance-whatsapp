require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { default: makeWASocket, useMultiFileAuthState } = require('@whiskeysockets/baileys');
global.crypto = require('crypto').webcrypto;

const sessionPath = path.join(__dirname, 'auth_info_baileys');

let sock = null;
let isConnected = false;

/** Start or resume a WhatsApp session. Resolves with {status:'qr'| 'connected', data?:qrString} */
async function startSock() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

  return new Promise((resolve, _reject) => {
    sock = makeWASocket({ auth: state /*, printQRInTerminal: true */ });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr && !isConnected) {
        console.log('🔐 QR Generated');
        return resolve({ status: 'qr', data: qr });
      }

      if (connection === 'open') {
        isConnected = true;
        console.log('✅ WhatsApp connected');
        return resolve({ status: 'connected' });
      }

      if (connection === 'close') {
        isConnected = false;
        const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== 401;
        if (shouldReconnect) {
          console.log('♻️ Reconnecting WhatsApp...');
          startSock().catch(console.error);
        } else {
          deleteSession();
        }
      }
    });

    // Incoming messages (minimal)
    sock.ev.on('messages.upsert', (m) => {
      if (m.type !== 'notify') return;
      const msg = m.messages?.[0];
      if (!msg || msg.key.fromMe || !msg.message) return;

      const tsMs = (msg.messageTimestamp || 0) * 1000;
      if (Date.now() - tsMs > 60 * 1000) return; // ignore >60s old

      const messageType = Object.keys(msg.message)[0];
      const text =
        messageType === 'conversation'
          ? msg.message.conversation
          : messageType === 'extendedTextMessage'
          ? msg.message.extendedTextMessage.text
          : '';

      console.log('📩 From:', msg.key.remoteJid, '💬', text);
    });
  });
}

function deleteSession() {
  isConnected = false;
  sock = null;
  const dir = path.join(__dirname, 'auth_info_baileys');
  fs.rmSync(dir, { recursive: true, force: true });
}

function hasSavedSession() {
  return fs.existsSync(sessionPath);
}

/** Ensure WA is started (returns {status, data?}) without forcing QR if already connected */
async function ensureStarted() {
  if (isConnected && sock?.user) return { status: 'connected' };
  return startSock();
}

/** Send a simple text message */
async function sendText(numberOrJid, text) {
  if (!isConnected || !sock) throw new Error('WhatsApp is not connected');

  const jid = numberOrJid.includes('@s.whatsapp.net')
    ? numberOrJid
    : `${numberOrJid}@s.whatsapp.net`;

  return sock.sendMessage(jid, { text });
}

function getStatus() {
  if (isConnected && sock?.user) {
    return { status: 'connected', user: sock.user };
  }
  return { status: 'disconnected' };
}

module.exports = {
  ensureStarted,
  startSock,
  sendText,
  getStatus,
  hasSavedSession,
};
