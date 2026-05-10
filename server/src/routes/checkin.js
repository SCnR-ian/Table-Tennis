const router = require('express').Router()
const pool   = require('../db')
const { requireAuth } = require('../middleware/auth')

// Resolve the target user: the logged-in user themselves, or (if admin) a
// specified user passed in the request body.
function resolveTarget(req) {
  if (req.user.role === 'admin' && req.body.user_id) return Number(req.body.user_id)
  return req.user.id
}

// checkedInBy: null when user checks themselves in, admin's id otherwise
function checkedInBy(req, targetId) {
  return req.user.id === targetId ? null : req.user.id
}

const TODAY = () => new Date().toISOString().slice(0, 10)

// POST /api/checkin/booking/:groupId
// Member or admin checks a user in for a regular court booking.
router.post('/booking/:groupId', requireAuth, async (req, res) => {
  const uid = resolveTarget(req)
  try {
    const { rows } = await pool.query(
      `SELECT date FROM bookings
       WHERE booking_group_id=$1 AND user_id=$2 AND status='confirmed' LIMIT 1`,
      [req.params.groupId, uid]
    )
    if (!rows[0]) return res.status(404).json({ message: 'Booking not found.' })
    if (rows[0].date > TODAY())
      return res.status(409).json({ message: 'Cannot check in for a future session.' })

    await pool.query(
      `INSERT INTO check_ins (user_id, type, reference_id, date, checked_in_by)
       VALUES ($1, 'booking', $2, $3, $4)
       ON CONFLICT (user_id, type, reference_id) DO NOTHING`,
      [uid, req.params.groupId, rows[0].date, checkedInBy(req, uid)]
    )
    // Void the booking hold when user shows up (booking uses capture_method:'manual')
    const { rows: bRows } = await pool.query(
      `SELECT payment_intent_id FROM bookings WHERE booking_group_id=$1 AND user_id=$2 LIMIT 1`,
      [req.params.groupId, uid]
    )
    if (bRows[0]?.payment_intent_id) {
      try {
        const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY)
        const intent = await stripe.paymentIntents.retrieve(bRows[0].payment_intent_id)
        if (intent.status === 'requires_capture')
          await stripe.paymentIntents.cancel(bRows[0].payment_intent_id)
      } catch {}
    }
    res.json({ message: 'Checked in.' })
  } catch { res.status(500).json({ message: 'Server error.' }) }
})

// POST /api/checkin/social/:sessionId
// Member or admin checks a user in for a social play session they joined.
router.post('/social/:sessionId', requireAuth, async (req, res) => {
  const uid = resolveTarget(req)
  try {
    const { rows } = await pool.query(
      `SELECT sps.date FROM social_play_sessions sps
       JOIN social_play_participants spp ON spp.session_id = sps.id
       WHERE sps.id=$1 AND spp.user_id=$2 LIMIT 1`,
      [req.params.sessionId, uid]
    )
    if (!rows[0]) return res.status(404).json({ message: 'Not a participant.' })
    if (rows[0].date > TODAY())
      return res.status(409).json({ message: 'Cannot check in for a future session.' })

    await pool.query(
      `INSERT INTO check_ins (user_id, type, reference_id, date, checked_in_by)
       VALUES ($1, 'social', $2, $3, $4)
       ON CONFLICT (user_id, type, reference_id) DO NOTHING`,
      [uid, req.params.sessionId, rows[0].date, checkedInBy(req, uid)]
    )
    // Social play is direct charge (no hold to release)
    res.json({ message: 'Checked in.' })
  } catch { res.status(500).json({ message: 'Server error.' }) }
})

// POST /api/checkin/coaching/:sessionId
// Admin checks in the student for a coaching session and deducts their hours.
router.post('/coaching/:sessionId', requireAuth, async (req, res) => {
  if (req.user.role !== 'admin')
    return res.status(403).json({ message: 'Admin only.' })
  const client = await pool.connect()
  try {
    const { rows } = await client.query(
      `SELECT cs.date, cs.start_time, cs.end_time, cs.student_id, cs.group_id
       FROM coaching_sessions cs
       WHERE cs.id=$1 AND cs.status='confirmed' LIMIT 1`,
      [req.params.sessionId]
    )
    if (!rows[0]) return res.status(404).json({ message: 'Coaching session not found.' })
    if (rows[0].date > TODAY())
      return res.status(409).json({ message: 'Cannot check in for a future session.' })

    const studentId = rows[0].student_id
    await client.query('BEGIN')
    const { rowCount } = await client.query(
      `INSERT INTO check_ins (user_id, type, reference_id, date, checked_in_by)
       VALUES ($1, 'coaching', $2, $3, $4)
       ON CONFLICT (user_id, type, reference_id) DO NOTHING`,
      [studentId, req.params.sessionId, rows[0].date, req.user.id]
    )
    // Deduct session price when first checked in
    if (rowCount > 0) {
      const sessionType = rows[0].group_id ? 'group' : 'solo'
      const clubId = req.club?.id ?? req.user?.club_id ?? null
      const { rows: [priceRow] } = await client.query(
        'SELECT price FROM coaching_prices WHERE session_type=$1 AND club_id=$2',
        [sessionType, clubId]
      )
      const amount = priceRow?.price ?? (sessionType === 'group' ? 50 : 70)
      await client.query(
        `INSERT INTO coaching_hour_ledger (user_id, delta, note, session_type, session_id, created_by, club_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [studentId, -amount, 'Coaching session attended', sessionType, req.params.sessionId, req.user.id, clubId]
      )
    }
    await client.query('COMMIT')
    res.json({ message: 'Checked in.' })
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    res.status(500).json({ message: 'Server error.' })
  } finally {
    client.release()
  }
})

// POST /api/checkin/coaching/:sessionId/no-show
// Admin marks a student as no-show for a coaching session and deducts their hours.
router.post('/coaching/:sessionId/no-show', requireAuth, async (req, res) => {
  if (req.user.role !== 'admin')
    return res.status(403).json({ message: 'Admin only.' })
  const client = await pool.connect()
  try {
    const { rows } = await client.query(
      `SELECT cs.date, cs.start_time, cs.end_time, cs.student_id, cs.group_id
       FROM coaching_sessions cs
       WHERE cs.id=$1 AND cs.status='confirmed' LIMIT 1`,
      [req.params.sessionId]
    )
    if (!rows[0]) return res.status(404).json({ message: 'Coaching session not found.' })
    if (rows[0].date > TODAY())
      return res.status(409).json({ message: 'Cannot mark no-show for a future session.' })

    const studentId = rows[0].student_id
    await client.query('BEGIN')
    const { rowCount } = await client.query(
      `INSERT INTO check_ins (user_id, type, reference_id, date, checked_in_by, no_show)
       VALUES ($1, 'coaching', $2, $3, $4, TRUE)
       ON CONFLICT (user_id, type, reference_id) DO NOTHING`,
      [studentId, req.params.sessionId, rows[0].date, req.user.id]
    )
    if (rowCount > 0) {
      const clubId = req.club?.id ?? req.user?.club_id ?? null
      const sessionType = rows[0].group_id ? 'group' : 'solo'
      const { rows: [priceRow] } = await client.query(
        'SELECT price FROM coaching_prices WHERE session_type=$1 AND club_id=$2',
        [sessionType, clubId]
      )
      const amount = priceRow?.price ?? (sessionType === 'group' ? 50 : 70)
      await client.query(
        `INSERT INTO coaching_hour_ledger (user_id, delta, note, session_type, session_id, created_by, club_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [studentId, -amount, 'No show — fee deducted', sessionType, req.params.sessionId, req.user.id, clubId]
      )
    }
    await client.query('COMMIT')
    res.json({ message: 'Marked as no-show.' })
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    res.status(500).json({ message: 'Server error.' })
  } finally {
    client.release()
  }
})

// GET /api/checkin/today
// Returns the logged-in user's check-ins for today.
router.get('/today', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT type, reference_id FROM check_ins
       WHERE user_id=$1 AND date=CURRENT_DATE`,
      [req.user.id]
    )
    res.json({ checkIns: rows })
  } catch { res.status(500).json({ message: 'Server error.' }) }
})

// GET /api/checkin/admin?date=YYYY-MM-DD
// Returns all check-ins for a given date — admin only.
router.get('/admin', requireAuth, async (req, res) => {
  if (req.user.role !== 'admin')
    return res.status(403).json({ message: 'Admin only.' })
  const { date } = req.query
  if (!date) return res.status(400).json({ message: 'date is required.' })
  try {
    const clubId = req.club?.id ?? req.user?.club_id ?? null
    const { rows } = await pool.query(
      `SELECT ci.type, ci.reference_id, ci.user_id, ci.checked_in_at, ci.no_show,
              u.name AS user_name
       FROM check_ins ci
       JOIN users u ON u.id = ci.user_id
       WHERE ci.date=$1 AND ci.club_id=$2
       ORDER BY ci.checked_in_at ASC`,
      [date, clubId]
    )
    res.json({ checkIns: rows })
  } catch { res.status(500).json({ message: 'Server error.' }) }
})

// GET /api/checkin/today-summary?date=YYYY-MM-DD  (admin)
// All activities scheduled for a given date (default: today) with per-person check-in status.
router.get('/today-summary', requireAuth, async (req, res) => {
  if (req.user.role !== 'admin')
    return res.status(403).json({ message: 'Admin only.' })
  const date = req.query.date ?? TODAY()
  const clubId = req.club?.id ?? req.user?.club_id ?? null
  try {
    // ── Bookings ─────────────────────────────────────────────────────────────
    const { rows: bookings } = await pool.query(`
      SELECT
        b.booking_group_id              AS group_id,
        MIN(b.start_time)               AS start_time,
        MAX(b.end_time)                 AS end_time,
        ct.name                         AS court_name,
        u.id                            AS user_id,
        u.name                          AS user_name,
        EXISTS(
          SELECT 1 FROM check_ins ci
          WHERE ci.user_id = u.id
            AND ci.type = 'booking'
            AND ci.reference_id = b.booking_group_id::text
        ) AS checked_in
      FROM bookings b
      JOIN users  u  ON u.id  = b.user_id
      JOIN courts ct ON ct.id = b.court_id
      WHERE b.date = $1 AND b.status = 'confirmed' AND b.club_id = $2
      GROUP BY b.booking_group_id, ct.name, u.id, u.name
      ORDER BY start_time ASC, u.name ASC
    `, [date, clubId])

    // ── Coaching sessions ─────────────────────────────────────────────────────
    const { rows: coaching } = await pool.query(`
      SELECT
        cs.id,
        cs.group_id,
        cs.start_time, cs.end_time,
        ct.name  AS court_name,
        st.id    AS student_id,
        st.name  AS student_name,
        co.name  AS coach_name,
        co_u.id  AS coach_user_id,
        EXISTS(
          SELECT 1 FROM check_ins ci
          WHERE ci.user_id = cs.student_id
            AND ci.type = 'coaching'
            AND ci.reference_id = cs.id::text
        ) AS student_checked_in,
        EXISTS(
          SELECT 1 FROM check_ins ci
          WHERE ci.user_id = co_u.id
            AND ci.type = 'coaching'
            AND ci.reference_id = cs.id::text
        ) AS coach_checked_in,
        EXISTS(
          SELECT 1 FROM check_ins ci
          WHERE ci.type = 'coaching'
            AND ci.reference_id = cs.id::text
            AND ci.checked_in_by IS NOT NULL
        ) AS admin_checked_in
      FROM coaching_sessions cs
      JOIN users  st ON st.id  = cs.student_id
      JOIN coaches co ON co.id = cs.coach_id
      LEFT JOIN users co_u ON co_u.id = co.user_id
      JOIN courts ct ON ct.id = cs.court_id
      WHERE cs.date = $1 AND cs.status = 'confirmed' AND cs.club_id = $2
      ORDER BY cs.start_time ASC
    `, [date, clubId])

    // ── Social play ───────────────────────────────────────────────────────────
    const { rows: social } = await pool.query(`
      SELECT
        sps.id,
        sps.title,
        sps.start_time, sps.end_time,
        u.id   AS user_id,
        u.name AS user_name,
        EXISTS(
          SELECT 1 FROM check_ins ci
          WHERE ci.user_id = spp.user_id
            AND ci.type = 'social'
            AND ci.reference_id = sps.id::text
        ) AS checked_in
      FROM social_play_sessions sps
      JOIN social_play_participants spp ON spp.session_id = sps.id
      JOIN users u ON u.id = spp.user_id
      WHERE sps.date = $1 AND sps.status = 'open' AND sps.club_id = $2
      ORDER BY sps.start_time ASC, u.name ASC
    `, [date, clubId])

    res.json({ bookings, coaching, social })
  } catch (err) {
    console.error('today-summary error:', err)
    res.status(500).json({ message: err.message ?? 'Server error.' })
  }
})

// DELETE /api/checkin/:type/:refId/:userId  (admin)
// Cancel (undo) a check-in. For coaching, refunds the deducted hours.
router.delete('/:type/:refId/:userId', requireAuth, async (req, res) => {
  if (req.user.role !== 'admin')
    return res.status(403).json({ message: 'Admin only.' })
  const { type, refId, userId } = req.params
  if (!['booking', 'social', 'coaching'].includes(type))
    return res.status(400).json({ message: 'Invalid type.' })
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const { rowCount } = await client.query(
      'DELETE FROM check_ins WHERE user_id=$1 AND type=$2 AND reference_id=$3',
      [userId, type, refId]
    )
    if (rowCount === 0) {
      await client.query('ROLLBACK')
      return res.status(404).json({ message: 'Check-in not found.' })
    }
    // Refund coaching fee when undoing a student coaching check-in
    if (type === 'coaching') {
      const { rows: [session] } = await client.query(
        'SELECT group_id FROM coaching_sessions WHERE id=$1',
        [refId]
      )
      // Find the original deduction and refund exactly that amount
      const { rows: [deduction] } = await client.query(
        'SELECT delta FROM coaching_hour_ledger WHERE user_id=$1 AND session_id=$2 AND delta < 0 ORDER BY id DESC LIMIT 1',
        [userId, refId]
      )
      if (session && deduction) {
        const sessionType = session.group_id ? 'group' : 'solo'
        await client.query(
          `INSERT INTO coaching_hour_ledger (user_id, delta, note, session_type, session_id, created_by)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [userId, -deduction.delta, 'Check-in undone — refunded', sessionType, refId, req.user.id]
        )
      }
    }
    await client.query('COMMIT')
    res.json({ message: 'Check-in cancelled.' })
  } catch {
    await client.query('ROLLBACK').catch(() => {})
    res.status(500).json({ message: 'Server error.' })
  } finally {
    client.release()
  }
})

module.exports = router
