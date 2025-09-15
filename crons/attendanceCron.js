const cron = require('node-cron');
const { getRedis } = require('../redisClient');
const { sendText, getStatus } = require('../whatsapp'); // use exported API
const { timeStrToSeconds, localSecondsSinceMidnight, prettyTime } = require('../utils');
require('dotenv').config();

let redis;

const inWindow = (sec, start, end) => sec >= start && sec <= end;

/** Starts the attendance processing cron */
async function startAttendanceCron() {
  if (!redis) redis = await getRedis();

  cron.schedule('* * * * *', async () => {
    console.log('⏰ Running a job every 1 minute to process attendances');

    try {
			const alreadySent = [];
      // Skip if WA disconnected (optional guard)
      if (getStatus().status !== 'connected') {
        console.log('⚠️ Skipping: WhatsApp is not connected');
        return;
      }

      let attendance;
      while ((attendance = await redis.lPop('attendances'))) {
				const attendanceObj = JSON.parse(attendance);
        console.log('📤 Processing attendance:', attendanceObj);
				if(alreadySent.includes(attendanceObj.rfid)) {
					continue;
				}
				console.log("====", attendanceObj, attendanceObj.rfid)
				alreadySent.push(attendanceObj.rfid);

				const student = await redis.hGet('students', String(attendanceObj.rfid));
				const school = await redis.hGet('schools', String(attendanceObj.mac));
				if(!student || !school) {
					console.log('❌ Skipping Attendance: Student or school not found', attendanceObj);
					continue;
				}

				const studentObj = JSON.parse(student);
				const schoolObj = JSON.parse(school);

				const ciStart = timeStrToSeconds(schoolObj.checkin_start);
				const ciEnd   = timeStrToSeconds(schoolObj.checkin_end);
				const coStart = timeStrToSeconds(schoolObj.checkout_start);
				const coEnd   = timeStrToSeconds(schoolObj.checkout_end);

				const secFromMidnight = localSecondsSinceMidnight(Number(attendanceObj?.timestamp));

				let kind = 'outside';
				if (inWindow(secFromMidnight, ciStart, ciEnd)) kind = 'checkin';
				else if (inWindow(secFromMidnight, coStart, coEnd)) kind = 'checkout';

				// Build message
				const at = prettyTime(Number(attendanceObj?.timestamp));

				let text;
				if (kind == 'checkin') {
					text = `✅ Dear ${studentObj.guardian_name}. ${studentObj.name} checked in at ${at}.`;
				} else if (kind == 'checkout') {
					text = `🏁 Dear ${studentObj.guardian_name}. ${studentObj.name} checked out at ${at}.`;
				}

				if(!text) {
					console.log('❌ Skipping Attendance: Not in check-in or check-out window', attendanceObj, secFromMidnight, ciStart, ciEnd, coStart, coEnd);
					continue;
				}

        await sendText(studentObj.guardian_contact, text);
      }

      console.log('✅ Finished processing attendances');
    } catch (err) {
      console.error('❌ Error processing attendances:', err);
    }
  });
}

module.exports = { startAttendanceCron };
