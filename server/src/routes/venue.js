const router = require('express').Router()
const crypto = require('crypto')
const pool   = require('../db')
const { requireAuth } = require('../middleware/auth')

// ── Helpers ──────────────────────────────────────────────────────────────────

async function getClubAdmin(clubId) {
  const { rows } = await pool.query(
    `SELECT id FROM users WHERE role='admin' AND club_id=$1 LIMIT 1`,
    [clubId]
  )
  return rows[0]?.id ?? null
}

async function sendMsg(senderId, recipientId, body) {
  try {
    const { rows: [msg] } = await pool.query(
      `INSERT INTO messages (sender_id, recipient_id, body) VALUES ($1, $2, $3) RETURNING id`,
      [senderId, recipientId, body]
    )
    await pool.query(
      `INSERT INTO message_reads (message_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [msg.id, senderId]
    )
  } catch (e) {
    console.error('[venue sendMsg] failed:', e.message)
  }
}

function fmtDateTime(dt) {
  return new Date(dt).toLocaleString('en-AU', {
    timeZone: 'Australia/Sydney',
    weekday: 'long',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  })
}

function durationStr(ms) {
  const totalMins = Math.round(ms / 60000)
  const h = Math.floor(totalMins / 60)
  const m = totalMins % 60
  if (h === 0) return `${m}m`
  if (m === 0) return `${h}h`
  return `${h}h ${m}m`
}

// ── Routes ────────────────────────────────────────────────────────────────────

// GET /api/venue/status  — today's check-in status for current user
router.get('/status', requireAuth, async (req, res) => {
  const clubId = req.club?.id ?? req.user?.club_id ?? null
  try {
    const { rows } = await pool.query(
      `SELECT checked_in_at, checked_out_at FROM venue_checkins
       WHERE user_id=$1 AND club_id=$2 AND date=CURRENT_DATE`,
      [req.user.id, clubId]
    )
    const row = rows[0]
    res.json({
      checked_in:     !!row,
      checked_out:    !!(row?.checked_out_at),
      checked_in_at:  row?.checked_in_at  ?? null,
      checked_out_at: row?.checked_out_at ?? null,
    })
  } catch { res.status(500).json({ message: 'Server error.' }) }
})

// POST /api/venue/checkin
router.post('/checkin', requireAuth, async (req, res) => {
  const clubId = req.club?.id ?? req.user?.club_id ?? null
  const { token } = req.body
  try {
    const { rows: [club] } = await pool.query(
      'SELECT qr_token FROM clubs WHERE id=$1', [clubId]
    )
    if (!club || club.qr_token !== token)
      return res.status(403).json({ message: 'Invalid QR code.' })

    const { rows } = await pool.query(
      `SELECT id FROM venue_checkins WHERE user_id=$1 AND club_id=$2 AND date=CURRENT_DATE`,
      [req.user.id, clubId]
    )
    if (rows[0])
      return res.status(409).json({ message: 'Already checked in today.' })

    const now = new Date()
    const timeStr = now.toLocaleTimeString('en-AU', { timeZone: 'Australia/Sydney', hour: 'numeric', minute: '2-digit', hour12: true })
    await pool.query(
      `INSERT INTO venue_checkins (user_id, club_id, checked_in_at) VALUES ($1, $2, $3)`,
      [req.user.id, clubId, now]
    )

    // Auto-link to an active booking (start_time ≤ now ≤ end_time, or within 30 min after end)
    const { rows: activeBookings } = await pool.query(
      `SELECT b.booking_group_id, b.payment_intent_id
       FROM bookings b
       WHERE b.user_id=$1 AND b.date=CURRENT_DATE AND b.status='confirmed' AND b.club_id=$2
         AND b.start_time::time <= (CURRENT_TIME + INTERVAL '30 min')
         AND b.end_time::time  >= (CURRENT_TIME - INTERVAL '30 min')
       LIMIT 1`,
      [req.user.id, clubId]
    )
    if (activeBookings[0]) {
      const { booking_group_id, payment_intent_id } = activeBookings[0]
      // Record booking check-in
      await pool.query(
        `INSERT INTO check_ins (user_id, type, reference_id, date, club_id)
         VALUES ($1,'booking',$2,CURRENT_DATE,$3) ON CONFLICT DO NOTHING`,
        [req.user.id, booking_group_id, clubId]
      )
      // Void the hold (member showed up)
      if (payment_intent_id) {
        try {
          const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY)
          const intent = await stripe.paymentIntents.retrieve(payment_intent_id)
          if (intent.status === 'requires_capture')
            await stripe.paymentIntents.cancel(payment_intent_id)
        } catch {}
      }
    }

    // Notify admin and member
    const adminId = await getClubAdmin(clubId)
    const checkinMsg = `✅ Checked in — ${timeStr}`
    if (adminId) {
      sendMsg(adminId, req.user.id,
        `✅ ${req.user.email} checked in — ${timeStr}${activeBookings[0] ? ' (booking confirmed)' : ''}`
      ).catch(() => {})
    }
    // Notify member (message from admin)
    if (adminId) {
      sendMsg(req.user.id, adminId, checkinMsg).catch(() => {})
    }

    res.json({ message: 'Checked in.', checked_in_at: now })
  } catch (e) {
    console.error('[venue] checkin error:', e.message)
    res.status(500).json({ message: 'Server error.' })
  }
})

// POST /api/venue/checkout
router.post('/checkout', requireAuth, async (req, res) => {
  const clubId = req.club?.id ?? req.user?.club_id ?? null
  const { token } = req.body
  try {
    const { rows: [club] } = await pool.query(
      'SELECT qr_token FROM clubs WHERE id=$1', [clubId]
    )
    if (!club || club.qr_token !== token)
      return res.status(403).json({ message: 'Invalid QR code.' })

    const { rows } = await pool.query(
      `SELECT id, checked_in_at, checked_out_at FROM venue_checkins
       WHERE user_id=$1 AND club_id=$2 AND date=CURRENT_DATE`,
      [req.user.id, clubId]
    )
    if (!rows[0])
      return res.status(409).json({ message: 'Not checked in today.' })
    if (rows[0].checked_out_at)
      return res.status(409).json({ message: 'Already checked out today.' })

    const now = new Date()
    const duration = durationStr(now - new Date(rows[0].checked_in_at))
    const timeStr  = now.toLocaleTimeString('en-AU', { timeZone: 'Australia/Sydney', hour: 'numeric', minute: '2-digit', hour12: true })
    await pool.query(
      `UPDATE venue_checkins SET checked_out_at=$1 WHERE id=$2`,
      [now, rows[0].id]
    )

    // Notify admin and member
    const adminId = await getClubAdmin(clubId)
    if (adminId) {
      sendMsg(adminId, req.user.id,
        `👋 ${req.user.email} checked out — ${timeStr} (${duration})`
      ).catch(() => {})
      sendMsg(req.user.id, adminId,
        `👋 Checked out — ${timeStr} · Time in venue: ${duration}`
      ).catch(() => {})
    }

    res.json({ message: 'Checked out.', checked_out_at: now })
  } catch { res.status(500).json({ message: 'Server error.' }) }
})

// GET /api/venue/today?date=YYYY-MM-DD  (admin)
router.get('/today', requireAuth, async (req, res) => {
  if (req.user.role !== 'admin')
    return res.status(403).json({ message: 'Admin only.' })
  const clubId = req.club?.id ?? req.user?.club_id ?? null
  const date = req.query.date ?? new Date().toISOString().slice(0, 10)
  try {
    const { rows } = await pool.query(
      `SELECT vc.id, vc.checked_in_at, vc.checked_out_at,
              u.id AS user_id, u.name, u.role
       FROM venue_checkins vc
       JOIN users u ON u.id = vc.user_id
       WHERE vc.date=$1 AND vc.club_id=$2
       ORDER BY vc.checked_in_at ASC`,
      [date, clubId]
    )
    res.json({ checkins: rows })
  } catch { res.status(500).json({ message: 'Server error.' }) }
})

// GET /api/venue/qr  (admin)
router.get('/qr', requireAuth, async (req, res) => {
  if (req.user.role !== 'admin')
    return res.status(403).json({ message: 'Admin only.' })
  const clubId = req.club?.id ?? req.user?.club_id ?? null
  try {
    let { rows: [club] } = await pool.query(
      'SELECT qr_token, name FROM clubs WHERE id=$1', [clubId]
    )
    if (!club) return res.status(404).json({ message: 'Club not found.' })
    if (!club.qr_token) {
      const token = crypto.randomBytes(32).toString('hex')
      await pool.query('UPDATE clubs SET qr_token=$1 WHERE id=$2', [token, clubId])
      club.qr_token = token
    }
    const base = process.env.FRONTEND_URL || 'http://localhost:5173'
    res.json({
      token:     club.qr_token,
      url:       `${base}/scan?t=${club.qr_token}`,
      club_name: club.name,
    })
  } catch { res.status(500).json({ message: 'Server error.' }) }
})

// POST /api/venue/qr/regenerate  (admin)
router.post('/qr/regenerate', requireAuth, async (req, res) => {
  if (req.user.role !== 'admin')
    return res.status(403).json({ message: 'Admin only.' })
  const clubId = req.club?.id ?? req.user?.club_id ?? null
  try {
    const token = crypto.randomBytes(32).toString('hex')
    await pool.query('UPDATE clubs SET qr_token=$1 WHERE id=$2', [token, clubId])
    const base = process.env.FRONTEND_URL || 'http://localhost:5173'
    res.json({ token, url: `${base}/scan?t=${token}` })
  } catch { res.status(500).json({ message: 'Server error.' }) }
})

// GET /api/venue/history  — member's own venue check-in history
router.get('/history', requireAuth, async (req, res) => {
  const clubId = req.club?.id ?? req.user?.club_id ?? null
  try {
    const { rows } = await pool.query(
      `SELECT date, checked_in_at, checked_out_at
       FROM venue_checkins
       WHERE user_id=$1 AND club_id=$2
       ORDER BY date DESC, checked_in_at DESC
       LIMIT 60`,
      [req.user.id, clubId]
    )
    res.json({ history: rows })
  } catch { res.status(500).json({ message: 'Server error.' }) }
})

module.exports = router
