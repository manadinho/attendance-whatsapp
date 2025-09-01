const cron = require('node-cron');
const { getRedis } = require('../redisClient');
const { sendText, getStatus } = require('../whatsapp'); // use exported API

let redis;

/** Starts the attendance processing cron */
async function startAttendanceCron() {
  if (!redis) redis = await getRedis();

  cron.schedule('* * * * *', async () => {
    console.log('⏰ Running a job every 1 minute to process attendances');

    try {
      // Skip if WA disconnected (optional guard)
      if (getStatus().status !== 'connected') {
        console.log('⚠️ Skipping: WhatsApp is not connected');
        return;
      }

      let item;
      while ((item = await redis.lPop('attendances'))) {
        console.log('📤 Processing attendance:', item);
        await sendText('923076929940', `Attendance record: ${item}`);
      }

      console.log('✅ Finished processing attendances');
    } catch (err) {
      console.error('❌ Error processing attendances:', err);
    }
  });
}

module.exports = { startAttendanceCron };
