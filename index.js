const express = require('express');
require('dotenv').config();

const { ensureStarted, getStatus, hasSavedSession } = require('./whatsapp');
const { startAttendanceCron } = require('./crons/attendanceCron');
const { startUpdateRedisCacheCron } = require('./crons/updateRedisCacheCron');
const { getRedis } = require('./redisClient');

const PORT = process.env.PORT || 3300;
const app = express();
app.use(express.json());

let redis;
(async () => {
  redis = await getRedis(); // connect once at startup
})();
// ------- Routes only -------

app.get('/', (_req, res) => {
  res.send('<h2>✅ Server is running.</h2>');
});

app.get('/status', (_req, res) => {
  res.json(getStatus());
});

app.get('/start-session', async (_req, res) => {
  try {
    const result = await ensureStarted();

    if (result.status === 'connected') {
      return res.send('<h2>✅ WhatsApp is already connected.</h2>');
    }

    if (result.status === 'qr') {
      const html = `
        <html>
          <head>
            <title>Scan WhatsApp QR</title>
            <script src="https://cdn.jsdelivr.net/npm/qrcode/build/qrcode.min.js"></script>
          </head>
          <body style="text-align:center; font-family:sans-serif;">
            <h2>📱 Scan this QR Code</h2>
            <canvas id="qrcanvas"></canvas>
            <script>
              const qrString = ${JSON.stringify(result.data)};
              QRCode.toCanvas(document.getElementById('qrcanvas'), qrString, err => {
                if (err) console.error('QR error:', err);
                console.log('✅ QR rendered!');
              });
            </script>
          </body>
        </html>
      `;
      return res.send(html);
    }

    res.send('<h2>⏳ Waiting for QR Code...</h2>');
  } catch (err) {
    console.error('❌ Error initializing:', err);
    res.status(500).send(`<h2>❌ Error: ${err.message}</h2>`);
  }
});

app.post('/send', async (req, res) => {
  const { sendText, getStatus } = require('./whatsapp');
  const { number, message } = req.body;

  if (getStatus().status !== 'connected') {
    return res.status(400).json({ error: 'WhatsApp is not connected' });
  }
  if (!number || !message) {
    return res.status(400).json({ error: 'Missing number or message' });
  }

  try {
    await sendText(number, message);
    res.json({ success: true, to: number, message });
  } catch (err) {
    console.error('❌ Send error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /redis/set
// Body: { "hash": "schools", "key": "3C-61-05-11-DD-18", "value": { ... } }
app.post('/redis/set', async (req, res) => {
  try {
    const { hash, key, value } = req.body || {};

    if (!hash || typeof hash !== 'string' || !hash.trim()) {
      return res.status(400).json({ error: 'hash (hashmap name) is required' });
    }
    if (!key || typeof key !== 'string' || !key.trim()) {
      return res.status(400).json({ error: 'key (field in the hash) is required' });
    }
    if (typeof value === 'undefined') {
      return res.status(400).json({ error: 'value (object or string) is required' });
    }

    const toStore = (typeof value === 'string') ? value : JSON.stringify(value);

    // HSET returns 1 if new field created, 0 if existing field updated
    const result = await redis.hSet(hash, key, toStore);
    const created = result === 1;

    return res.json({
      ok: true,
      hash,
      key,
      created,                 // true = inserted, false = updated
      storedAs: 'json-string'  // value saved as JSON string (if object)
    });
  } catch (e) {
    console.error('POST /redis/set error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ------- Bootstrap -------

(async () => {
  if (hasSavedSession()) {
    console.log('🔍 Existing WhatsApp session found. Attempting to reconnect...');
    try { await ensureStarted(); } catch (e) { console.error('❌ Auto-start failed:', e); }
  } else {
    console.log('ℹ️ No previous session found. Start with GET /start-session to show QR.');
  }

  // start crons
  startAttendanceCron();
  startUpdateRedisCacheCron();

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server running at http://0.0.0.0:${PORT}`);
  });
})();
