
require('dotenv').config();
const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, downloadContentFromMessage, isJidGroup, isJidBroadcast, isJidStatusBroadcast, isJidNewsletter, extractMessageContent, getContentType } = require('@whiskeysockets/baileys');
global.crypto = require('crypto').webcrypto;
const bus = require('./eventBus');
const path = require('path');
const fs   = require('fs');
const { isValidSid, fetchImageBuffer } = require('./utils');
const rules = JSON.parse(fs.readFileSync(path.join(__dirname, '/rules/rules.json')));
const ruleMethods = require('./rules/ruleMethods');
const SESSIONS_FILE = process.env.SESSIONS_FILE || path.join(__dirname, 'sessions.txt');

let SESSION_IDS = readSessionIdsFromFile(SESSIONS_FILE);

const app = express();
app.use(express.json());

// === multi-session config ===
const SESSION_PREFIX = 'auth_info_baileys';  // base name; real folder is `${SESSION_PREFIX}_${sid}`

const PORT = process.env.PORT || 3200;

const Sessions = {};
const StartLocks = new Map(); // sid -> Promise in-flight
let GEN_COUNTER = 0;

function getSes(sid) {
  if (!sid || !Sessions[sid]) throw new Error(`Unknown session: ${sid}`);
  return Sessions[sid];
}

// ===== WhatsApp connection per session =====
async function startSockFor(sid) {
  // fast guard: if already connected/starting, don’t start again
  if (Sessions[sid]?.sock && (Sessions[sid].isConnected || Sessions[sid].connecting)) {
    return { status: Sessions[sid].isConnected ? 'connected' : (Sessions[sid].lastQR ? 'qr' : 'starting') };
  }

  // serialize: one startup per sid
  if (StartLocks.has(sid)) {
    await StartLocks.get(sid);
    const ses = Sessions[sid];
    return { status: ses?.isConnected ? 'connected' : (ses?.lastQR ? 'qr' : 'starting') };
  }

  let resolveLock;
  const lockP = new Promise(r => (resolveLock = r));
  StartLocks.set(sid, lockP);

  const authFolder = `${SESSION_PREFIX}_${sid}`;
  const { state, saveCreds } = await useMultiFileAuthState(authFolder);
  const version = [2, 3000, 1027934701];

  const myGen = ++GEN_COUNTER; // mark this start attempt

  const sock = makeWASocket({
    version,
    auth: state,
    // printQRInTerminal: true,
  });

  Sessions[sid] = Sessions[sid] || {};
  const ses = Sessions[sid];
  ses.sock = sock;
  ses.isConnected = false;
  ses.connecting = true;     // <— mark as connecting
  ses.saveCreds = saveCreds;
  ses.generation = myGen;    // <— who owns event handlers
  ses.lastQR = ses.lastQR || null;

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    // ignore stale events from older sockets
    if (Sessions[sid]?.generation !== myGen) return;

    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      ses.lastQR = qr;
      console.log(`[${sid}] 🔐 QR generated`);
    }

    if (connection === 'open') {
      ses.isConnected = true;
      ses.connecting = false;
      ses.user = sock.user;
      console.log(`[${sid}] ✅ WhatsApp connected as`, sock.user);
      return;
    }

    if (connection === 'close') {
      ses.isConnected = false;
      ses.connecting = false;

      const err  = lastDisconnect?.error;
      const code = err?.output?.statusCode;
      const type =
        err?.data?.content?.[0]?.attrs?.type ||
        err?.output?.payload?.type ||
        undefined;

      // DO NOT RECONNECT on 401 (device removed) or 440 (replaced/conflict)
      const shouldReconnect = !(code === 401 || code === 440 || type === 'replaced' || type === 'conflict');

      console.log(`[${sid}] ⚠️ Disconnected code=${code}, type=${type || '-'}, reconnect=${shouldReconnect}`);

      if (!shouldReconnect) {
        // leave creds for 440; wipe on 401
        if (code === 401) await deleteSessionFor(sid);
        return;
      }

      // only the latest generation is allowed to reconnect
      setTimeout(() => {
        if (Sessions[sid]?.generation === myGen) {
          startSockFor(sid).catch(() => {});
        }
      }, 2000);
    }
  });

  // Optional: your messages.upsert code here, but also guard by generation if needed
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

        await runActionsForMatchedRule(sid,matchedRule, msg).catch(console.error);
    }
  });

  // release the start lock
  resolveLock();
  StartLocks.delete(sid);

  return { status: ses.isConnected ? 'connected' : (ses.lastQR ? 'qr' : 'starting') };
}

async function runActionsForMatchedRule(sid, matchedRule, message) {
    const ctx = {
        sid,
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



async function deleteSessionFor(sid, { removeAuth = true } = {}) {
  try {
    const ses = Sessions[sid];
    if (ses?.sock) {
      // best-effort shut down without exploding if already closed
      try {
        // only call logout when the link is alive
        if (ses.isConnected && typeof ses.sock.logout === 'function') {
          await Promise.race([
            ses.sock.logout(),
            new Promise(r => setTimeout(r, 3000)) // don’t hang forever
          ]);
        }
      } catch (e) {
        // ignore “Connection Closed” / Boom errors
      }
      try { ses.sock.ws?.close?.(); } catch {}
      try { ses.sock.end?.(); } catch {}
    }
  } catch {}
  try {
    if (removeAuth) {
      const authFolder = `${SESSION_PREFIX}_${sid}`;
      fs.rmSync(authFolder, { recursive: true, force: true });
    }
  } catch {}
  delete Sessions[sid];
}

// ===== routes =====
app.get('/', (req, res) => {
  return res.send('<h2>✅ Server is running.</h2>');
});



async function ensureSidInSessionsFile(sid) {
  if (!isValidSid(sid)) throw new Error('Invalid sid: only letters, numbers, _ and - allowed');

  // read + normalize list
  let current = [];
  try {
    const raw = await fs.promises.readFile(SESSIONS_FILE, 'utf8');
    current = raw.split(/\r?\n/).map(s => s.trim()).filter(s => s && !s.startsWith('#'));
  } catch {
    // check if file missing
    try {
      await fs.promises.access(SESSIONS_FILE);
    } catch {
      // create empty file
      await fs.promises.writeFile(SESSIONS_FILE, '', 'utf8');
    }
    current = [];
  }

  if (!current.includes(sid)) {
    // append with newline; create file if missing
    await fs.promises.appendFile(SESSIONS_FILE, (current.length ? '\n' : '') + sid + '\n', 'utf8');
  }
}

function readSessionIdsFromFile(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const ids = raw
      .split(/\r?\n/)
      .map(s => s.trim())
      .filter(s => s && !s.startsWith('#'))
      // keep only sane ids: letters/numbers/_/-
      .filter(s => /^[A-Za-z0-9_-]+$/.test(s));

    // de-dup while preserving order
    const seen = new Set();
    return ids.filter(id => (seen.has(id) ? false : (seen.add(id), true)));
  } catch (e) {
    return [];
  }
}

/** Send a simple text message */
async function sendText(sid, numberOrJid, text) {
  const ses = getSes(sid);
  if (!ses.isConnected || !ses.sock) throw new Error('WhatsApp is not connected');

  const jid = numberOrJid.includes('@s.whatsapp.net')
    ? numberOrJid
    : `${numberOrJid}@s.whatsapp.net`;

  return ses.sock.sendMessage(jid, { text });
}

// --- Session-aware endpoints ---
app.get('/:sid/start-session', async (req, res) => {
    const sid = req.params.sid;
    if (!isValidSid(sid)) {
        return res.json({ success: false, message: '<h2>❌ Invalid sid. Use letters, numbers, _ or - only.</h2>', data: {} });
    }

  try {
    await ensureSidInSessionsFile(sid);
    if (!Sessions[sid]?.isConnected) {
      await startSockFor(sid);
    }
    const ses = Sessions[sid];
    if (ses?.isConnected && ses?.sock?.user) {
        return res.json({ status: 'connected', data: {user: ses?.sock?.user} })
    }
    const qr = ses?.lastQR;
    return res.json({ status: 'disconnected', data: { qr:JSON.stringify(qr || 'waiting')} });
  } catch (err) {
    return res.json({ status: 'error', message: `<h2>❌ Error: ${err.message}</h2>`, data: {} });
  }
});

app.get('/:sid/status', (req, res) => {
  const sid = req.params.sid;
  const ses = Sessions[sid];
  if (!ses) return res.json({ status: 'not_initialized', sid });
  if (ses.isConnected && ses.sock) {
    return res.json({ status: 'connected', user: ses.user, sid });
  }
  return res.json({ status: 'disconnected', sid, lastQR: ses.lastQR || null });
});

app.get('/:sid/destroy-session', async (req, res) => {
    const sid = req.params.sid;
    try {
        deleteSessionFor(sid);
        return res.json({ success: true, message: `✅ Session ${sid} ended and data deleted.` });
    } catch (err) {
        return res.json({ success: false, message: `❌ Error ending session ${sid}: ${err.message}` });
    }
});



app.post('/:sid/send', async (req, res) => {
  const sid = req.params.sid;
  try {
    const ses = getSes(sid);
    if (!ses.isConnected || !ses.sock) return res.status(400).json({ error: 'WhatsApp is not connected' });
    
    const { number, message, imageUrl } = req.body;
    
    if (!number) return res.status(400).json({ error: 'Missing number' });
    
    const jid = number.includes('@s.whatsapp.net') ? number : `${number}@s.whatsapp.net`;

    // If imageUrl is provided, send image message
    if (imageUrl) {
      let imageBuffer;
      
      // Try HTTPS first, then HTTP fallback
      try {
        imageBuffer = await fetchImageBuffer(imageUrl, imageUrl.replace(/^https:\/\//i, 'http://'));
      } catch (error) {
        console.error(`[${sid}] ❌ Failed to fetch image:`, error.message);
        return res.status(400).json({ error: 'Failed to fetch image from URL' });
      }

      if (!imageBuffer) {
        return res.status(400).json({ error: 'Could not retrieve image from URL' });
      }

      await ses.sock.sendMessage(jid, {
        image: imageBuffer,
        caption: message || '',
        mimetype: 'image/jpeg' // You might want to detect this dynamically
      });
      
      return res.json({ 
        success: true, 
        sid, 
        to: number, 
        type: 'image',
        caption: message || '',
        imageUrl: imageUrl 
      });
    }
    
    // Otherwise send text message
    if (!message) return res.status(400).json({ error: 'Missing message for text message' });
    
    await ses.sock.sendMessage(jid, { text: message });
    return res.json({ success: true, sid, to: number, type: 'text', message });
    
  } catch (err) {
    console.error(`[${sid}] send error`, err);
    return res.status(500).json({ error: err.message });
  }
});

app.post('/:sid/send-attendance-messages', async (req, res) => {
    // check x-den-api-key header
    const apiKey = req.headers['x-den-api-key'];
    if (apiKey !== process.env.DEN_API_KEY) {
        return res.json({ success: false, message: 'Forbidden: Invalid API Key', data: {} });
    }
    const sid = req.params.sid;
    try {
        const ses = getSes(sid);
        if (!ses.isConnected || !ses.sock) return res.json({ success: false, message: 'WhatsApp is not connected=====', data: {} });
        const { messages } = req.body;
        if (!Array.isArray(messages) || messages.length === 0) {
            return res.json({success: false, message: 'Missing or invalid messages array', data: {} });
        }

        handleAttendanceMessageSending(sid, ses, messages);
        
        return res.json({ success: true, message: 'Messages sent successfully', data: {} });
    } catch (err) {
        console.error(`[${sid}] send error`, err);
        return res.status(500).json({ error: err.message });
    }
});

async function handleAttendanceMessageSending(sid, ses, messages) {
    for (const msgObj of messages) {
        const { phoneNumber, message } = msgObj;
        if (!phoneNumber || !message) {
            console.warn(`[${sid}] Skipping invalid message object:`, msgObj);
            continue;
        }
        const jid = phoneNumber.includes('@s.whatsapp.net') ? phoneNumber : `${phoneNumber}@s.whatsapp.net`;
        await ses.sock.sendMessage(jid, { text: message });
        
        // dynamic wait 20–50 seconds
        const waitTime = Math.floor(Math.random() * 30) + 20;
        console.log(`[${sid}] ==Waiting:`, waitTime);
        await new Promise(resolve => setTimeout(resolve, waitTime * 1000));
    }
}


bus.on('whatsapp:sendText', async ({ sid, to, text }) => {
    try {
        await sendText(sid, to, text);
        console.log(`✅ Sent message to ${to}`);
    } catch (err) {
        console.error(`❌ Failed to send message to ${to}:`, err);
    }
});



// ===== Boot: try to auto-start both sessions if auth folders exist =====
(async () => {
  for (const sid of SESSION_IDS) {
    const authDir = `${SESSION_PREFIX}_${sid}`;
    if (fs.existsSync(path.join(__dirname, authDir))) {
      console.log(`[${sid}] 🔍 Existing session found. Attempting to reconnect...`);
      startSockFor(sid).catch(err => console.error(`[${sid}] ❌ Auto-start failed`, err));
    } else {
      console.log(`[${sid}] ℹ️ No previous session found. Open /${sid}/start-session to scan QR.`);
    }
  }
})();

app.listen(PORT, '0.0.0.0', () => {
  console.log('🚀 Server running at http://localhost:' + PORT);
});

