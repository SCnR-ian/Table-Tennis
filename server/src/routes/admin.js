const router  = require('express').Router()
const pool    = require('../db')
const bcrypt  = require('bcryptjs')
const crypto  = require('crypto')
const multer  = require('multer')
const { requireAuth, requireAdmin } = require('../middleware/auth')

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf') cb(null, true)
    else cb(new Error('Only PDF files are allowed.'))
  },
})

router.use(requireAuth, requireAdmin)

const safeUser = (u) => ({
  id: u.id, name: u.name, email: u.email,
  role: u.role, phone: u.phone, avatar_url: u.avatar_url, created_at: u.created_at,
})

// GET /api/admin/stats
router.get('/stats', async (req, res) => {
  try {
    const clubId = req.club?.id ?? req.user?.club_id ?? null
    const [members, bookings, tournaments] = await Promise.all([
      pool.query("SELECT COUNT(*)::int FROM users WHERE role='member' AND club_id=$1", [clubId]),
      pool.query("SELECT COUNT(*)::int FROM bookings WHERE status='confirmed' AND club_id=$1", [clubId]),
      pool.query("SELECT COUNT(*)::int FROM tournaments WHERE club_id=$1", [clubId]),
    ])
    res.json({
      members:     members.rows[0].count,
      bookings:    bookings.rows[0].count,
      tournaments: tournaments.rows[0].count,
    })
  } catch { res.status(500).json({ message: 'Server error.' }) }
})

// POST /api/admin/members — admin creates a member account
router.post('/members', async (req, res) => {
  const { name, email, password, phone } = req.body
  if (!name?.trim() || !email?.trim() || !password)
    return res.status(400).json({ message: 'Name, email and password are required.' })
  try {
    const clubId = req.club?.id ?? req.user?.club_id ?? null

    const hash = await bcrypt.hash(password, 12)
    const { rows } = await pool.query(
      'INSERT INTO users (name, email, password_hash, phone, club_id) VALUES ($1,$2,$3,$4,$5) RETURNING *',
      [name.trim(), email.toLowerCase().trim(), hash, phone?.trim() || null, clubId]
    )
    res.status(201).json({ member: safeUser(rows[0]) })
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ message: 'An account with that email already exists.' })
    res.status(500).json({ message: 'Server error.' })
  }
})

// GET /api/admin/members
router.get('/members', async (req, res) => {
  try {
    const clubId = req.club?.id ?? req.user?.club_id ?? null
    const { rows } = await pool.query(
      'SELECT * FROM users WHERE is_walkin IS NOT TRUE AND club_id=$1 ORDER BY created_at DESC',
      [clubId]
    )
    res.json({ members: rows.map(safeUser) })
  } catch { res.status(500).json({ message: 'Server error.' }) }
})

// PATCH /api/admin/members/:id — update name and/or email
router.patch('/members/:id', async (req, res) => {
  const { name, email } = req.body
  if (!name?.trim() && !email?.trim())
    return res.status(400).json({ message: 'Nothing to update.' })
  try {
    const clubId = req.club?.id ?? req.user?.club_id ?? null
    const updates = [], values = []
    if (name?.trim())  { updates.push(`name=$${values.length+1}`);  values.push(name.trim()) }
    if (email?.trim()) { updates.push(`email=$${values.length+1}`); values.push(email.toLowerCase().trim()) }
    values.push(req.params.id)
    values.push(clubId)
    const { rows } = await pool.query(
      `UPDATE users SET ${updates.join(', ')} WHERE id=$${values.length - 1} AND club_id=$${values.length} RETURNING *`,
      values
    )
    if (!rows.length) return res.status(404).json({ message: 'Member not found.' })
    res.json({ member: safeUser(rows[0]) })
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ message: 'That email is already in use.' })
    res.status(500).json({ message: 'Server error.' })
  }
})

// PUT /api/admin/members/:id/role
router.put('/members/:id/role', async (req, res) => {
  const { role } = req.body
  if (!['member', 'admin', 'coach'].includes(role))
    return res.status(400).json({ message: 'Invalid role.' })
  const clubId = req.club?.id ?? req.user?.club_id ?? null
  const client = await pool.connect()
  try {
    // Block demotion if the coach has future confirmed sessions
    if (role !== 'coach') {
      const { rows: futureSessions } = await client.query(
        `SELECT COUNT(*)::int AS count FROM coaching_sessions cs
         JOIN coaches co ON co.id = cs.coach_id
         WHERE co.user_id = $1 AND cs.status = 'confirmed' AND cs.date >= CURRENT_DATE AND cs.club_id = $2`,
        [req.params.id, clubId]
      )
      if (futureSessions[0].count > 0)
        return res.status(409).json({
          message: `Cannot demote: this coach has ${futureSessions[0].count} upcoming session${futureSessions[0].count > 1 ? 's' : ''}. Cancel or reassign them first.`
        })
    }
    const { rows } = await client.query(
      'UPDATE users SET role=$1, updated_at=NOW() WHERE id=$2 AND club_id=$3 RETURNING *',
      [role, req.params.id, clubId]
    )
    if (!rows[0]) return res.status(404).json({ message: 'Member not found.' })
    if (role !== 'coach') {
      try { await client.query('DELETE FROM coaches WHERE user_id=$1', [req.params.id]) } catch {}
    }
    res.json({ member: safeUser(rows[0]) })
  } catch (err) { res.status(500).json({ message: err.message ?? 'Server error.' }) }
  finally { client.release() }
})

// POST /api/admin/members/:id/make-coach  (multipart/form-data)
router.post('/members/:id/make-coach', upload.single('resume'), async (req, res) => {
  const availability_start = req.body.availability_start || null
  const availability_end   = req.body.availability_end   || null
  const bio                = req.body.bio                || null
  const userId = req.params.id
  const clubId = req.club?.id ?? req.user?.club_id ?? null
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const userRes = await client.query(
      'SELECT * FROM users WHERE id=$1 AND club_id=$2',
      [userId, clubId]
    )
    if (!userRes.rows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ message: 'Member not found.' }) }
    const userName = userRes.rows[0].name
    const resumeFilename = req.file ? req.file.originalname : null
    const resumeData     = req.file ? req.file.buffer.toString('base64') : null
    const { rows } = await client.query(
      `INSERT INTO coaches (user_id, name, bio, availability_start, availability_end, resume_filename, resume_data, club_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (user_id) WHERE user_id IS NOT NULL DO UPDATE SET
         bio=$3, availability_start=$4, availability_end=$5,
         resume_filename=COALESCE($6, coaches.resume_filename),
         resume_data=COALESCE($7, coaches.resume_data)
       RETURNING *`,
      [userId, userName, bio, availability_start, availability_end, resumeFilename, resumeData, clubId]
    )
    await client.query("UPDATE users SET role='coach', updated_at=NOW() WHERE id=$1", [userId])
    await client.query('COMMIT')
    res.status(201).json({ coach: rows[0] })
  } catch (err) {
    await client.query('ROLLBACK')
    console.error('make-coach error:', err.message, err.stack)
    res.status(500).json({ message: err.message })
  } finally { client.release() }
})

// PATCH /api/admin/coaches/:id/status  — activate or deactivate a coach
router.patch('/coaches/:id/status', async (req, res) => {
  const { is_active } = req.body
  if (typeof is_active !== 'boolean')
    return res.status(400).json({ message: 'is_active (boolean) required.' })
  try {
    const clubId = req.club?.id ?? req.user?.club_id ?? null
    const { rows } = await pool.query(
      'UPDATE coaches SET is_active=$1 WHERE id=$2 AND club_id=$3 RETURNING id, name, is_active',
      [is_active, req.params.id, clubId]
    )
    if (!rows[0]) return res.status(404).json({ message: 'Coach not found.' })
    res.json({ coach: rows[0] })
  } catch (err) { res.status(500).json({ message: 'Server error.' }) }
})

// GET /api/admin/coaches/:id/resume
router.get('/coaches/:id/resume', async (req, res) => {
  try {
    const clubId = req.club?.id ?? req.user?.club_id ?? null
    const { rows } = await pool.query(
      'SELECT resume_filename, resume_data FROM coaches WHERE id=$1 AND club_id=$2',
      [req.params.id, clubId]
    )
    if (!rows[0] || !rows[0].resume_data) return res.status(404).json({ message: 'No resume found.' })
    const buf = Buffer.from(rows[0].resume_data, 'base64')
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', `inline; filename="${rows[0].resume_filename || 'resume.pdf'}"`)
    res.send(buf)
  } catch { res.status(500).json({ message: 'Server error.' }) }
})

// PATCH /api/admin/members/:id/status  — activate or deactivate
router.patch('/members/:id/status', async (req, res) => {
  if (String(req.params.id) === String(req.user.id))
    return res.status(400).json({ message: 'You cannot deactivate your own account.' })
  const { is_active } = req.body
  if (typeof is_active !== 'boolean')
    return res.status(400).json({ message: 'is_active (boolean) required.' })
  try {
    const clubId = req.club?.id ?? req.user?.club_id ?? null
    const { rows } = await pool.query(
      'UPDATE users SET is_active=$1, updated_at=NOW() WHERE id=$2 AND club_id=$3 RETURNING *',
      [is_active, req.params.id, clubId]
    )
    if (!rows[0]) return res.status(404).json({ message: 'Member not found.' })
    res.json({ member: safeUser(rows[0]) })
  } catch (err) { res.status(500).json({ message: 'Server error.' }) }
})

// DELETE /api/admin/members/:id
router.delete('/members/:id', async (req, res) => {
  if (String(req.params.id) === String(req.user.id))
    return res.status(400).json({ message: 'You cannot delete your own account.' })
  try {
    const clubId = req.club?.id ?? req.user?.club_id ?? null
    const { rowCount } = await pool.query(
      'DELETE FROM users WHERE id=$1 AND club_id=$2',
      [req.params.id, clubId]
    )
    if (rowCount === 0) return res.status(404).json({ message: 'Member not found.' })
    res.json({ message: 'Member deleted.' })
  } catch (err) {
    if (err.code === '23503') return res.status(409).json({ message: 'Cannot delete member: they have linked records. Run the FK migration first.' })
    res.status(500).json({ message: 'Server error.' })
  }
})

// GET /api/admin/members/:userId/activities
router.get('/members/:userId/activities', async (req, res) => {
  const { userId } = req.params
  const clubId = req.club?.id ?? req.user?.club_id ?? null
  try {
    const userRes = await pool.query(
      'SELECT id,name,email,role,phone,avatar_url,created_at FROM users WHERE id=$1 AND club_id=$2',
      [userId, clubId]
    )
    if (!userRes.rows[0]) return res.status(404).json({ message: 'Member not found.' })

    const [bookingsRes, coachingRes, socialRes, hoursRes, coachSessionsRes] = await Promise.allSettled([
      pool.query(
        `SELECT b.booking_group_id, b.court_id,
                b.date, MIN(b.start_time) AS start_time, MAX(b.end_time) AS end_time, b.status
         FROM bookings b
         WHERE b.user_id=$1 AND b.status='confirmed' AND b.club_id=$2
         GROUP BY b.booking_group_id, b.court_id, b.date, b.status
         ORDER BY b.date DESC, MIN(b.start_time) ASC
         LIMIT 50`,
        [userId, clubId]
      ),
      pool.query(
        `SELECT cs.id, cs.coach_id, cs.student_id, cs.date, cs.start_time, cs.end_time, cs.notes,
                cs.recurrence_id, cs.group_id, cs.status,
                co.name AS coach_name,
                EXISTS(
                  SELECT 1 FROM check_ins ci
                  WHERE ci.type='coaching' AND ci.reference_id=cs.id::text AND ci.user_id=cs.student_id
                ) AS checked_in,
                COALESCE((
                  SELECT ci.no_show FROM check_ins ci
                  WHERE ci.type='coaching' AND ci.reference_id=cs.id::text AND ci.user_id=cs.student_id
                  LIMIT 1
                ), FALSE) AS no_show,
                cr.body           AS review_body,
                cr.skills         AS review_skills,
                cr.student_rating AS student_rating,
                cr.student_comment AS student_comment
         FROM coaching_sessions cs
         JOIN coaches co ON co.id = cs.coach_id
         LEFT JOIN coaching_reviews cr ON cr.session_id = cs.id
         WHERE cs.student_id=$1 AND cs.status='confirmed' AND cs.club_id=$2
         ORDER BY cs.date DESC, cs.start_time ASC
         LIMIT 50`,
        [userId, clubId]
      ),
      pool.query(
        `SELECT sps.id, sps.date, sps.start_time, sps.end_time,
                sps.status, sps.num_courts, sps.title
         FROM social_play_sessions sps
         JOIN social_play_participants spp ON spp.session_id = sps.id
         WHERE spp.user_id=$1 AND sps.status != 'cancelled' AND sps.club_id=$2
         ORDER BY sps.date DESC, sps.start_time ASC
         LIMIT 50`,
        [userId, clubId]
      ),
      pool.query(
        `SELECT COALESCE(SUM(delta), 0)::numeric AS balance
         FROM coaching_hour_ledger WHERE user_id=$1 AND club_id=$2`,
        [userId, clubId]
      ),
      pool.query(
        `SELECT cs.id, cs.date, cs.start_time, cs.end_time, cs.notes, cs.group_id,
                u.id AS student_id, u.name AS student_name,
                EXISTS(
                  SELECT 1 FROM check_ins ci
                  WHERE ci.type='coaching' AND ci.reference_id=cs.id::text AND ci.user_id=u.id
                ) AS checked_in
         FROM coaching_sessions cs
         JOIN users u ON u.id = cs.student_id
         WHERE cs.coach_id = (SELECT id FROM coaches WHERE user_id=$1 LIMIT 1)
           AND cs.status='confirmed' AND cs.club_id=$2
         ORDER BY cs.date DESC, cs.start_time ASC
         LIMIT 100`,
        [userId, clubId]
      ),
    ])

    res.json({
      member:        userRes.rows[0],
      bookings:      bookingsRes.status       === 'fulfilled' ? bookingsRes.value.rows       : [],
      coaching:      coachingRes.status       === 'fulfilled' ? coachingRes.value.rows       : [],
      social:        socialRes.status         === 'fulfilled' ? socialRes.value.rows         : [],
      coachSessions: coachSessionsRes.status  === 'fulfilled' ? coachSessionsRes.value.rows  : [],
      balance:       hoursRes.status === 'fulfilled' ? Math.round(parseFloat(hoursRes.value.rows[0].balance) * 100) / 100 : 0,
    })
  } catch (err) {
    console.error('member activities error:', err.message)
    res.status(500).json({ message: 'Server error.' })
  }
})

// GET /api/admin/bookings?date=YYYY-MM-DD
router.get('/bookings', async (req, res) => {
  const { date } = req.query
  const clubId = req.club?.id ?? req.user?.club_id ?? null
  try {
    const params = date ? [clubId, date] : [clubId]
    const { rows } = await pool.query(
      `SELECT
         b.booking_group_id,
         b.court_id,
         b.date,
         b.user_id,
         MIN(b.start_time)        AS start_time,
         MAX(b.end_time)          AS end_time,
         b.status,
         u.name                   AS user_name,
         u.email                  AS user_email,
         c.name                   AS court_name,
         MIN(b.payment_intent_id) AS payment_intent_id,
         MIN(b.payment_mode)      AS payment_mode
       FROM bookings b
       JOIN users u ON u.id  = b.user_id
       LEFT JOIN courts c ON c.id = b.court_id
       WHERE b.status = 'confirmed' AND b.club_id = $1 ${date ? 'AND b.date = $2' : ''}
       GROUP BY b.booking_group_id, b.court_id, b.date, b.user_id, b.status, u.name, u.email, c.name
       ORDER BY b.date DESC, MIN(b.start_time) DESC`,
      params
    )
    res.json({ bookings: rows })
  } catch { res.status(500).json({ message: 'Server error.' }) }
})

// POST /api/admin/settings-conflicts
// Body: { new_court_count?, schedule?: [{ day, is_active, start_time, end_time }] }
router.post('/settings-conflicts', async (req, res) => {
  const clubId = req.club?.id ?? req.user?.club_id ?? null
  const { new_court_count, schedule } = req.body
  const today = new Date().toISOString().slice(0, 10)
  const DOW = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 0 }
  const conflicts = []

  try {
    // ── 1. Court count reduction ──────────────────────────────────────────────
    if (new_court_count !== undefined) {
      const { rows: courts } = await pool.query(
        'SELECT id, name FROM courts WHERE club_id=$1 AND is_active=TRUE ORDER BY id',
        [clubId]
      )
      if (new_court_count < courts.length) {
        const deactivated = courts.slice(new_court_count).map(r => r.id)
        const { rows } = await pool.query(
          `SELECT DISTINCT ON (b.booking_group_id)
             b.date, MIN(b.start_time) AS start_time, MAX(b.end_time) AS end_time,
             u.name AS user_name, c.name AS court_name
           FROM bookings b
           JOIN users u ON u.id = b.user_id
           LEFT JOIN courts c ON c.id = b.court_id
           WHERE b.club_id=$1 AND b.status='confirmed' AND b.date >= $2
             AND b.court_id = ANY($3)
           GROUP BY b.booking_group_id, b.date, u.name, c.name
           ORDER BY b.booking_group_id, b.date`,
          [clubId, today, deactivated]
        )
        for (const r of rows) {
          conflicts.push({ type: 'booking', date: r.date, start_time: r.start_time, end_time: r.end_time, description: `${r.user_name} — ${r.court_name}`, reason: 'court_removed' })
        }
      }
    }

    // ── 2. Schedule changes ───────────────────────────────────────────────────
    if (Array.isArray(schedule)) {
      for (const day of schedule) {
        const dow = DOW[day.day]
        if (dow === undefined) continue

        if (!day.is_active) {
          const { rows: bRows } = await pool.query(
            `SELECT DISTINCT ON (b.booking_group_id)
               b.date, MIN(b.start_time) AS start_time, MAX(b.end_time) AS end_time, u.name AS user_name
             FROM bookings b JOIN users u ON u.id = b.user_id
             WHERE b.club_id=$1 AND b.status='confirmed' AND b.date >= $2
               AND EXTRACT(DOW FROM b.date) = $3
             GROUP BY b.booking_group_id, b.date, u.name
             ORDER BY b.booking_group_id, b.date`,
            [clubId, today, dow]
          )
          for (const r of bRows) conflicts.push({ type: 'booking', date: r.date, start_time: r.start_time, end_time: r.end_time, description: r.user_name, reason: 'day_closed' })

          const { rows: cRows } = await pool.query(
            `SELECT cs.date, cs.start_time, cs.end_time, u.name AS student_name, co.name AS coach_name
             FROM coaching_sessions cs
             JOIN users u ON u.id = cs.student_id
             JOIN coaches co ON co.id = cs.coach_id
             WHERE cs.club_id=$1 AND cs.status='confirmed' AND cs.date >= $2
               AND EXTRACT(DOW FROM cs.date) = $3
             ORDER BY cs.date`,
            [clubId, today, dow]
          )
          for (const r of cRows) conflicts.push({ type: 'coaching', date: r.date, start_time: r.start_time, end_time: r.end_time, description: `${r.student_name} × ${r.coach_name}`, reason: 'day_closed' })

          const { rows: sRows } = await pool.query(
            `SELECT date, start_time, end_time, title FROM social_play_sessions
             WHERE club_id=$1 AND status='open' AND date >= $2
               AND EXTRACT(DOW FROM date) = $3 ORDER BY date`,
            [clubId, today, dow]
          )
          for (const r of sRows) conflicts.push({ type: 'social', date: r.date, start_time: r.start_time, end_time: r.end_time, description: r.title, reason: 'day_closed' })

        } else {
          const { rows: bRows } = await pool.query(
            `SELECT DISTINCT ON (b.booking_group_id)
               b.date, MIN(b.start_time) AS start_time, MAX(b.end_time) AS end_time, u.name AS user_name
             FROM bookings b JOIN users u ON u.id = b.user_id
             WHERE b.club_id=$1 AND b.status='confirmed' AND b.date >= $2
               AND EXTRACT(DOW FROM b.date) = $3
             GROUP BY b.booking_group_id, b.date, u.name
             HAVING MIN(b.start_time) < $4::time OR MAX(b.end_time) > $5::time
             ORDER BY b.booking_group_id, b.date`,
            [clubId, today, dow, day.start_time, day.end_time]
          )
          for (const r of bRows) conflicts.push({ type: 'booking', date: r.date, start_time: r.start_time, end_time: r.end_time, description: r.user_name, reason: 'outside_hours' })

          const { rows: cRows } = await pool.query(
            `SELECT cs.date, cs.start_time, cs.end_time, u.name AS student_name, co.name AS coach_name
             FROM coaching_sessions cs
             JOIN users u ON u.id = cs.student_id
             JOIN coaches co ON co.id = cs.coach_id
             WHERE cs.club_id=$1 AND cs.status='confirmed' AND cs.date >= $2
               AND EXTRACT(DOW FROM cs.date) = $3
               AND (cs.start_time < $4::time OR cs.end_time > $5::time)
             ORDER BY cs.date`,
            [clubId, today, dow, day.start_time, day.end_time]
          )
          for (const r of cRows) conflicts.push({ type: 'coaching', date: r.date, start_time: r.start_time, end_time: r.end_time, description: `${r.student_name} × ${r.coach_name}`, reason: 'outside_hours' })

          const { rows: sRows } = await pool.query(
            `SELECT date, start_time, end_time, title FROM social_play_sessions
             WHERE club_id=$1 AND status='open' AND date >= $2
               AND EXTRACT(DOW FROM date) = $3
               AND (start_time < $4::time OR end_time > $5::time)
             ORDER BY date`,
            [clubId, today, dow, day.start_time, day.end_time]
          )
          for (const r of sRows) conflicts.push({ type: 'social', date: r.date, start_time: r.start_time, end_time: r.end_time, description: r.title, reason: 'outside_hours' })
        }
      }
    }

    res.json({ conflicts })
  } catch (err) {
    console.error('settings-conflicts error:', err)
    res.status(500).json({ message: 'Server error.' })
  }
})

// POST /api/admin/invites — generate a one-time coach invite link
router.post('/invites', requireAuth, requireAdmin, async (req, res) => {
  try {
    const clubId = req.club?.id ?? req.user?.club_id ?? null
    if (!clubId) return res.status(400).json({ message: 'No club found.' })
    const token = crypto.randomBytes(32).toString('hex')
    await pool.query(
      `INSERT INTO coach_invites (token, club_id, created_by) VALUES ($1, $2, $3)`,
      [token, clubId, req.user.id]
    )
    const url = `${process.env.FLINTHER_URL || 'https://flinther.com'}/register?invite=${token}`
    res.json({ url })
  } catch (err) {
    console.error(err)
    res.status(500).json({ message: 'Server error.' })
  }
})

module.exports = router
