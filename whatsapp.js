require('dotenv').config();
const fs = require('fs');
const path = require('path');
const bus = require('./eventBus');
const { default: makeWASocket, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const rules = JSON.parse(fs.readFileSync(path.join(__dirname, '/rules/rules.json')));
const ruleMethods = require('./rules/ruleMethods');
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
    sock.ev.on('messages.upsert', async (m) => {
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

			// Look for matching rule
			const matchedRule = rules.find(rule =>
					rule.enabled === true &&
					rule.operand === '=' &&
					rule.value === text.toLocaleLowerCase()
			);

			if (matchedRule) {
				// mark as seen
				await sock.readMessages([msg.key]);
				
				// await sock.sendPresenceUpdate('composing', sender); // send typing indicator
				// await sleep(3000); // simulate typing delay
				// await sock.sendPresenceUpdate('paused', sender); // stop typing indicator

				await runActionsForMatchedRule(matchedRule, msg).catch(console.error);
			}
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

async function runActionsForMatchedRule(matchedRule, message) {
	const ctx = {
		message,
		senderPhone: (message.key.remoteJid || '').replace(/@s\.whatsapp\.net$/, ''),
	};

	for (const action of matchedRule.actions || []) {
		if (action.type !== 'ruleMethod') continue;

		const fn = ruleMethods[action.name];
		if (typeof fn !== 'function') {
			console.warn(`Unknown ruleMethod: ${action.name}`);
			continue;
		}

		const params = resolveParams('', action.params || {}, ctx);
		await fn(ctx, params);
	}
}

function resolveParams(key, params, context) {
  if (params && typeof params === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(params)) out[k] = resolveParams(k, v, context);
    return out;
  }
  return interpolate(key, params, context);
}

function interpolate(key, value, context) {
  if (key == 'text') return value;
	if(key == 'sender') return context.senderPhone;
  return "";
}

// Listen for sendText events
bus.on('whatsapp:sendText', async ({ to, text }) => {
	try {
		await sendText(to, text);
		console.log(`✅ Sent message to ${to}`);
	} catch (err) {
		console.error(`❌ Failed to send message to ${to}:`, err);
	}
});

module.exports = {
  ensureStarted,
  startSock,
  sendText,
  getStatus,
  hasSavedSession,
};
