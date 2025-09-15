const express = require('express');
require('dotenv').config();

const { ensureStarted, getStatus, hasSavedSession } = require('./whatsapp');
const { startAttendanceCron } = require('./crons/attendanceCron');
const { startUpdateRedisCacheCron } = require('./crons/updateRedisCacheCron');

const PORT = process.env.PORT || 3300;
const app = express();
app.use(express.json());

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
