const router = require('express').Router()
const pool   = require('../db')
const { requireAuth } = require('../middleware/auth')
const { randomUUID } = require('crypto')
const jwt    = require('jsonwebtoken')
const { checkOpenHours, maxConcurrentCourts } = require('../utils/scheduleCheck')

function getStripe() {
  if (!process.env.STRIPE_SECRET_KEY) throw new Error('STRIPE_SECRET_KEY not set')
  return require('stripe')(process.env.STRIPE_SECRET_KEY)
}

async function voidIntent(intentId) {
  if (!intentId) return
  try {
    const stripe = getStripe()
    const intent = await stripe.paymentIntents.retrieve(intentId)
    if (intent.status === 'requires_capture') {
      await stripe.paymentIntents.cancel(intentId)
    } else if (intent.status === 'succeeded') {
      await stripe.refunds.create({ payment_intent: intentId })
    }
    // already cancelled/refunded — nothing to do
  } catch (e) {
    console.error('[bookings] voidIntent failed for', intentId, e.message)
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

// Reads JWT if present but never rejects — used for optional auth
function softAuth(req) {
  try {
    const h = req.headers.authorization
    if (h?.startsWith('Bearer ')) {
      const payload = jwt.verify(h.slice(7), process.env.JWT_SECRET)
      // Validate club isolation before setting user context
      if (!req.club || payload.club_id === undefined || payload.club_id === req.club.id) {
        req.user = payload
      }
    }
  } catch { /* no token or invalid — proceed as guest */ }
}

function toMins(t) {
  const [h, m] = t.substring(0, 5).split(':').map(Number)
  return h * 60 + m
}

function minsToTime(mins) {
  return `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}:00`
}

// ─── Routes ──────────────────────────────────────────────────────────────────

// GET /api/bookings/available?date=YYYY-MM-DD
router.get('/available', async (req, res) => {
  const { date } = req.query
  if (!date) return res.status(400).json({ message: 'date query param required.' })
  softAuth(req)
  const clubId = req.club?.id ?? req.user?.club_id ?? null
  try {
    // Fetch all occupied blocks and compute per-30-min-slot court usage
    const { rows: bookingGroups } = await pool.query(
      `SELECT MIN(start_time) AS start_time, MAX(end_time) AS end_time
       FROM bookings WHERE date=$1 AND status='confirmed' AND club_id=$2
       GROUP BY booking_group_id`,
      [date, clubId]
    )
    const { rows: coachingSessions } = await pool.query(
      `SELECT DISTINCT COALESCE(group_id::text, id::text) AS key, start_time, end_time
       FROM coaching_sessions WHERE date=$1 AND status='confirmed' AND club_id=$2`,
      [date, clubId]
    )
    const { rows: socialSessions } = await pool.query(
      `SELECT start_time, end_time, num_courts
       FROM social_play_sessions WHERE date=$1 AND status='open' AND club_id=$2`,
      [date, clubId]
    )

    // Build slot_usage: how many courts are in use per 30-min slot
    const slotUsage = {}
    const addUsage = (startStr, endStr, courts) => {
      const s = toMins(startStr), e = toMins(endStr)
      for (let t = s; t < e; t += 30) {
        const key = minsToTime(t).substring(0, 5)
        slotUsage[key] = (slotUsage[key] ?? 0) + courts
      }
    }
    bookingGroups.forEach(b => addUsage(b.start_time, b.end_time, 1))
    coachingSessions.forEach(s => addUsage(s.start_time, s.end_time, 1))
    socialSessions.forEach(s => addUsage(s.start_time, s.end_time, s.num_courts ?? 0))

    let userBooked = []
    if (req.user) {
      const { rows: ubBookings } = await pool.query(
        `SELECT start_time, end_time FROM bookings
         WHERE date=$1 AND user_id=$2 AND status='confirmed' AND club_id=$3`,
        [date, req.user.id, clubId]
      )
      const { rows: ubCoaching } = await pool.query(
        `SELECT start_time, end_time FROM coaching_sessions
         WHERE date=$1 AND student_id=$2 AND status='confirmed' AND club_id=$3`,
        [date, req.user.id, clubId]
      )
      const { rows: ubSocial } = await pool.query(
        `SELECT sps.start_time, sps.end_time
         FROM social_play_sessions sps
         JOIN social_play_participants spp ON spp.session_id = sps.id
         WHERE sps.date=$1 AND spp.user_id=$2 AND sps.status='open' AND sps.club_id=$3`,
        [date, req.user.id, clubId]
      )
      userBooked = [...ubBookings, ...ubCoaching, ...ubSocial]
    }
    res.json({ slot_usage: slotUsage, user_booked: userBooked })
  } catch { res.status(500).json({ message: 'Server error.' }) }
})

// GET /api/bookings/my
router.get('/my', requireAuth, async (req, res) => {
  try {
    const clubId = req.club?.id ?? req.user?.club_id ?? null
    const { rows } = await pool.query(
      `SELECT
         b.booking_group_id,
         MIN(b.id)         AS id,
         b.court_id,
         c.name            AS court_name,
         b.date,
         MIN(b.start_time) AS start_time,
         MAX(b.end_time)   AS end_time,
         CASE
           WHEN bool_and(b.status = 'cancelled') THEN 'cancelled'
           WHEN bool_or(b.status  = 'cancelled') THEN 'partial'
           ELSE 'confirmed'
         END               AS status,
         MIN(b.created_at)         AS created_at,
         MIN(b.payment_intent_id)  AS payment_intent_id
       FROM bookings b
       LEFT JOIN courts c ON c.id = b.court_id
       WHERE b.user_id = $1 AND b.club_id = $2
       GROUP BY b.booking_group_id, b.court_id, b.date, c.name
       ORDER BY b.date DESC, MIN(b.start_time) DESC`,
      [req.user.id, clubId]
    )
    res.json({ bookings: rows })
  } catch { res.status(500).json({ message: 'Server error.' }) }
})

// GET /api/bookings/:id
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const clubId = req.club?.id ?? req.user?.club_id ?? null
    const { rows } = await pool.query(
      `SELECT b.*, c.name AS court_name FROM bookings b
       LEFT JOIN courts c ON c.id=b.court_id WHERE b.id=$1 AND b.club_id=$2`,
      [req.params.id, clubId]
    )
    if (!rows[0]) return res.status(404).json({ message: 'Booking not found.' })
    if (rows[0].user_id !== req.user.id && req.user.role !== 'admin')
      return res.status(403).json({ message: 'Forbidden.' })
    res.json({ booking: rows[0] })
  } catch { res.status(500).json({ message: 'Server error.' }) }
})

// POST /api/bookings
router.post('/', requireAuth, async (req, res) => {
  const { date, start_time, end_time } = req.body
  if (!date || !start_time || !end_time)
    return res.status(400).json({ message: 'date, start_time and end_time are required.' })

  const startMins = toMins(start_time)
  const endMins   = toMins(end_time)

  if (endMins <= startMins || (endMins - startMins) < 60 || (endMins - startMins) % 30 !== 0)
    return res.status(400).json({ message: 'Duration must be at least 60 minutes and a multiple of 30.' })

  const slots = []
  for (let t = startMins; t < endMins; t += 30)
    slots.push([minsToTime(t), minsToTime(t + 30)])

  const groupId = randomUUID()
  const clubId  = req.club?.id ?? req.user?.club_id ?? null
  const client  = await pool.connect()

  try {
    await client.query('BEGIN')

    const scheduleError = await checkOpenHours(date, start_time, end_time, clubId)
    if (scheduleError) {
      await client.query('ROLLBACK')
      return res.status(409).json({ message: scheduleError })
    }

    // User conflict checks
    const { rows: bookConflict } = await client.query(
      `SELECT 1 FROM bookings
       WHERE user_id=$1 AND date=$2 AND status='confirmed' AND club_id=$3
         AND start_time < $5::time AND end_time > $4::time LIMIT 1`,
      [req.user.id, date, clubId, start_time, end_time]
    )
    if (bookConflict.length) {
      await client.query('ROLLBACK')
      return res.status(409).json({ message: 'You already have a booking during that time.' })
    }

    const { rows: coachConflict } = await client.query(
      `SELECT 1 FROM coaching_sessions
       WHERE student_id=$1 AND date=$2 AND status='confirmed' AND club_id=$3
         AND start_time < $5::time AND end_time > $4::time LIMIT 1`,
      [req.user.id, date, clubId, start_time, end_time]
    )
    if (coachConflict.length) {
      await client.query('ROLLBACK')
      return res.status(409).json({ message: 'You have a coaching session during that time.' })
    }

    const { rows: socialConflict } = await client.query(
      `SELECT 1 FROM social_play_sessions sps
       JOIN social_play_participants spp ON spp.session_id = sps.id
       WHERE spp.user_id=$1 AND sps.date=$2 AND sps.status='open' AND sps.club_id=$3
         AND sps.start_time < $5::time AND sps.end_time > $4::time LIMIT 1`,
      [req.user.id, date, clubId, start_time, end_time]
    )
    if (socialConflict.length) {
      await client.query('ROLLBACK')
      return res.status(409).json({ message: 'You are signed up for social play during that time.' })
    }

    const { rows: coachTeachConflict } = await client.query(
      `SELECT 1 FROM coaching_sessions cs
       JOIN coaches co ON co.id = cs.coach_id
       WHERE co.user_id=$1 AND cs.date=$2 AND cs.status='confirmed' AND cs.club_id=$3
         AND cs.start_time < $5::time AND cs.end_time > $4::time LIMIT 1`,
      [req.user.id, date, clubId, start_time, end_time]
    )
    if (coachTeachConflict.length) {
      await client.query('ROLLBACK')
      return res.status(409).json({ message: 'You have a coaching session to teach during that time.' })
    }

    // Court availability: check peak concurrent usage per 30-min sub-slot
    const { maxUsed, totalCourts } = await maxConcurrentCourts(client, date, start_time, end_time, clubId)
    if (maxUsed >= totalCourts) {
      await client.query('ROLLBACK')
      return res.status(409).json({ message: 'Sorry, all courts are fully booked at that time.' })
    }

    for (const [s, e] of slots) {
      await client.query(
        `INSERT INTO bookings (user_id, date, start_time, end_time, booking_group_id, club_id)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [req.user.id, date, s, e, groupId, clubId]
      )
    }
    await client.query('COMMIT')
    res.status(201).json({ message: 'Booking confirmed.', booking_group_id: groupId })
  } catch (err) {
    await client.query('ROLLBACK')
    if (err.code === '23505') {
      if (err.constraint === 'user_no_double_book')
        return res.status(409).json({ message: 'You already have a booking during that time.' })
      return res.status(409).json({ message: 'One or more of those slots are already booked.' })
    }
    res.status(500).json({ message: 'Server error.' })
  } finally {
    client.release()
  }
})

// POST /api/bookings/group/:groupId/extend
router.post('/group/:groupId/extend', requireAuth, async (req, res) => {
  const { extra_minutes, intentId } = req.body
  const extra = Number(extra_minutes)
  if (!extra || extra % 30 !== 0 || extra <= 0)
    return res.status(400).json({ message: 'extra_minutes must be a positive multiple of 30.' })
  if (!intentId)
    return res.status(400).json({ message: 'intentId is required.' })

  const clubId = req.club?.id ?? req.user?.club_id ?? null
  try {
    // Verify the PaymentIntent before touching the DB
    const stripe = getStripe()
    const intent = await stripe.paymentIntents.retrieve(intentId)
    if (intent.status !== 'requires_capture')
      return res.status(402).json({ message: 'Payment not yet authorised.' })
    if (intent.metadata.type !== 'booking_extension')
      return res.status(400).json({ message: 'Invalid payment intent type.' })
    if (String(intent.metadata.user_id) !== String(req.user.id))
      return res.status(403).json({ message: 'Payment intent does not belong to you.' })
    if (Number(intent.metadata.club_id) !== clubId)
      return res.status(403).json({ message: 'Club mismatch.' })
    if (intent.metadata.group_id !== req.params.groupId)
      return res.status(403).json({ message: 'Booking group mismatch.' })

    const { rows } = await pool.query(
      `SELECT court_id, date, MAX(end_time) AS end_time, MIN(user_id) AS user_id
       FROM bookings WHERE booking_group_id=$1 AND club_id=$2 GROUP BY court_id, date`,
      [req.params.groupId, clubId]
    )
    if (!rows[0]) { await voidIntent(intentId); return res.status(404).json({ message: 'Booking not found.' }) }
    if (rows[0].user_id !== req.user.id && req.user.role !== 'admin')
      return res.status(403).json({ message: 'Forbidden.' })

    const { court_id, date, end_time } = rows[0]
    const startMins = toMins(end_time)
    const slots = []
    for (let t = startMins; t < startMins + extra; t += 30)
      slots.push([minsToTime(t), minsToTime(t + 30)])

    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      for (const [s, e] of slots) {
        await client.query(
          `INSERT INTO bookings (user_id, court_id, date, start_time, end_time, booking_group_id, payment_intent_id, club_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [req.user.id, court_id, date, s, e, req.params.groupId, intentId, clubId]
        )
      }
      await client.query('COMMIT')
      // Capture the hold after DB success
      await stripe.paymentIntents.capture(intentId)
      res.json({ message: 'Booking extended.' })
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      await voidIntent(intentId)
      if (err.code === '23505') {
        if (err.constraint === 'user_no_double_book')
          return res.status(409).json({ message: 'You already have a booking during that time.' })
        return res.status(409).json({ message: 'That time is already booked by someone else.' })
      }
      res.status(500).json({ message: 'Server error.' })
    } finally {
      client.release()
    }
  } catch (err) {
    console.error('[bookings] extend error:', err.message)
    res.status(500).json({ message: 'Server error.' })
  }
})

// DELETE /api/bookings/group/:groupId
router.delete('/group/:groupId', requireAuth, async (req, res) => {
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  if (!UUID_RE.test(req.params.groupId))
    return res.status(400).json({ message: 'Invalid booking group ID.' })
  try {
    const clubId = req.club?.id ?? req.user?.club_id ?? null
    const { rows } = await pool.query(
      'SELECT user_id, payment_intent_id FROM bookings WHERE booking_group_id=$1 AND club_id=$2 LIMIT 1',
      [req.params.groupId, clubId]
    )
    if (!rows[0]) return res.status(404).json({ message: 'Booking not found.' })
    if (rows[0].user_id !== req.user.id && req.user.role !== 'admin')
      return res.status(403).json({ message: 'Forbidden.' })

    const { rows: bRows } = await pool.query(
      `SELECT date, MIN(start_time) AS start_time, MAX(end_time) AS end_time
       FROM bookings WHERE booking_group_id=$1 AND club_id=$2 GROUP BY date`,
      [req.params.groupId, clubId]
    )
    await pool.query(
      "UPDATE bookings SET status='cancelled' WHERE booking_group_id=$1 AND club_id=$2",
      [req.params.groupId, clubId]
    )
    // Check intent status BEFORE voiding so we can craft the right message
    let refundNote = ''
    const intentId = rows[0].payment_intent_id
    if (intentId) {
      try {
        const stripe = getStripe()
        const intent = await stripe.paymentIntents.retrieve(intentId)
        if (intent.status === 'succeeded') refundNote = ' Your payment has been refunded.'
        else if (intent.status === 'requires_capture') refundNote = ' Your card hold has been released.'
      } catch {}
    }

    await voidIntent(intentId)

    const fmtT = t => { const [h,m] = t.substring(0,5).split(':').map(Number); return `${h%12||12}:${String(m).padStart(2,'0')} ${h>=12?'PM':'AM'}` }
    const b = bRows[0]
    const isAdminCancelling = req.user.role === 'admin' && rows[0].user_id !== req.user.id

    if (b) {
      if (isAdminCancelling) {
        // Admin cancelled — notify the booking owner
        pool.query(`INSERT INTO messages (sender_id, recipient_id, body, club_id) VALUES ($1,$2,$3,$4)`,
          [req.user.id, rows[0].user_id,
           `❌ Your table booking on ${b.date} · ${fmtT(b.start_time)}–${fmtT(b.end_time)} has been cancelled by an admin.${refundNote}`,
           clubId]).catch(() => {})
      } else {
        // User cancelled themselves — notify admin
        pool.query(`SELECT id FROM users WHERE role='admin' AND club_id=$1 LIMIT 1`, [clubId])
          .then(({ rows: [admin] }) => {
            if (!admin) return
            pool.query(`INSERT INTO messages (sender_id, recipient_id, body, club_id) VALUES ($1,$2,$3,$4)`,
              [req.user.id, admin.id, `❌ ${req.user.name} cancelled their table booking on ${b.date} · ${fmtT(b.start_time)}–${fmtT(b.end_time)}`, clubId]).catch(() => {})
          }).catch(() => {})
      }
    }

    res.json({ message: 'Booking cancelled.' })
  } catch (err) {
    console.error('[bookings] cancel group error:', err.message)
    res.status(500).json({ message: 'Server error.' })
  }
})

// DELETE /api/bookings/:id
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const clubId = req.club?.id ?? req.user?.club_id ?? null
    const { rows } = await pool.query(
      'SELECT * FROM bookings WHERE id=$1 AND club_id=$2',
      [req.params.id, clubId]
    )
    if (!rows[0]) return res.status(404).json({ message: 'Booking not found.' })
    if (rows[0].user_id !== req.user.id && req.user.role !== 'admin')
      return res.status(403).json({ message: 'Forbidden.' })

    await pool.query("UPDATE bookings SET status='cancelled' WHERE id=$1", [req.params.id])
    res.json({ message: 'Slot deleted.' })
  } catch { res.status(500).json({ message: 'Server error.' }) }
})

module.exports = router
