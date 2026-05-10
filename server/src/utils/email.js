const { Resend } = require('resend')

const resend   = new Resend(process.env.RESEND_API_KEY)
const FROM     = process.env.EMAIL_FROM || 'noreply@flinther.com'
const CLUB_URL = process.env.FRONTEND_URL || 'http://localhost:5173'

function fmtTime(t) {
  const [h, m] = t.substring(0, 5).split(':').map(Number)
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`
}

function fmtDate(d) {
  return new Date(d.slice(0, 10) + 'T12:00:00').toLocaleDateString('en-AU', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  })
}

function card(content) {
  return `
    <div style="font-family:sans-serif;max-width:500px;margin:0 auto;padding:32px 24px;background:#fff;">
      ${content}
      <p style="color:#aaa;font-size:12px;margin-top:32px;">
        Questions? Just reply to this email or visit <a href="${CLUB_URL}" style="color:#000;">${CLUB_URL.replace(/^https?:\/\//, '')}</a>.
      </p>
    </div>
  `
}

// ── Booking confirmation ────────────────────────────────────────────────────
async function sendBookingConfirmation({ to, name, date, start_time, end_time }) {
  if (!to || !process.env.RESEND_API_KEY) return
  try {
    await resend.emails.send({
      from: FROM,
      to,
      subject: `Booking confirmed – ${fmtDate(date)}`,
      html: card(`
        <h2 style="font-size:20px;font-weight:600;margin-bottom:4px;">Booking confirmed</h2>
        <p style="color:#555;margin-bottom:24px;">Hi ${name || 'there'}, your table booking is confirmed.</p>
        <table style="width:100%;border-collapse:collapse;font-size:14px;">
          <tr><td style="padding:8px 0;color:#888;width:120px;">Date</td><td style="padding:8px 0;font-weight:500;">${fmtDate(date)}</td></tr>
          <tr><td style="padding:8px 0;color:#888;">Time</td><td style="padding:8px 0;font-weight:500;">${fmtTime(start_time)} – ${fmtTime(end_time)}</td></tr>
          <tr><td style="padding:8px 0;color:#888;">Status</td><td style="padding:8px 0;color:#16a34a;font-weight:500;">Confirmed</td></tr>
        </table>
        <p style="color:#555;font-size:13px;margin-top:16px;">A card hold has been placed for the session. It will only be captured if you are a no-show.</p>
      `),
    })
  } catch (e) {
    console.error('[email] sendBookingConfirmation failed:', e.message)
  }
}

// ── Social play joined ──────────────────────────────────────────────────────
async function sendSocialPlayJoined({ to, name, title, date }) {
  if (!to || !process.env.RESEND_API_KEY) return
  try {
    await resend.emails.send({
      from: FROM,
      to,
      subject: `You've joined ${title || 'Social Play'} – ${fmtDate(date)}`,
      html: card(`
        <h2 style="font-size:20px;font-weight:600;margin-bottom:4px;">Spot confirmed</h2>
        <p style="color:#555;margin-bottom:24px;">Hi ${name || 'there'}, you're registered for the following social play session.</p>
        <table style="width:100%;border-collapse:collapse;font-size:14px;">
          <tr><td style="padding:8px 0;color:#888;width:120px;">Session</td><td style="padding:8px 0;font-weight:500;">${title || 'Social Play'}</td></tr>
          <tr><td style="padding:8px 0;color:#888;">Date</td><td style="padding:8px 0;font-weight:500;">${fmtDate(date)}</td></tr>
        </table>
        <p style="color:#555;font-size:13px;margin-top:16px;">Cancellations must be made at least 24 hours before the session to receive a refund.</p>
      `),
    })
  } catch (e) {
    console.error('[email] sendSocialPlayJoined failed:', e.message)
  }
}

// ── Coaching session scheduled ──────────────────────────────────────────────
async function sendCoachingScheduled({ to, name, coachName, dates, start_time, end_time, notes }) {
  if (!to || !process.env.RESEND_API_KEY) return
  const isSingle = dates.length === 1
  try {
    const dateRows = dates.map(d =>
      `<tr><td style="padding:6px 0;color:#888;">${fmtDate(d)}</td><td style="padding:6px 0;">${fmtTime(start_time)} – ${fmtTime(end_time)}</td></tr>`
    ).join('')

    await resend.emails.send({
      from: FROM,
      to,
      subject: isSingle
        ? `Coaching session scheduled – ${fmtDate(dates[0])}`
        : `${dates.length} coaching sessions scheduled`,
      html: card(`
        <h2 style="font-size:20px;font-weight:600;margin-bottom:4px;">${isSingle ? 'Session scheduled' : 'Sessions scheduled'}</h2>
        <p style="color:#555;margin-bottom:24px;">Hi ${name || 'there'}, the following coaching ${isSingle ? 'session has' : 'sessions have'} been booked for you.</p>
        <p style="font-size:14px;margin-bottom:8px;"><strong>Coach:</strong> ${coachName}</p>
        <table style="width:100%;border-collapse:collapse;font-size:14px;margin-bottom:16px;">
          <thead><tr>
            <th style="text-align:left;padding:6px 0;color:#888;font-weight:400;border-bottom:1px solid #eee;">Date</th>
            <th style="text-align:left;padding:6px 0;color:#888;font-weight:400;border-bottom:1px solid #eee;">Time</th>
          </tr></thead>
          <tbody>${dateRows}</tbody>
        </table>
        ${notes ? `<p style="color:#555;font-size:13px;"><strong>Notes:</strong> ${notes}</p>` : ''}
      `),
    })
  } catch (e) {
    console.error('[email] sendCoachingScheduled failed:', e.message)
  }
}

// ── Flinther platform feedback ─────────────────────────────────────────────
async function sendFeedback({ message, name, email, page }) {
  if (!process.env.RESEND_API_KEY) return
  const to = process.env.ADMIN_EMAIL || 'ianlinaus@gmail.com'
  try {
    await resend.emails.send({
      from: FROM,
      to,
      subject: `Flinther feedback${name ? ` from ${name}` : ''}`,
      html: card(`
        <h2 style="font-size:20px;font-weight:600;margin-bottom:16px;">New feedback</h2>
        ${name  ? `<p style="font-size:14px;color:#555;margin:4px 0;"><strong>Name:</strong> ${name}</p>`   : ''}
        ${email ? `<p style="font-size:14px;color:#555;margin:4px 0;"><strong>Email:</strong> ${email}</p>` : ''}
        ${page  ? `<p style="font-size:14px;color:#555;margin:4px 0;"><strong>Page:</strong> ${page}</p>`   : ''}
        <div style="background:#f9f9f9;border-radius:8px;padding:16px;margin-top:16px;font-size:14px;color:#333;line-height:1.6;white-space:pre-wrap;">${message}</div>
      `),
    })
  } catch (e) {
    console.error('[email] sendFeedback failed:', e.message)
  }
}

module.exports = { sendBookingConfirmation, sendSocialPlayJoined, sendCoachingScheduled, sendFeedback }
