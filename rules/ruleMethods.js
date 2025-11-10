// ruleMethods.js
const bus = require('.././eventBus');

module.exports = {
  async subOrUnsubToWhatsapp(ctx, { sid, text, sender }) {
    // Basic validation
    if (!sender) {
      console.error('sender is required');
      return false;
    };

    // Make API request to update subscription status
    const res = await fetch(process.env.PORTAL_BASE_URL + `/update-is-on-whatsapp/${sender}/${text}`, {
      headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer test`
      }
    });

    // Check for HTTP errors
    if (!res.ok) {
      console.error('HTTP error:', res.status, res.statusText);
      return false;
    }

    // Reply to user based on action
    if (text === '1') {
      if (ctx.message?.key?.remoteJid) {
        bus.emit('whatsapp:sendText', { sid: ctx.sid, to: ctx.message.key.remoteJid, text: 'You are now subscribed ✅' });
      } else {
        console.log(`✅ Subscribed ${sender}`);
      }
    } else if (text === '0') {
      if (ctx.message?.key?.remoteJid) {
        bus.emit('whatsapp:sendText', { sid: ctx.sid, to: ctx.message.key.remoteJid, text: 'You are unsubscribed ✅' });
      } else {
        console.log(`✅ Unsubscribed ${sender}`);
      }
    } else {
      throw new Error('text must be "1" or "0"');
    }
  },
};