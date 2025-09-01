const express = require('express');
const { default: makeWASocket, useMultiFileAuthState } = require('@whiskeysockets/baileys');
global.crypto = require('crypto').webcrypto;


const app = express();
app.use(express.json());

const fs = require('fs');
const path = require('path');

const sessionPath = path.join(__dirname, 'auth_info_baileys');

let sock;
let isConnected = false;

// Create WhatsApp connection
async function startSock() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

    return new Promise((resolve, reject) => {
        sock = makeWASocket({
            auth: state,
            // printQRInTerminal: true,
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                console.log('🔐 QR Generated', qr);
                resolve({ status: 'qr', data: qr });
            }

            if (connection === 'open') {
                isConnected = true;
                console.log('✅ WhatsApp connected');
                resolve({ status: 'connected' });
            }

            if (connection === 'close') {
                const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== 401;
                if (shouldReconnect) {
                    startSock();
                } else {
                    deleteSession();
                }
            }
        });

        // incoming message handler
        sock.ev.on('messages.upsert', async (m) => {
            if (m.type !== 'notify') return;
            const msg = m.messages[0];


            // ⏱️ Filter out old messages (e.g., older than 60 seconds)
            const now = Date.now();
            const messageTimestamp = msg.messageTimestamp * 1000; // convert to ms
            if ((now - messageTimestamp) > 60 * 1000) {
                console.log('⏳ Ignored old message:', new Date(messageTimestamp));
                return;
            }

            const sender = msg.key.remoteJid;
            const messageType = Object.keys(msg.message)[0];

            let text = '';
            
            if (messageType === 'conversation') {
                text = msg.message.conversation;
            } else if (messageType === 'extendedTextMessage') {
                text = msg.message.extendedTextMessage.text;
            }

            // Ignore system messages and messages sent by yourself
            if (!msg.message || msg.key.fromMe) return;

            console.log('📩 From:', sender);
            console.log('💬 Text:', text);

        });
    });
}

function deleteSession() {
    isConnected = false;
    sock = null;
    // remove session 
    const sessionDir = path.join(__dirname, 'auth_info_baileys');
    fs.rmSync(sessionDir, { recursive: true, force: true });
}

app.get('/', (req, res) => {
    return res.send('<h2>✅ Server is running.</h2>');
});

app.get('/status', (req, res) => {
    if (sock && isConnected && sock.user) {
        return res.json({
            status: 'connected',
            user: sock.user,
        });
    }

    return res.json({
        status: 'disconnected',
    });
});




// Start session and return QR
app.get('/start-session', async (req, res) => {
    if (isConnected && sock?.user) {
        return res.send('<h2>✅ WhatsApp is already connected.</h2>');
    }

    try {
        const result = await startSock();

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
                        QRCode.toCanvas(document.getElementById('qrcanvas'), qrString, function (error) {
                            if (error) console.error('QR error:', error);
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



// Send message
app.post('/send', async (req, res) => {
    const { number, message } = req.body;

    if (!isConnected || !sock) {
        return res.status(400).json({ error: 'WhatsApp is not connected' });
    }

    if (!number || !message) {
        return res.status(400).json({ error: 'Missing number or message' });
    }

    const jid = number.includes('@s.whatsapp.net') ? number : `${number}@s.whatsapp.net`;

    try {
        await sock.sendMessage(jid, { text: message });
        res.json({ success: true, to: number, message });
    } catch (err) {
        console.error('❌ Send error:', err);
        res.status(500).json({ error: err.message });
    }
});

function sleep(time = 2000) {
    return new Promise((resolve) => setTimeout(resolve, time));
}


if (fs.existsSync(sessionPath)) {
    console.log('🔍 Existing WhatsApp session found. Attempting to reconnect...');
    startSock().catch((err) => {
        console.error('❌ Failed to auto-start WhatsApp:', err);
    });
} else {
    console.log('ℹ️ No previous session found. Waiting for QR request...');
}

app.listen(3100, () => {
    console.log('🚀 Server running at http://localhost:3100');
});