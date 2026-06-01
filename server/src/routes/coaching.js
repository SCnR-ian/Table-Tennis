const router         = require('express').Router()
const pool           = require('../db')
const { requireAuth, requireAdmin } = require('../middleware/auth')
const { randomUUID } = require('crypto')
const { checkOpenHours, getCourtCount } = require('../utils/scheduleCheck')
const { sendCoachingScheduled } = require('../utils/email')

// ─── Time helpers ─────────────────────────────────────────────────────────────

function toMins(t) {
  const [h, m] = t.substring(0, 5).split(':').map(Number)
  return h * 60 + m
}
function minsToTime(mins) {
  return `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}:00`
}

// ─── Coaching hours helpers ───────────────────────────────────────────────────

function sessionHours(startTime, endTime) {
  const [sh, sm] = startTime.substring(0, 5).split(':').map(Number)
  const [eh, em] = endTime.substring(0, 5).split(':').map(Number)
  return ((eh * 60 + em) - (sh * 60 + sm)) / 60
}

// Deduct (or refund) hours for one student/session pair within a pg client transaction.
// After insert, checks new balance and notifies admin if it drops below zero.
async function ledgerEntry(client, userId, delta, note, sessionId, createdBy, clubId) {
  await client.query(
    `INSERT INTO coaching_hour_ledger (user_id, delta, note, session_id, created_by, club_id)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [userId, delta, note, sessionId ?? null, createdBy ?? null, clubId ?? null]
  )
  if (delta < 0) {
    const { rows: [bal] } = await client.query(
      `SELECT COALESCE(SUM(delta), 0)::numeric AS balance FROM coaching_hour_ledger WHERE user_id=$1 AND club_id=$2`,
      [userId, clubId ?? null]
    )
    if (Number(bal.balance) < 0) {
      pool.query(
        `SELECT a.id AS admin_id, u.name AS student_name
         FROM users a JOIN users u ON u.id=$1
         WHERE a.role='admin' AND a.club_id=$2 LIMIT 1`,
        [userId, clubId ?? null]
      ).then(({ rows: [row] }) => {
        if (!row) return
        const balance = Math.round(Number(bal.balance) * 100) / 100
        pool.query(
          `INSERT INTO messages (sender_id, recipient_id, body, club_id) VALUES ($1,$2,$3,$4)`,
          [userId, row.admin_id, `⚠️ Coaching balance alert: ${row.student_name}'s balance is now $${balance}.`, clubId ?? null]
        ).catch(() => {})
      }).catch(() => {})
    }
  }
}

// Send a system message from an admin to a member (fire-and-forget, never throws)
async function sendSystemMessage(senderId, recipientId, body) {
  try {
    const { rows: [msg] } = await pool.query(
      `INSERT INTO messages (sender_id, recipient_id, body) VALUES ($1, $2, $3) RETURNING id`,
      [senderId, recipientId, body]
    )
    // mark as read by sender so it doesn't show as unread for them
    await pool.query(
      'INSERT INTO message_reads (message_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [msg.id, senderId]
    )
  } catch (e) {
    console.error('[sendSystemMessage] failed:', e.message)
  }
}

// Format a date string (YYYY-MM-DD) as "Mon, 15 Jan 2024"
function fmtDate(dateStr) {
  return new Date(dateStr + 'T12:00:00Z').toLocaleDateString('en-AU', {
    weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC'
  })
}

// Format time range "HH:MM:SS" → "4:00 PM"
function fmtTime(t) {
  const [h, m] = t.split(':').map(Number)
  const ampm = h >= 12 ? 'PM' : 'AM'
  const h12  = h % 12 || 12
  return `${h12}:${String(m).padStart(2, '0')} ${ampm}`
}

// GET /api/coaching/daily?date=YYYY-MM-DD — no auth, returns all sessions for a date
router.get('/daily', async (req, res) => {
  const clubId = req.club?.id ?? req.user?.club_id ?? 1
  const date   = req.query.date || new Date().toISOString().slice(0, 10)
  try {
    const { rows } = await pool.query(
      `SELECT cs.id, cs.date, cs.start_time, cs.end_time, cs.group_id,
              u.name  AS student_name,
              co.name AS coach_name,
              co.id   AS coach_id
       FROM coaching_sessions cs
       JOIN users  u  ON u.id  = cs.student_id
       JOIN coaches co ON co.id = cs.coach_id
       WHERE cs.club_id=$1 AND cs.status='confirmed' AND cs.date=$2
       ORDER BY cs.start_time, co.name, u.name`,
      [clubId, date]
    )
    res.json({ date, sessions: rows })
  } catch (err) {
    console.error(err)
    res.status(500).json({ message: 'Server error.' })
  }
})

// GET /api/coaching/public/:coachId — no auth, returns coach info + upcoming sessions
router.get('/public/:coachId', async (req, res) => {
  const clubId = req.club?.id ?? req.user?.club_id ?? 1
  const today  = new Date().toISOString().slice(0, 10)
  try {
    const { rows: coachRows } = await pool.query(
      'SELECT id, name FROM coaches WHERE id=$1 AND club_id=$2 AND is_active=TRUE',
      [req.params.coachId, clubId]
    )
    if (!coachRows[0]) return res.status(404).json({ message: 'Coach not found.' })

    const { rows: sessions } = await pool.query(
      `SELECT cs.date, cs.start_time, cs.end_time, cs.group_id,
              u.name AS student_name
       FROM coaching_sessions cs
       JOIN users u ON u.id = cs.student_id
       WHERE cs.coach_id = $1 AND cs.club_id = $2
         AND cs.status = 'confirmed' AND cs.date >= $3
       ORDER BY cs.date, cs.start_time`,
      [req.params.coachId, clubId, today]
    )

    const { rows: bookings } = await pool.query(
      `SELECT DISTINCT b.date,
              MIN(b.start_time) AS start_time, MAX(b.end_time) AS end_time
       FROM bookings b
       WHERE b.club_id=$1 AND b.status='confirmed' AND b.date >= $2
       GROUP BY b.booking_group_id, b.date
       ORDER BY b.date`,
      [clubId, today]
    )

    res.json({ coach: coachRows[0], sessions, bookings })
  } catch (err) {
    console.error(err)
    res.status(500).json({ message: 'Server error.' })
  }
})

// ─── COACH CRUD (admin only) ──────────────────────────────────────────────────

// GET /api/coaching/coaches/public — no auth, returns name + avg rating per coach
router.get('/coaches/public', async (req, res) => {
  const clubId = req.club?.id ?? req.user?.club_id ?? null
  try {
    const { rows } = await pool.query(
      `SELECT c.id, c.name,
              ROUND(AVG(r.student_rating), 1)  AS avg_rating,
              COUNT(r.student_rating)::int      AS rating_count
       FROM coaches c
       LEFT JOIN coaching_reviews r
         ON r.coach_id = c.id AND r.student_rating IS NOT NULL
       WHERE c.club_id = $1 AND c.is_active = TRUE
       GROUP BY c.id, c.name
       ORDER BY c.name ASC`,
      [clubId]
    )
    res.json({ coaches: rows })
  } catch { res.status(500).json({ message: 'Server error.' }) }
})

// GET /api/coaching/coaches
router.get('/coaches', requireAuth, requireAdmin, async (req, res) => {
  const clubId = req.club?.id ?? req.user?.club_id ?? null
  try {
    const { rows } = await pool.query(
      `SELECT co.*, u.email, u.phone FROM coaches co
       JOIN users u ON u.id = co.user_id
       WHERE co.user_id IS NOT NULL AND u.role = 'coach'
         AND co.club_id=$1
       ORDER BY co.name ASC`,
      [clubId]
    )
    res.json({ coaches: rows })
  } catch { res.status(500).json({ message: 'Server error.' }) }
})

// POST /api/coaching/coaches  — body: { name, bio, user_id? }
// If user_id is provided, the linked user's role is set to 'coach'.
router.post('/coaches', requireAuth, requireAdmin, async (req, res) => {
  const clubId = req.club?.id ?? req.user?.club_id ?? null
  const { name, bio, user_id } = req.body
  if (!name?.trim()) return res.status(400).json({ message: 'name is required.' })
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const { rows } = await client.query(
      'INSERT INTO coaches (name, bio, user_id, club_id) VALUES ($1, $2, $3, $4) RETURNING *',
      [name.trim(), bio ?? null, user_id ?? null, clubId]
    )
    if (user_id) {
      // Verify the user belongs to the same club before promoting their role
      const { rows: userCheck } = await client.query(
        'SELECT id FROM users WHERE id=$1 AND club_id=$2', [user_id, clubId]
      )
      if (!userCheck[0]) {
        await client.query('ROLLBACK')
        return res.status(404).json({ message: 'User not found in this club.' })
      }
      await client.query("UPDATE users SET role='coach' WHERE id=$1", [user_id])
    }
    await client.query('COMMIT')
    res.status(201).json({ coach: rows[0] })
  } catch (err) {
    await client.query('ROLLBACK')
    if (err.code === '23505') return res.status(409).json({ message: 'That user is already linked to a coach.' })
    res.status(500).json({ message: 'Server error.' })
  } finally {
    client.release()
  }
})

// DELETE /api/coaching/coaches/by-user/:userId  — remove coach record by linked user id
router.delete('/coaches/by-user/:userId', requireAuth, requireAdmin, async (req, res) => {
  const clubId = req.club?.id ?? req.user?.club_id ?? null
  try {
    await pool.query('DELETE FROM coaches WHERE user_id=$1 AND club_id=$2', [req.params.userId, clubId])
    res.json({ message: 'Coach removed.' })
  } catch (err) {
    if (err.code === '23503')
      return res.status(409).json({ message: 'Cannot delete coach with existing sessions.' })
    res.status(500).json({ message: 'Server error.' })
  }
})

// DELETE /api/coaching/coaches/:id
router.delete('/coaches/:id', requireAuth, requireAdmin, async (req, res) => {
  const clubId = req.club?.id ?? req.user?.club_id ?? null
  try {
    const { rowCount } = await pool.query('DELETE FROM coaches WHERE id=$1 AND club_id=$2', [req.params.id, clubId])
    if (rowCount === 0) return res.status(404).json({ message: 'Coach not found.' })
    res.json({ message: 'Coach deleted.' })
  } catch (err) {
    if (err.code === '23503')
      return res.status(409).json({ message: 'Cannot delete coach with existing sessions.' })
    res.status(500).json({ message: 'Server error.' })
  }
})

// ─── SESSION CRUD (admin only) ────────────────────────────────────────────────

// GET /api/coaching/sessions?date=YYYY-MM-DD
router.get('/sessions', requireAuth, requireAdmin, async (req, res) => {
  const clubId = req.club?.id ?? req.user?.club_id ?? null
  const { date } = req.query
  try {
    const { rows } = await pool.query(
      `SELECT
         cs.*,
         c.name  AS coach_name,
         u.name  AS student_name,
         u.email AS student_email,
         ct.name AS court_name,
         EXISTS(
           SELECT 1 FROM check_ins ci
           WHERE ci.type='coaching'
             AND ci.reference_id = cs.id::text
             AND ci.user_id = cs.student_id
         ) AS checked_in,
         EXISTS(
           SELECT 1 FROM check_ins ci
           WHERE ci.type='coaching'
             AND ci.reference_id = cs.id::text
             AND ci.checked_in_by IS NOT NULL
         ) AS admin_checked_in,
         EXISTS(
           SELECT 1 FROM group_session_leaves gsl
           WHERE gsl.session_id = cs.id AND gsl.student_id = cs.student_id
         ) AS is_makeup,
         cr.body             AS review_body,
         cr.skills           AS review_skills,
         cr.student_rating   AS student_rating,
         cr.student_comment  AS student_comment
       FROM coaching_sessions cs
       JOIN coaches c  ON c.id  = cs.coach_id
       JOIN users   u  ON u.id  = cs.student_id
       LEFT JOIN courts  ct ON ct.id = cs.court_id
       LEFT JOIN coaching_reviews cr ON cr.session_id = cs.id
       WHERE cs.status = 'confirmed'
         AND cs.club_id = $1
         ${date ? 'AND cs.date = $2' : ''}
       ORDER BY cs.date ASC, cs.start_time ASC`,
      date ? [clubId, date] : [clubId]
    )
    res.json({ sessions: rows })
  } catch { res.status(500).json({ message: 'Server error.' }) }
})

// POST /api/coaching/sessions
// body: { coach_id, student_id, date, start_time, end_time, notes, weeks, recurrence_id? }
// court_id is auto-assigned (first court not blocked by bookings or coaching at that time)
// weeks >= 2 → generate that many weekly instances sharing a recurrence_id
// Pass recurrence_id to append new sessions into an existing series (e.g. makeup sessions)
router.post('/sessions', requireAuth, requireAdmin, async (req, res) => {
  const clubId = req.club?.id ?? req.user?.club_id ?? null
  const { coach_id, student_id, date, start_time, end_time, notes, weeks, recurrence_id: existingRecurrenceId } = req.body

  if (!coach_id || !student_id || !date || !start_time || !end_time)
    return res.status(400).json({ message: 'coach_id, student_id, date, start_time and end_time are required.' })

  const [sh, sm] = start_time.split(':').map(Number)
  const [eh, em] = end_time.split(':').map(Number)
  if (eh * 60 + em <= sh * 60 + sm)
    return res.status(400).json({ message: 'end_time must be after start_time.' })

  const numWeeks     = Number(weeks) >= 1 ? Math.min(Number(weeks), 52) : 1
  const recurrenceId = existingRecurrenceId || (numWeeks > 1 ? randomUUID() : null)

  // Build the list of weekly dates starting from `date`
  const dates = []
  const base  = new Date(date + 'T12:00:00Z')
  for (let i = 0; i < numWeeks; i++) {
    const d = new Date(base)
    d.setUTCDate(d.getUTCDate() + i * 7)
    dates.push(d.toISOString().slice(0, 10))
  }

  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    const scheduleError = await checkOpenHours(date, start_time, end_time, clubId)
    if (scheduleError) {
      await client.query('ROLLBACK')
      return res.status(409).json({ message: scheduleError })
    }

    // Fetch the coach's linked user_id once (for conflict checks on their personal schedule)
    const { rows: coachRows } = await client.query(
      'SELECT user_id FROM coaches WHERE id=$1 AND club_id=$2',
      [coach_id, clubId]
    )
    if (!coachRows[0]) {
      await client.query('ROLLBACK')
      return res.status(404).json({ message: 'Coach not found.' })
    }
    const coachUserId = coachRows[0].user_id

    const inserted = []
    const skipped  = []   // dates skipped due to no court available
    for (const sessionDate of dates) {
      // ── Conflict checks first so errors are always specific ──

      // Ensure the coach is not already teaching another session at this time
      const { rows: coachBusy } = await client.query(
        `SELECT 1 FROM coaching_sessions
         WHERE coach_id=$1 AND date=$2 AND status='confirmed' AND club_id=$5
           AND start_time < $4::time AND end_time > $3::time LIMIT 1`,
        [coach_id, sessionDate, start_time, end_time, clubId]
      )
      if (coachBusy.length)
        throw Object.assign(new Error('coach_conflict'), { sessionDate, reason: 'coaching' })

      // If the coach has a linked user account, also check their personal booking/social schedule
      if (coachUserId) {
        const { rows: coachBook } = await client.query(
          `SELECT 1 FROM bookings
           WHERE user_id=$1 AND date=$2 AND status='confirmed' AND club_id=$5
             AND start_time < $4::time AND end_time > $3::time LIMIT 1`,
          [coachUserId, sessionDate, start_time, end_time, clubId]
        )
        if (coachBook.length)
          throw Object.assign(new Error('coach_conflict'), { sessionDate, reason: 'booking' })

        const { rows: coachSocial } = await client.query(
          `SELECT 1 FROM social_play_sessions sps
           JOIN social_play_participants spp ON spp.session_id = sps.id
           WHERE spp.user_id=$1 AND sps.date=$2 AND sps.status='open' AND sps.club_id=$5
             AND sps.start_time < $4::time AND sps.end_time > $3::time LIMIT 1`,
          [coachUserId, sessionDate, start_time, end_time, clubId]
        )
        if (coachSocial.length)
          throw Object.assign(new Error('coach_conflict'), { sessionDate, reason: 'social' })
      }

      // Ensure student has no regular booking overlapping this time
      const { rows: stdBook } = await client.query(
        `SELECT 1 FROM bookings
         WHERE user_id=$1 AND date=$2 AND status='confirmed' AND club_id=$5
           AND start_time < $4::time AND end_time > $3::time LIMIT 1`,
        [student_id, sessionDate, start_time, end_time, clubId]
      )
      if (stdBook.length)
        throw Object.assign(new Error('student_conflict'), { sessionDate, reason: 'booking' })

      // Ensure student has no social play sign-up overlapping this time
      const { rows: stdSocial } = await client.query(
        `SELECT 1 FROM social_play_sessions sps
         JOIN social_play_participants spp ON spp.session_id = sps.id
         WHERE spp.user_id=$1 AND sps.date=$2 AND sps.status='open' AND sps.club_id=$5
           AND sps.start_time < $4::time AND sps.end_time > $3::time LIMIT 1`,
        [student_id, sessionDate, start_time, end_time, clubId]
      )
      if (stdSocial.length)
        throw Object.assign(new Error('student_conflict'), { sessionDate, reason: 'social' })

      // Ensure student has no other coaching session overlapping this time
      const { rows: stdCoaching } = await client.query(
        `SELECT 1 FROM coaching_sessions
         WHERE student_id=$1 AND date=$2 AND status='confirmed' AND club_id=$5
           AND start_time < $4::time AND end_time > $3::time LIMIT 1`,
        [student_id, sessionDate, start_time, end_time, clubId]
      )
      if (stdCoaching.length)
        throw Object.assign(new Error('student_conflict'), { sessionDate, reason: 'coaching' })

      // ── Auto-assign the first court not blocked by bookings or coaching,
      //    accounting for social sessions as a court count (not specific IDs).
      //    Social sessions don't own specific courts, so we check that the
      //    number of free courts exceeds what social sessions need, then pick
      //    the first free court.
      const { rows: free } = await client.query(
        `WITH social_count AS (
           SELECT COALESCE(MAX(num_courts), 0)::int AS total
           FROM social_play_sessions
           WHERE date = $1 AND status = 'open' AND club_id = $5
             AND start_time < $3::time AND end_time > $2::time
         ),
         free_courts AS (
           SELECT c.id
           FROM courts c
           WHERE c.club_id = $5
           AND c.id NOT IN (
             SELECT cs2.court_id FROM coaching_sessions cs2
             WHERE cs2.date = $1 AND cs2.status = 'confirmed' AND cs2.club_id = $5
               AND cs2.court_id IS NOT NULL
               AND cs2.start_time < $3::time AND cs2.end_time > $2::time
           )
           AND c.id NOT IN (
             SELECT b.court_id FROM bookings b
             WHERE b.date = $1 AND b.status = 'confirmed' AND b.club_id = $5
               AND b.court_id IS NOT NULL
               AND b.start_time < $3::time AND b.end_time > $2::time
           )
         ),
         free_count AS (SELECT COUNT(*)::int AS n FROM free_courts),
         adj_court AS (
           SELECT court_id FROM coaching_sessions
           WHERE coach_id = $4 AND date = $1 AND status = 'confirmed' AND club_id = $5
             AND (end_time = $2::time OR start_time = $3::time)
           LIMIT 1
         )
         SELECT fc.id
         FROM free_courts fc, free_count fcnt, social_count sc
         WHERE fcnt.n > sc.total
         ORDER BY
           CASE WHEN fc.id = (SELECT court_id FROM adj_court) THEN 0 ELSE 1 END,
           fc.id
         LIMIT 1`,
        [sessionDate, start_time, end_time, coach_id, clubId]
      )
      if (!free[0]) {
        skipped.push(sessionDate)
        continue   // no court this week — skip rather than abort the whole batch
      }

      const { rows } = await client.query(
        `INSERT INTO coaching_sessions
           (coach_id, student_id, court_id, date, start_time, end_time, notes, recurrence_id, club_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         RETURNING *`,
        [coach_id, student_id, free[0].id, sessionDate, start_time, end_time, notes ?? null, recurrenceId, clubId]
      )
      inserted.push(rows[0])
    }
    await client.query('COMMIT')

    // Notify the student
    const { rows: [coachInfo] } = await pool.query(
      'SELECT name FROM coaches WHERE id=$1', [coach_id]
    )
    const coachName = coachInfo?.name ?? 'your coach'
    const timeRange = `${fmtTime(start_time)} – ${fmtTime(end_time)}`
    let msgBody
    if (inserted.length === 1) {
      msgBody = `📅 A coaching session has been scheduled for you.\nCoach: ${coachName}\nDate: ${fmtDate(inserted[0].date)}\nTime: ${timeRange}`
    } else {
      const lines = inserted.map(s => `  • ${fmtDate(s.date)}`).join('\n')
      msgBody = `📅 ${inserted.length} coaching sessions have been scheduled for you.\nCoach: ${coachName}\nTime: ${timeRange}\n${lines}`
    }
    if (notes) msgBody += `\nNotes: ${notes}`
    await sendSystemMessage(req.user.id, student_id, msgBody)

    // Confirmation email to student (fire-and-forget)
    pool.query('SELECT email, name FROM users WHERE id=$1', [student_id])
      .then(({ rows: [u] }) => {
        if (!u) return
        sendCoachingScheduled({
          to: u.email, name: u.name, coachName,
          dates: inserted.map(s => s.date),
          start_time, end_time, notes,
        }).catch(() => {})
      }).catch(() => {})

    res.status(201).json({ sessions: inserted, recurrence_id: recurrenceId, skipped })
  } catch (err) {
    await client.query('ROLLBACK')
    if (err.message === 'no_court')
      return res.status(409).json({ message: `No courts available on ${err.sessionDate} at that time. ${err.detail ?? ''}`.trim() })
    if (err.message === 'student_conflict') {
      const what = err.reason === 'booking' ? 'a court booking' : err.reason === 'social' ? 'a social play session' : 'another coaching session'
      return res.status(409).json({ message: `Student already has ${what} on ${err.sessionDate} at that time.` })
    }
    if (err.message === 'coach_conflict') {
      const what = err.reason === 'coaching' ? 'another session to teach' : err.reason === 'booking' ? 'a court booking' : 'a social play session'
      return res.status(409).json({ message: `Coach already has ${what} on ${err.sessionDate} at that time.` })
    }
    if (err.code === '23505') {
      if (err.constraint === 'coaching_no_coach_overlap')
        return res.status(409).json({ message: 'Coach already has another session to teach at that time.' })
      if (err.constraint === 'coaching_no_student_overlap')
        return res.status(409).json({ message: 'Student already has another coaching session at that time.' })
      if (err.constraint === 'coaching_no_court_overlap')
        return res.status(409).json({ message: 'That court is already booked for coaching at that time.' })
      return res.status(409).json({ message: 'One or more sessions conflict with an existing booking.' })
    }
    res.status(500).json({ message: 'Server error.' })
  } finally {
    client.release()
  }
})

// GET /api/coaching/sessions/groups?date=YYYY-MM-DD  (admin) — group sessions, each row = one group
router.get('/sessions/groups', requireAuth, requireAdmin, async (req, res) => {
  const clubId = req.club?.id ?? req.user?.club_id ?? null
  const { date } = req.query
  try {
    const { rows } = await pool.query(
      `SELECT
         cs.group_id,
         cs.date,
         cs.start_time,
         cs.end_time,
         cs.notes,
         cs.court_id,
         ct.name                   AS court_name,
         cs.coach_id,
         co.name                   AS coach_name,
         array_agg(u.id ORDER BY u.name)     AS student_ids,
         array_agg(u.name ORDER BY u.name)   AS student_names,
         array_agg(u.email ORDER BY u.name)  AS student_emails,
         array_agg(cs.id ORDER BY u.name)    AS session_ids,
         array_agg(
           EXISTS(
             SELECT 1 FROM check_ins ci
             WHERE ci.type='coaching'
               AND ci.reference_id = cs.id::text
               AND ci.user_id = cs.student_id
           ) ORDER BY u.name
         ) AS checked_ins,
         array_agg(
           EXISTS(
             SELECT 1 FROM check_ins ci
             WHERE ci.type='coaching'
               AND ci.reference_id = cs.id::text
               AND ci.checked_in_by IS NOT NULL
           ) ORDER BY u.name
         ) AS admin_checked_ins,
         array_agg(
           (SELECT COUNT(*)::int FROM group_session_leaves gl
            WHERE gl.group_id = cs.group_id AND gl.student_id = cs.student_id)
           ORDER BY u.name
         ) AS leave_used,
         array_agg(
           EXISTS(
             SELECT 1 FROM group_session_leaves gsl
             WHERE gsl.session_id = cs.id AND gsl.student_id = cs.student_id
           ) ORDER BY u.name
         ) AS session_is_makeup,
         (SELECT COALESCE(json_object_agg(gsl.student_id::text, gsl.cnt), '{}')
          FROM (
            SELECT student_id, COUNT(*)::int AS cnt
            FROM group_session_leaves
            WHERE group_id = cs.group_id
            GROUP BY student_id
          ) gsl
         ) AS group_leave_map
       FROM coaching_sessions cs
       JOIN coaches co ON co.id  = cs.coach_id
       JOIN users   u  ON u.id   = cs.student_id
       LEFT JOIN courts  ct ON ct.id  = cs.court_id
       WHERE cs.status = 'confirmed'
         AND cs.club_id = $1
         AND cs.group_id IS NOT NULL
         ${date ? 'AND cs.date = $2' : ''}
       GROUP BY cs.group_id, cs.date, cs.start_time, cs.end_time,
                cs.notes, cs.court_id, ct.name, cs.coach_id, co.name
       ORDER BY cs.date ASC, cs.start_time ASC`,
      date ? [clubId, date] : [clubId]
    )
    res.json({ groups: rows })
  } catch { res.status(500).json({ message: 'Server error.' }) }
})

// POST /api/coaching/sessions/group  (admin)
// body: { coach_id, student_ids: [id,...] (2-5), date, start_time, end_time, notes, weeks }
// All students share ONE court and ONE group_id. Each student gets their own recurrence_id series.
router.post('/sessions/group', requireAuth, requireAdmin, async (req, res) => {
  const clubId = req.club?.id ?? req.user?.club_id ?? null
  const { coach_id, student_ids, date, start_time, end_time, notes, weeks } = req.body

  if (!coach_id || !Array.isArray(student_ids) || !date || !start_time || !end_time)
    return res.status(400).json({ message: 'coach_id, student_ids, date, start_time and end_time are required.' })

  if (student_ids.length < 2 || student_ids.length > 5)
    return res.status(400).json({ message: 'Group sessions require 2–5 students.' })

  const [sh, sm] = start_time.split(':').map(Number)
  const [eh, em] = end_time.split(':').map(Number)
  if (eh * 60 + em <= sh * 60 + sm)
    return res.status(400).json({ message: 'end_time must be after start_time.' })

  const numWeeks = Number(weeks) >= 1 ? Math.min(Number(weeks), 52) : 1
  const groupId  = randomUUID()

  // Each student gets their own recurrence_id (for their individual series count)
  const recurrenceIds = student_ids.map(() => numWeeks > 1 ? randomUUID() : null)

  const dates = []
  const base  = new Date(date + 'T12:00:00Z')
  for (let i = 0; i < numWeeks; i++) {
    const d = new Date(base)
    d.setUTCDate(d.getUTCDate() + i * 7)
    dates.push(d.toISOString().slice(0, 10))
  }

  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    const scheduleError = await checkOpenHours(date, start_time, end_time, clubId)
    if (scheduleError) {
      await client.query('ROLLBACK')
      return res.status(409).json({ message: scheduleError })
    }

    // Validate coach exists
    const { rows: coachRows } = await client.query('SELECT user_id FROM coaches WHERE id=$1 AND club_id=$2', [coach_id, clubId])
    if (!coachRows[0]) {
      await client.query('ROLLBACK')
      return res.status(404).json({ message: 'Coach not found.' })
    }
    const coachUserId = coachRows[0].user_id

    const inserted = []

    for (const sessionDate of dates) {
      // ── Coach conflict: can't teach another session at same time
      const { rows: coachBusy } = await client.query(
        `SELECT 1 FROM coaching_sessions
         WHERE coach_id=$1 AND date=$2 AND status='confirmed' AND club_id=$5
           AND start_time < $4::time AND end_time > $3::time LIMIT 1`,
        [coach_id, sessionDate, start_time, end_time, clubId]
      )
      if (coachBusy.length)
        throw Object.assign(new Error('coach_conflict'), { sessionDate, reason: 'coaching' })

      if (coachUserId) {
        const { rows: coachBook } = await client.query(
          `SELECT 1 FROM bookings
           WHERE user_id=$1 AND date=$2 AND status='confirmed' AND club_id=$5
             AND start_time < $4::time AND end_time > $3::time LIMIT 1`,
          [coachUserId, sessionDate, start_time, end_time, clubId]
        )
        if (coachBook.length)
          throw Object.assign(new Error('coach_conflict'), { sessionDate, reason: 'booking' })

        const { rows: coachSocial } = await client.query(
          `SELECT 1 FROM social_play_sessions sps
           JOIN social_play_participants spp ON spp.session_id = sps.id
           WHERE spp.user_id=$1 AND sps.date=$2 AND sps.status='open' AND sps.club_id=$5
             AND sps.start_time < $4::time AND sps.end_time > $3::time LIMIT 1`,
          [coachUserId, sessionDate, start_time, end_time, clubId]
        )
        if (coachSocial.length)
          throw Object.assign(new Error('coach_conflict'), { sessionDate, reason: 'social' })
      }

      // ── Per-student conflict checks
      for (const sid of student_ids) {
        const { rows: stdBook } = await client.query(
          `SELECT 1 FROM bookings
           WHERE user_id=$1 AND date=$2 AND status='confirmed' AND club_id=$5
             AND start_time < $4::time AND end_time > $3::time LIMIT 1`,
          [sid, sessionDate, start_time, end_time, clubId]
        )
        if (stdBook.length)
          throw Object.assign(new Error('student_conflict'), { sessionDate, reason: 'booking', studentId: sid })

        const { rows: stdSocial } = await client.query(
          `SELECT 1 FROM social_play_sessions sps
           JOIN social_play_participants spp ON spp.session_id = sps.id
           WHERE spp.user_id=$1 AND sps.date=$2 AND sps.status='open' AND sps.club_id=$5
             AND sps.start_time < $4::time AND sps.end_time > $3::time LIMIT 1`,
          [sid, sessionDate, start_time, end_time, clubId]
        )
        if (stdSocial.length)
          throw Object.assign(new Error('student_conflict'), { sessionDate, reason: 'social', studentId: sid })

        const { rows: stdCoaching } = await client.query(
          `SELECT 1 FROM coaching_sessions
           WHERE student_id=$1 AND date=$2 AND status='confirmed' AND club_id=$5
             AND start_time < $4::time AND end_time > $3::time LIMIT 1`,
          [sid, sessionDate, start_time, end_time, clubId]
        )
        if (stdCoaching.length)
          throw Object.assign(new Error('student_conflict'), { sessionDate, reason: 'coaching', studentId: sid })
      }

      // ── Auto-assign ONE court for the whole group
      const { rows: free } = await client.query(
        `WITH social_count AS (
           SELECT COALESCE(SUM(num_courts), 0)::int AS total
           FROM social_play_sessions
           WHERE date = $1 AND status = 'open' AND club_id = $4
             AND start_time < $3::time AND end_time > $2::time
         ),
         free_courts AS (
           SELECT c.id,
                  ROW_NUMBER() OVER (ORDER BY c.id) AS rn
           FROM courts c
           WHERE c.club_id = $4
           AND c.id NOT IN (
             SELECT DISTINCT cs2.court_id FROM coaching_sessions cs2
             WHERE cs2.date = $1 AND cs2.status = 'confirmed' AND cs2.club_id = $4
               AND cs2.start_time < $3::time AND cs2.end_time > $2::time
           )
           AND c.id NOT IN (
             SELECT b.court_id FROM bookings b
             WHERE b.date = $1 AND b.status = 'confirmed' AND b.club_id = $4
               AND b.start_time < $3::time AND b.end_time > $2::time
           )
         )
         SELECT fc.id
         FROM free_courts fc, social_count sc
         WHERE fc.rn > sc.total
         ORDER BY fc.rn
         LIMIT 1`,
        [sessionDate, start_time, end_time, clubId]
      )
      if (!free[0])
        throw Object.assign(new Error('no_court'), { sessionDate })

      const courtId = free[0].id

      // ── Insert one row per student, all sharing group_id and courtId
      for (let i = 0; i < student_ids.length; i++) {
        const { rows } = await client.query(
          `INSERT INTO coaching_sessions
             (coach_id, student_id, court_id, date, start_time, end_time, notes, recurrence_id, group_id, club_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
           RETURNING *`,
          [coach_id, student_ids[i], courtId, sessionDate, start_time, end_time,
           notes ?? null, recurrenceIds[i], groupId, clubId]
        )
        inserted.push(rows[0])
      }
    }

    await client.query('COMMIT')

    // ── Notify each student about their scheduled sessions
    try {
      const { rows: [coachInfo] } = await pool.query('SELECT name FROM coaches WHERE id=$1', [coach_id])
      const coachName = coachInfo?.name ?? 'your coach'
      const timeRange = `${fmtTime(start_time)} – ${fmtTime(end_time)}`
      // Group inserted sessions by student_id
      const byStudent = {}
      for (const s of inserted) {
        if (!byStudent[s.student_id]) byStudent[s.student_id] = []
        byStudent[s.student_id].push(s)
      }
      for (const [sid, sessions] of Object.entries(byStudent)) {
        let msgBody
        if (sessions.length === 1) {
          msgBody = `📅 A coaching session has been scheduled for you.\nCoach: ${coachName}\nDate: ${fmtDate(sessions[0].date)}\nTime: ${timeRange}`
        } else {
          const lines = sessions.map(s => `  • ${fmtDate(s.date)}`).join('\n')
          msgBody = `📅 ${sessions.length} coaching sessions have been scheduled for you.\nCoach: ${coachName}\nTime: ${timeRange}\n${lines}`
        }
        if (notes) msgBody += `\nNote: ${notes}`
        await sendSystemMessage(req.user.id, parseInt(sid, 10), msgBody)
      }
    } catch (e) { console.error('[group session notify] failed:', e.message) }

    res.status(201).json({ sessions: inserted, group_id: groupId })
  } catch (err) {
    await client.query('ROLLBACK')
    if (err.message === 'no_court')
      return res.status(409).json({ message: `No courts available on ${err.sessionDate} at that time. ${err.detail ?? ''}`.trim() })
    if (err.message === 'student_conflict') {
      const what = err.reason === 'booking' ? 'a court booking' : err.reason === 'social' ? 'a social play session' : 'another coaching session'
      return res.status(409).json({ message: `A student already has ${what} on ${err.sessionDate} at that time.` })
    }
    if (err.message === 'coach_conflict') {
      const what = err.reason === 'coaching' ? 'another session to teach' : err.reason === 'booking' ? 'a court booking' : 'a social play session'
      return res.status(409).json({ message: `Coach already has ${what} on ${err.sessionDate} at that time.` })
    }
    res.status(500).json({ message: 'Server error.' })
  } finally {
    client.release()
  }
})

// POST /api/coaching/sessions/group/:groupId/add-student  (admin)
// body: { student_id, from_date? }  — adds student to all confirmed sessions from from_date onwards
router.post('/sessions/group/:groupId/add-student', requireAuth, requireAdmin, async (req, res) => {
  const clubId = req.club?.id ?? req.user?.club_id ?? null
  const { student_id, from_date } = req.body
  if (!student_id) return res.status(400).json({ message: 'student_id is required.' })

  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    // Fetch one representative row per remaining date in this group
    const fromDate = from_date || new Date().toISOString().slice(0, 10)
    const { rows: sessions } = await client.query(
      `SELECT DISTINCT ON (date) *
       FROM coaching_sessions
       WHERE group_id=$1 AND status='confirmed' AND date >= $2 AND club_id=$3
       ORDER BY date ASC`,
      [req.params.groupId, fromDate, clubId]
    )
    if (sessions.length === 0) {
      await client.query('ROLLBACK')
      return res.status(404).json({ message: 'No remaining sessions found for this group.' })
    }

    // Check student isn't already in this group
    const { rows: existing } = await client.query(
      `SELECT 1 FROM coaching_sessions
       WHERE group_id=$1 AND student_id=$2 AND status='confirmed' AND club_id=$3 LIMIT 1`,
      [req.params.groupId, student_id, clubId]
    )
    if (existing.length) {
      await client.query('ROLLBACK')
      return res.status(409).json({ message: 'Student is already in this group.' })
    }

    // Check max 5 students per session — verify every affected date won't exceed 5
    for (const s of sessions) {
      const { rows: [cnt] } = await client.query(
        `SELECT COUNT(DISTINCT student_id)::int AS n FROM coaching_sessions
         WHERE group_id=$1 AND date=$2 AND status='confirmed' AND club_id=$3`,
        [req.params.groupId, s.date, clubId]
      )
      if (cnt.n >= 5) {
        await client.query('ROLLBACK')
        return res.status(409).json({ message: `Adding this student would exceed 5 students on ${s.date}.` })
      }
    }

    const recurrenceId = sessions.length > 1 ? randomUUID() : null

    const inserted = []
    for (const s of sessions) {
      const { rows } = await client.query(
        `INSERT INTO coaching_sessions
           (coach_id, student_id, court_id, date, start_time, end_time, notes, recurrence_id, group_id, club_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         RETURNING *`,
        [s.coach_id, student_id, s.court_id, s.date, s.start_time, s.end_time,
         s.notes, recurrenceId, s.group_id, clubId]
      )
      inserted.push(rows[0])
    }

    await client.query('COMMIT')

    // ── Notify the added student
    try {
      const rep = sessions[0]
      const { rows: [coachInfo] } = await pool.query('SELECT name FROM coaches WHERE id=$1', [rep.coach_id])
      const coachName = coachInfo?.name ?? 'your coach'
      const timeRange = `${fmtTime(rep.start_time)} – ${fmtTime(rep.end_time)}`
      let msgBody
      if (inserted.length === 1) {
        msgBody = `📅 You have been added to a group coaching session.\nCoach: ${coachName}\nDate: ${fmtDate(inserted[0].date)}\nTime: ${timeRange}`
      } else {
        const lines = inserted.map(s => `  • ${fmtDate(s.date)}`).join('\n')
        msgBody = `📅 You have been added to ${inserted.length} group coaching sessions.\nCoach: ${coachName}\nTime: ${timeRange}\n${lines}`
      }
      if (rep.notes) msgBody += `\nNote: ${rep.notes}`
      await sendSystemMessage(req.user.id, student_id, msgBody)
    } catch (e) { console.error('[add-student notify] failed:', e.message) }

    res.status(201).json({ sessions: inserted, count: inserted.length })
  } catch (err) {
    await client.query('ROLLBACK')
    if (err.code === '23505')
      return res.status(409).json({ message: 'Student already has a coaching session at that time on one of these dates.' })
    res.status(500).json({ message: 'Server error.' })
  } finally { client.release() }
})

// DELETE /api/coaching/sessions/group/:groupId/remove-student/:studentId  (admin)
// Cancels confirmed sessions for one student in the group from from_date onwards
// Query param: from_date (defaults to today)
router.delete('/sessions/group/:groupId/remove-student/:studentId', requireAuth, requireAdmin, async (req, res) => {
  const clubId = req.club?.id ?? req.user?.club_id ?? null
  const fromDate = req.query.from_date || new Date().toISOString().slice(0, 10)

  // Check min 1 student — ensure no affected date would drop to 0
  const { rows: dateCounts } = await pool.query(
    `SELECT date, COUNT(DISTINCT student_id)::int AS n
     FROM coaching_sessions
     WHERE group_id=$1 AND status='confirmed' AND date >= $2 AND club_id=$3
     GROUP BY date`,
    [req.params.groupId, fromDate, clubId]
  )
  const wouldEmpty = dateCounts.some(r => r.n <= 1)
  if (wouldEmpty) {
    return res.status(409).json({ message: 'Cannot remove this student — at least 1 student must remain in each session.' })
  }

  const { rows } = await pool.query(
    `UPDATE coaching_sessions SET status='cancelled'
     WHERE group_id=$1 AND student_id=$2 AND status='confirmed' AND date >= $3 AND club_id=$4
     RETURNING id, date, start_time, end_time, student_id`,
    [req.params.groupId, req.params.studentId, fromDate, clubId]
  )
  // Mark sessions that were already checked in (hours already deducted, skip refund)
  if (rows.length > 0) {
    const ids = rows.map(r => r.id)
    const { rows: checkedRows } = await pool.query(
      `SELECT DISTINCT session_id FROM coaching_hour_ledger WHERE session_id = ANY($1) AND delta < 0 AND club_id=$2`,
      [ids, clubId]
    )
    const checkedSet = new Set(checkedRows.map(r => r.session_id))
    rows.forEach(r => { r.checked_in = checkedSet.has(r.id) })
  }
  res.json({ cancelled: rows.length, sessions: rows })
})

// DELETE /api/coaching/sessions/group/:groupId  (admin) — cancel all confirmed sessions in a group
router.delete('/sessions/group/:groupId', requireAuth, requireAdmin, async (req, res) => {
  const clubId = req.club?.id ?? req.user?.club_id ?? null
  const client = await pool.connect()
  try {
    const { rowCount } = await client.query(
      `UPDATE coaching_sessions SET status='cancelled' WHERE group_id=$1 AND status='confirmed' AND club_id=$2`,
      [req.params.groupId, clubId]
    )
    if (rowCount === 0) return res.status(404).json({ message: 'Group not found.' })
    res.json({ message: 'Group sessions cancelled.' })
  } catch {
    res.status(500).json({ message: 'Server error.' })
  } finally {
    client.release()
  }
})

// DELETE /api/coaching/sessions/recurrence/:recurrenceId  — must be before /:id
router.delete('/sessions/recurrence/:recurrenceId', requireAuth, requireAdmin, async (req, res) => {
  const clubId = req.club?.id ?? req.user?.club_id ?? null
  try {
    const { rowCount } = await pool.query(
      `UPDATE coaching_sessions SET status='cancelled'
       WHERE recurrence_id=$1 AND date >= CURRENT_DATE AND status='confirmed' AND club_id=$2`,
      [req.params.recurrenceId, clubId]
    )
    res.json({ message: `Cancelled ${rowCount} session(s).`, count: rowCount })
  } catch { res.status(500).json({ message: 'Server error.' }) }
})

// DELETE /api/coaching/sessions/:id  — admin, the assigned student, or the coach can cancel
router.delete('/sessions/:id', requireAuth, async (req, res) => {
  const clubId = req.club?.id ?? req.user?.club_id ?? null
  try {
    const { rows } = await pool.query(
      `SELECT cs.*, c.user_id AS coach_user_id
       FROM coaching_sessions cs
       JOIN coaches c ON c.id = cs.coach_id
       WHERE cs.id=$1 AND cs.club_id=$2`,
      [req.params.id, clubId]
    )
    if (!rows[0]) return res.status(404).json({ message: 'Session not found.' })
    const session = rows[0]
    if (session.status === 'cancelled') return res.status(409).json({ message: 'Session is already cancelled.' })
    const isAdmin   = req.user.role === 'admin'
    const isStudent = session.student_id === req.user.id
    const isCoach   = session.coach_user_id === req.user.id
    if (!isAdmin && !isStudent && !isCoach)
      return res.status(403).json({ message: 'Forbidden.' })

    // For group sessions: record a leave (students only — admin cancellations don't count as leaves)
    if (session.group_id && !isAdmin) {
      const { rows: leaveRows } = await pool.query(
        'SELECT COUNT(*)::int AS cnt FROM group_session_leaves WHERE group_id=$1 AND student_id=$2',
        [session.group_id, session.student_id]
      )
      if (leaveRows[0].cnt >= 2)
        return res.status(409).json({
          message: 'Student has already used all 2 leaves for this group series.',
          leaveExhausted: true
        })

      await pool.query(
        `INSERT INTO group_session_leaves (group_id, student_id, session_id, leave_date)
         VALUES ($1, $2, $3, $4)`,
        [session.group_id, session.student_id, session.id, session.date]
      )
    }

    await pool.query("UPDATE coaching_sessions SET status='cancelled' WHERE id=$1 AND club_id=$2", [req.params.id, clubId])
    // Deduct hours for full cancellation (no makeup) — caller passes hasMakeup flag to skip
    const deductHours = !req.body?.hasMakeup
    res.json({ message: 'Session cancelled.', deductHours, sessionHours: sessionHours(session.start_time, session.end_time), studentId: session.student_id })
  } catch (err) { console.error(err); res.status(500).json({ message: 'Server error.' }) }
})

// POST /api/coaching/sessions/:id/leave  — record a leave without cancelling (used for move-to-end)
router.post('/sessions/:id/leave', requireAuth, requireAdmin, async (req, res) => {
  const clubId = req.club?.id ?? req.user?.club_id ?? null
  try {
    const { rows } = await pool.query(
      'SELECT * FROM coaching_sessions WHERE id=$1 AND club_id=$2',
      [req.params.id, clubId]
    )
    if (!rows[0]) return res.status(404).json({ message: 'Session not found.' })
    const session = rows[0]
    if (!session.group_id) return res.status(400).json({ message: 'Not a group session.' })

    const { rows: leaveRows } = await pool.query(
      'SELECT COUNT(*)::int AS cnt FROM group_session_leaves WHERE group_id=$1 AND student_id=$2',
      [session.group_id, session.student_id]
    )
    if (leaveRows[0].cnt >= 2)
      return res.status(409).json({ message: 'Student has already used all 2 leaves for this group series.', leaveExhausted: true })

    await pool.query(
      `INSERT INTO group_session_leaves (group_id, student_id, session_id, leave_date)
       VALUES ($1, $2, $3, $4)`,
      [session.group_id, session.student_id, session.id, session.date]
    )
    res.json({ message: 'Leave recorded.' })
  } catch (err) { console.error(err); res.status(500).json({ message: 'Server error.' }) }
})

// GET /api/coaching/payment-report?from=YYYY-MM-DD&to=YYYY-MM-DD  (admin only)
// Returns all confirmed sessions in the date range, grouped by coach, with
// per-session check-in status for both the student and the coach.
// A session "counts" toward pay only when BOTH have checked in.
router.get('/payment-report', requireAuth, requireAdmin, async (req, res) => {
  const clubId = req.club?.id ?? req.user?.club_id ?? null
  const { from, to } = req.query
  if (!from || !to) return res.status(400).json({ message: 'from and to dates are required.' })
  try {
    const { rows } = await pool.query(
      `SELECT
         co.id          AS coach_id,
         co.name        AS coach_name,
         co.user_id     AS coach_user_id,
         cs.id          AS session_id,
         cs.group_id,
         cs.date,
         cs.start_time,
         cs.end_time,
         cs.notes,
         u.id           AS student_id,
         u.name         AS student_name,
         ct.name        AS court_name,
         EXISTS(
           SELECT 1 FROM check_ins ci
           WHERE ci.type='coaching'
             AND ci.reference_id = cs.id::text
             AND ci.user_id = cs.student_id
         ) AS student_checked_in,
         CASE
           WHEN co.user_id IS NULL THEN NULL
           ELSE EXISTS(
             SELECT 1 FROM check_ins ci
             WHERE ci.type='coaching'
               AND ci.reference_id = cs.id::text
               AND ci.user_id = co.user_id
           )
         END AS coach_checked_in,
         EXISTS(
           SELECT 1 FROM check_ins ci
           WHERE ci.type='coaching'
             AND ci.reference_id = cs.id::text
             AND ci.checked_in_by IS NOT NULL
         ) AS admin_checked_in
       FROM coaching_sessions cs
       JOIN coaches co ON co.id  = cs.coach_id
       JOIN users   u  ON u.id   = cs.student_id
       LEFT JOIN courts  ct ON ct.id  = cs.court_id
       WHERE cs.status = 'confirmed'
         AND cs.club_id = $3
         AND cs.date >= $1 AND cs.date <= $2
       ORDER BY co.name ASC, cs.date ASC, cs.start_time ASC, cs.group_id ASC`,
      [from, to, clubId]
    )

    // Group rows by coach, deduplicating group sessions (count group as 1)
    const byCoach = {}
    // key → session entry for group sessions already added (group_id → entry)
    const groupEntries = {}
    for (const row of rows) {
      if (!byCoach[row.coach_id]) {
        byCoach[row.coach_id] = {
          coach_id:    row.coach_id,
          coach_name:  row.coach_name,
          has_account: row.coach_user_id != null,
          sessions:    [],
          counted:     0,
          total:       0,
        }
      }

      if (row.group_id) {
        const gkey = `${row.coach_id}:${row.group_id}`
        if (groupEntries[gkey]) {
          // Already added this group session — append student name and accumulate check-in status
          const entry = groupEntries[gkey]
          entry.student_names.push(row.student_name)
          entry.student_name = entry.student_names.join(', ')
          if (row.student_checked_in) entry.student_checked_in = true
          // Counted if admin checked in any student in the group
          if (!entry.counted && row.admin_checked_in === true) {
            entry.counted = true
            entry.admin_checked_in = true
            byCoach[row.coach_id].counted++
          }
          continue
        }
        // First row for this group — create entry and track it
        const counted = row.admin_checked_in === true
        const entry = {
          session_id:          row.session_id,
          group_id:            row.group_id,
          date:                row.date,
          start_time:          row.start_time,
          end_time:            row.end_time,
          notes:               row.notes,
          student_names:       [row.student_name],
          student_name:        row.student_name,
          court_name:          row.court_name,
          student_checked_in:  row.student_checked_in,
          coach_checked_in:    row.coach_checked_in,
          admin_checked_in:    row.admin_checked_in,
          is_group:            true,
          counted,
        }
        groupEntries[gkey] = entry
        byCoach[row.coach_id].sessions.push(entry)
        byCoach[row.coach_id].total++
        if (counted) byCoach[row.coach_id].counted++
      } else {
        const counted = row.admin_checked_in === true
        byCoach[row.coach_id].sessions.push({
          session_id:          row.session_id,
          date:                row.date,
          start_time:          row.start_time,
          end_time:            row.end_time,
          notes:               row.notes,
          student_name:        row.student_name,
          court_name:          row.court_name,
          student_checked_in:  row.student_checked_in,
          coach_checked_in:    row.coach_checked_in,
          admin_checked_in:    row.admin_checked_in,
          counted,
        })
        byCoach[row.coach_id].total++
        if (counted) byCoach[row.coach_id].counted++
      }
    }
    res.json({ coaches: Object.values(byCoach) })
  } catch { res.status(500).json({ message: 'Server error.' }) }
})

// ─── COACH-FACING ─────────────────────────────────────────────────────────────

// GET /api/coaching/my-coach-sessions  — upcoming sessions the logged-in coach is teaching
router.get('/my-coach-sessions', requireAuth, async (req, res) => {
  const clubId = req.club?.id ?? req.user?.club_id ?? null
  try {
    const { rows: coachRows } = await pool.query(
      'SELECT id FROM coaches WHERE user_id=$1 AND club_id=$2',
      [req.user.id, clubId]
    )
    if (!coachRows[0]) return res.json({ sessions: [] })

    const { rows } = await pool.query(
      `SELECT
         cs.id,
         cs.date,
         cs.start_time,
         cs.end_time,
         cs.notes,
         cs.recurrence_id,
         cs.student_id,
         u.name  AS student_name,
         ct.name AS court_name,
         cr.id        IS NOT NULL   AS has_review,
         cr.student_rating          AS student_rating,
         cr.student_comment         AS student_comment,
         cr.student_submitted_at    AS student_submitted_at
       FROM coaching_sessions cs
       JOIN users  u  ON u.id  = cs.student_id
       LEFT JOIN courts ct ON ct.id = cs.court_id
       LEFT JOIN coaching_reviews cr ON cr.session_id = cs.id
       WHERE cs.coach_id = $1
         AND cs.status = 'confirmed'
         AND cs.club_id = $2
       ORDER BY cs.date DESC, cs.start_time DESC`,
      [coachRows[0].id, clubId]
    )
    res.json({ sessions: rows })
  } catch { res.status(500).json({ message: 'Server error.' }) }
})

// ── Shared conflict + court-assignment helper used by both reschedule routes ──
// Checks coach, student, and court availability for (sessionDate, newStart, newEnd).
// excludeId: the session being rescheduled (excluded from its own conflict check).
// Returns { courtId } on success, throws a tagged Error on conflict.
async function checkAndAssignCourt(client, session, sessionDate, newStart, newEnd, extraExcludeIds = [], clubId = 1) {
  const coachId   = session.coach_id
  const studentId = session.student_id
  const groupId   = session.group_id
  const excludeIds = [...new Set([session.id, ...extraExcludeIds])]

  // ── coach conflicts ──────────────────────────────────────────────────────────
  // Same-group sessions share the coach intentionally — not a conflict
  const { rows: coachBusy } = await client.query(
    `SELECT 1 FROM coaching_sessions
     WHERE coach_id=$1 AND date=$2 AND status='confirmed' AND club_id=$7 AND NOT (id = ANY($5::int[]))
       AND ($6::uuid IS NULL OR group_id IS DISTINCT FROM $6)
       AND start_time < $4::time AND end_time > $3::time LIMIT 1`,
    [coachId, sessionDate, newStart, newEnd, excludeIds, groupId ?? null, clubId]
  )
  if (coachBusy.length)
    throw Object.assign(new Error('coach_conflict'), { sessionDate, reason: 'coaching' })

  const { rows: [coachRow] } = await client.query('SELECT user_id FROM coaches WHERE id=$1 AND club_id=$2', [coachId, clubId])
  const coachUserId = coachRow?.user_id
  if (coachUserId) {
    const { rows: coachBook } = await client.query(
      `SELECT 1 FROM bookings
       WHERE user_id=$1 AND date=$2 AND status='confirmed' AND club_id=$5
         AND start_time < $4::time AND end_time > $3::time LIMIT 1`,
      [coachUserId, sessionDate, newStart, newEnd, clubId]
    )
    if (coachBook.length)
      throw Object.assign(new Error('coach_conflict'), { sessionDate, reason: 'booking' })

    const { rows: coachSocial } = await client.query(
      `SELECT 1 FROM social_play_sessions sps
       JOIN social_play_participants spp ON spp.session_id = sps.id
       WHERE spp.user_id=$1 AND sps.date=$2 AND sps.status='open' AND sps.club_id=$5
         AND sps.start_time < $4::time AND sps.end_time > $3::time LIMIT 1`,
      [coachUserId, sessionDate, newStart, newEnd, clubId]
    )
    if (coachSocial.length)
      throw Object.assign(new Error('coach_conflict'), { sessionDate, reason: 'social' })
  }

  // ── student conflicts ────────────────────────────────────────────────────────
  const { rows: stdBook } = await client.query(
    `SELECT 1 FROM bookings
     WHERE user_id=$1 AND date=$2 AND status='confirmed' AND club_id=$5
       AND start_time < $4::time AND end_time > $3::time LIMIT 1`,
    [studentId, sessionDate, newStart, newEnd, clubId]
  )
  if (stdBook.length)
    throw Object.assign(new Error('student_conflict'), { sessionDate, reason: 'booking' })

  const { rows: stdSocial } = await client.query(
    `SELECT 1 FROM social_play_sessions sps
     JOIN social_play_participants spp ON spp.session_id = sps.id
     WHERE spp.user_id=$1 AND sps.date=$2 AND sps.status='open' AND sps.club_id=$5
       AND sps.start_time < $4::time AND sps.end_time > $3::time LIMIT 1`,
    [studentId, sessionDate, newStart, newEnd, clubId]
  )
  if (stdSocial.length)
    throw Object.assign(new Error('student_conflict'), { sessionDate, reason: 'social' })

  const { rows: stdCoach } = await client.query(
    `SELECT 1 FROM coaching_sessions
     WHERE student_id=$1 AND date=$2 AND status='confirmed' AND club_id=$6 AND NOT (id = ANY($5::int[]))
       AND start_time < $4::time AND end_time > $3::time LIMIT 1`,
    [studentId, sessionDate, newStart, newEnd, excludeIds, clubId]
  )
  if (stdCoach.length)
    throw Object.assign(new Error('student_conflict'), { sessionDate, reason: 'coaching' })

  // ── court availability: check each 30-min sub-slot independently ─────────
  // Checking the whole window at once overcounts: sessions in the first half
  // and sessions in the second half both get included even though they never
  // overlap with each other, making the total exceed 6 when it shouldn't.
  const totalCourts = await getCourtCount(client, clubId)
  const startM = toMins(newStart)
  const endM   = toMins(newEnd)
  for (let t = startM; t < endM; t += 30) {
    const slotStart = minsToTime(t)
    const slotEnd   = minsToTime(t + 30)
    const { rows: [usage] } = await client.query(
      `SELECT
         (SELECT COUNT(DISTINCT COALESCE(group_id::text, id::text)) FROM coaching_sessions
          WHERE date=$1 AND status='confirmed' AND club_id=$4
            AND NOT (id = ANY($5::int[]))
            AND ($6::uuid IS NULL OR group_id IS DISTINCT FROM $6)
            AND start_time < $3::time AND end_time > $2::time) AS coaching_used,
         (SELECT COUNT(DISTINCT booking_group_id) FROM bookings
          WHERE date=$1 AND status='confirmed' AND club_id=$4
            AND start_time < $3::time AND end_time > $2::time) AS booking_used,
         (SELECT COALESCE(SUM(num_courts), 0) FROM social_play_sessions
          WHERE date=$1 AND status='open' AND club_id=$4
            AND start_time < $3::time AND end_time > $2::time) AS social_used`,
      [sessionDate, slotStart, slotEnd, clubId, excludeIds, groupId ?? null]
    )
    const totalUsed = Number(usage.coaching_used) + Number(usage.booking_used) + Number(usage.social_used)
    if (totalUsed >= totalCourts) {
      const detail = `(${usage.coaching_used} coaching + ${usage.booking_used} bookings + ${usage.social_used} social = ${totalUsed}/${totalCourts} at ${slotStart.slice(0,5)})`
      throw Object.assign(new Error('no_court'), { sessionDate, detail })
    }
  }
}

function rescheduleConflictResponse(err, res) {
  if (err.message === 'no_court')
    return res.status(409).json({ message: `No courts available on ${err.sessionDate} at that time. ${err.detail ?? ''}`.trim() })
  if (err.message === 'student_conflict') {
    const what = err.reason === 'booking' ? 'a court booking' : err.reason === 'social' ? 'a social play session' : 'another coaching session'
    return res.status(409).json({ message: `Student already has ${what} on ${err.sessionDate} at that time.` })
  }
  if (err.message === 'coach_conflict') {
    const what = err.reason === 'coaching' ? 'another session to teach' : err.reason === 'booking' ? 'a court booking' : 'a social play session'
    return res.status(409).json({ message: `Coach already has ${what} on ${err.sessionDate} at that time.` })
  }
  if (err.code === '23505')
    return res.status(409).json({ message: 'That slot is already taken.' })
  return res.status(500).json({ message: 'Server error.' })
}

// PUT /api/coaching/sessions/reschedule-bulk  (admin) — move multiple sessions at once
// body: { updates: [{ id, date, start_time?, end_time? }] }
router.put('/sessions/reschedule-bulk', requireAuth, requireAdmin, async (req, res) => {
  const clubId = req.club?.id ?? req.user?.club_id ?? null
  const { updates } = req.body
  if (!Array.isArray(updates) || !updates.length)
    return res.status(400).json({ message: 'updates array is required.' })
  const client = await pool.connect()
  const allUpdateIds = updates.map(u => u.id)
  try {
    await client.query('BEGIN')

    // Pre-fetch all sessions so we can check group size constraints
    const sessionMap = {}
    for (const u of updates) {
      const { rows: [session] } = await client.query(
        'SELECT * FROM coaching_sessions WHERE id=$1 AND club_id=$2', [u.id, clubId]
      )
      if (!session) throw Object.assign(new Error('not_found'), { id: u.id })
      sessionMap[u.id] = session
    }

    // Check group student count on each target date (1–5 per group per date)
    const groupDateMoves = {} // `${group_id}:${date}` → count moving there
    for (const u of updates) {
      const session = sessionMap[u.id]
      if (!session.group_id) continue
      const key = `${session.group_id}:${u.date}`
      groupDateMoves[key] = (groupDateMoves[key] ?? 0) + 1
    }
    for (const [key, movingCount] of Object.entries(groupDateMoves)) {
      const [groupId, date] = key.split(':')
      const { rows: [cnt] } = await client.query(
        `SELECT COUNT(*)::int AS n FROM coaching_sessions
         WHERE group_id=$1 AND date=$2 AND status='confirmed' AND club_id=$4 AND NOT (id = ANY($3::int[]))`,
        [groupId, date, allUpdateIds, clubId]
      )
      const total = (cnt?.n ?? 0) + movingCount
      if (total > 5)
        throw Object.assign(new Error('group_too_large'), { date })
      if (total < 1)
        throw Object.assign(new Error('group_too_small'), { date })
    }

    for (const u of updates) {
      const session = sessionMap[u.id]
      const newStart = u.start_time || session.start_time
      const newEnd   = u.end_time   || session.end_time
      await checkAndAssignCourt(client, session, u.date, newStart, newEnd, allUpdateIds, clubId)
      await client.query(
        'UPDATE coaching_sessions SET date=$1, start_time=$2, end_time=$3, court_id=NULL WHERE id=$4 AND club_id=$5',
        [u.date, newStart, newEnd, u.id, clubId]
      )
    }
    await client.query('COMMIT')
    res.json({ message: 'Sessions rescheduled.' })
  } catch (err) {
    await client.query('ROLLBACK')
    if (err.message === 'not_found')
      return res.status(404).json({ message: `Session ${err.id} not found.` })
    if (err.message === 'group_too_large')
      return res.status(409).json({ message: `Moving sessions to ${err.date} would exceed 5 students in the group.` })
    if (err.message === 'group_too_small')
      return res.status(409).json({ message: `Moving sessions would leave 0 students on ${err.date}.` })
    return rescheduleConflictResponse(err, res)
  } finally { client.release() }
})

// PUT /api/coaching/sessions/group/:groupId/reschedule  (admin) — move all sessions in a group
// body: { date, start_time?, end_time? }
router.put('/sessions/group/:groupId/reschedule', requireAuth, requireAdmin, async (req, res) => {
  const clubId = req.club?.id ?? req.user?.club_id ?? null
  const { groupId } = req.params
  const { date, start_time, end_time } = req.body
  if (!date) return res.status(400).json({ message: 'date is required.' })
  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    const { rows: sessions } = await client.query(
      `SELECT * FROM coaching_sessions WHERE group_id=$1 AND status='confirmed' AND club_id=$2 ORDER BY id ASC`,
      [groupId, clubId]
    )
    if (!sessions.length) {
      await client.query('ROLLBACK')
      return res.status(404).json({ message: 'Group session not found.' })
    }

    const sample     = sessions[0]
    const newStart   = start_time || sample.start_time
    const newEnd     = end_time   || sample.end_time
    const excludeIds = sessions.map(s => s.id)

    // ── coach conflict (once for the whole group) ────────────────────────────
    const { rows: coachBusy } = await client.query(
      `SELECT 1 FROM coaching_sessions
       WHERE coach_id=$1 AND date=$2 AND status='confirmed' AND club_id=$6 AND NOT (id = ANY($5::int[]))
         AND start_time < $4::time AND end_time > $3::time LIMIT 1`,
      [sample.coach_id, date, newStart, newEnd, excludeIds, clubId]
    )
    if (coachBusy.length)
      throw Object.assign(new Error('coach_conflict'), { sessionDate: date, reason: 'coaching' })

    const { rows: [coachRow] } = await client.query('SELECT user_id FROM coaches WHERE id=$1 AND club_id=$2', [sample.coach_id, clubId])
    const coachUserId = coachRow?.user_id
    if (coachUserId) {
      const { rows: cb } = await client.query(
        `SELECT 1 FROM bookings WHERE user_id=$1 AND date=$2 AND status='confirmed' AND club_id=$5
           AND start_time < $4::time AND end_time > $3::time LIMIT 1`,
        [coachUserId, date, newStart, newEnd, clubId]
      )
      if (cb.length) throw Object.assign(new Error('coach_conflict'), { sessionDate: date, reason: 'booking' })

      const { rows: cs } = await client.query(
        `SELECT 1 FROM social_play_sessions sps
         JOIN social_play_participants spp ON spp.session_id = sps.id
         WHERE spp.user_id=$1 AND sps.date=$2 AND sps.status='open' AND sps.club_id=$5
           AND sps.start_time < $4::time AND sps.end_time > $3::time LIMIT 1`,
        [coachUserId, date, newStart, newEnd, clubId]
      )
      if (cs.length) throw Object.assign(new Error('coach_conflict'), { sessionDate: date, reason: 'social' })
    }

    // ── per-student conflict checks ──────────────────────────────────────────
    for (const session of sessions) {
      const sid = session.student_id
      const { rows: sb } = await client.query(
        `SELECT 1 FROM bookings WHERE user_id=$1 AND date=$2 AND status='confirmed' AND club_id=$5
           AND start_time < $4::time AND end_time > $3::time LIMIT 1`,
        [sid, date, newStart, newEnd, clubId]
      )
      if (sb.length) throw Object.assign(new Error('student_conflict'), { sessionDate: date, reason: 'booking' })

      const { rows: ss } = await client.query(
        `SELECT 1 FROM social_play_sessions sps
         JOIN social_play_participants spp ON spp.session_id = sps.id
         WHERE spp.user_id=$1 AND sps.date=$2 AND sps.status='open' AND sps.club_id=$5
           AND sps.start_time < $4::time AND sps.end_time > $3::time LIMIT 1`,
        [sid, date, newStart, newEnd, clubId]
      )
      if (ss.length) throw Object.assign(new Error('student_conflict'), { sessionDate: date, reason: 'social' })

      const { rows: sc } = await client.query(
        `SELECT 1 FROM coaching_sessions
         WHERE student_id=$1 AND date=$2 AND status='confirmed' AND club_id=$6 AND NOT (id = ANY($5::int[]))
           AND start_time < $4::time AND end_time > $3::time LIMIT 1`,
        [sid, date, newStart, newEnd, excludeIds, clubId]
      )
      if (sc.length) throw Object.assign(new Error('student_conflict'), { sessionDate: date, reason: 'coaching' })
    }

    // ── find a free court (exclude all group session IDs) ────────────────────
    const { rows: free } = await client.query(
      `WITH social_count AS (
         SELECT COALESCE(SUM(num_courts), 0)::int AS total
         FROM social_play_sessions
         WHERE date=$1 AND status='open' AND club_id=$5
           AND start_time < $3::time AND end_time > $2::time
       ),
       free_courts AS (
         SELECT c.id, ROW_NUMBER() OVER (ORDER BY c.id) AS rn
         FROM courts c
         WHERE c.club_id=$5
         AND c.id NOT IN (
           SELECT DISTINCT cs2.court_id FROM coaching_sessions cs2
           WHERE cs2.date=$1 AND cs2.status='confirmed' AND cs2.club_id=$5 AND NOT (cs2.id = ANY($4::int[]))
             AND cs2.start_time < $3::time AND cs2.end_time > $2::time
         )
         AND c.id NOT IN (
           SELECT b.court_id FROM bookings b
           WHERE b.date=$1 AND b.status='confirmed' AND b.club_id=$5
             AND b.start_time < $3::time AND b.end_time > $2::time
         )
       )
       SELECT fc.id FROM free_courts fc, social_count sc
       WHERE fc.rn > sc.total ORDER BY fc.rn LIMIT 1`,
      [date, newStart, newEnd, excludeIds, clubId]
    )
    if (!free[0]) throw Object.assign(new Error('no_court'), { sessionDate: date })

    await client.query(
      `UPDATE coaching_sessions SET date=$1, start_time=$2, end_time=$3, court_id=$4
       WHERE group_id=$5 AND status='confirmed' AND club_id=$6`,
      [date, newStart, newEnd, free[0].id, groupId, clubId]
    )
    await client.query('COMMIT')
    res.json({ message: 'Group session rescheduled.' })
  } catch (err) {
    await client.query('ROLLBACK')
    return rescheduleConflictResponse(err, res)
  } finally { client.release() }
})

// PUT /api/coaching/sessions/:id/reschedule  (admin) — move a single session to a new date/time
// body: { date: 'YYYY-MM-DD', start_time?, end_time? }
router.put('/sessions/:id/reschedule', requireAuth, requireAdmin, async (req, res) => {
  const clubId = req.club?.id ?? req.user?.club_id ?? null
  const { date, start_time, end_time } = req.body
  if (!date) return res.status(400).json({ message: 'date is required.' })
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const { rows: [session] } = await client.query(
      'SELECT * FROM coaching_sessions WHERE id=$1 AND club_id=$2', [req.params.id, clubId]
    )
    if (!session) {
      await client.query('ROLLBACK')
      return res.status(404).json({ message: 'Session not found.' })
    }
    const newStart = start_time || session.start_time
    const newEnd   = end_time   || session.end_time
    await checkAndAssignCourt(client, session, date, newStart, newEnd, [], clubId)
    const { rows } = await client.query(
      'UPDATE coaching_sessions SET date=$1, start_time=$2, end_time=$3, court_id=NULL WHERE id=$4 AND club_id=$5 RETURNING *',
      [date, newStart, newEnd, session.id, clubId]
    )
    await client.query('COMMIT')
    res.json({ session: rows[0] })
  } catch (err) {
    await client.query('ROLLBACK')
    return rescheduleConflictResponse(err, res)
  } finally { client.release() }
})

// ─── STUDENT-FACING ───────────────────────────────────────────────────────────

// GET /api/coaching/my  — authenticated user's upcoming coaching sessions.
// series_total  = all sessions scheduled in the recurring series
// series_used   = sessions that have been "counted" (admin checked-in OR both student+coach checked in)
// sessions_left = series_total - series_used
router.get('/my', requireAuth, async (req, res) => {
  const clubId = req.club?.id ?? req.user?.club_id ?? null
  try {
    const { rows } = await pool.query(
      `WITH session_checkins AS (
         -- Determine whether each past session in this student's series "counted"
         SELECT
           cs.id AS session_id,
           cs.recurrence_id,
           cs.date,
           (
             EXISTS(
               SELECT 1 FROM check_ins ci
               WHERE ci.type = 'coaching'
                 AND ci.reference_id = cs.id::text
                 AND ci.checked_in_by IS NOT NULL
             ) OR (
               EXISTS(
                 SELECT 1 FROM check_ins ci
                 WHERE ci.type = 'coaching'
                   AND ci.reference_id = cs.id::text
                   AND ci.user_id = cs.student_id
               ) AND EXISTS(
                 SELECT 1 FROM check_ins ci
                 WHERE ci.type = 'coaching'
                   AND ci.reference_id = cs.id::text
                   AND ci.user_id = (SELECT co.user_id FROM coaches co WHERE co.id = cs.coach_id)
               )
             )
           ) AS counted
         FROM coaching_sessions cs
         WHERE cs.student_id = $1
           AND cs.club_id = $2
           AND cs.status = 'confirmed'
           AND cs.recurrence_id IS NOT NULL
       ),
       series_counts AS (
         SELECT
           recurrence_id,
           COUNT(*)::int                               AS series_total,
           COUNT(*) FILTER (WHERE counted)::int        AS series_used
         FROM session_checkins
         GROUP BY recurrence_id
       )
       SELECT
         cs.id, cs.date, cs.start_time, cs.end_time,
         cs.notes, cs.status, cs.recurrence_id,
         c.name  AS coach_name,
         ct.name AS court_name,
         sc.series_total,
         sc.series_used,
         EXISTS(
           SELECT 1 FROM session_leave_requests slr
           WHERE slr.session_id = cs.id AND slr.status IN ('pending','approved')
         ) AS has_pending_leave
       FROM coaching_sessions cs
       JOIN coaches c  ON c.id  = cs.coach_id
       LEFT JOIN courts  ct ON ct.id = cs.court_id
       LEFT JOIN series_counts sc ON sc.recurrence_id = cs.recurrence_id
       WHERE cs.student_id = $1
         AND cs.club_id = $2
         AND cs.status = 'confirmed'
         AND cs.date >= CURRENT_DATE
       ORDER BY cs.date ASC, cs.start_time ASC`,
      [req.user.id, clubId]
    )
    res.json({ sessions: rows })
  } catch { res.status(500).json({ message: 'Server error.' }) }
})

// ─── COACHING HOURS (admin + student) ─────────────────────────────────────────

// GET /api/coaching/hours/:userId  — combined balance + recent transactions (admin or self)
router.get('/hours/:userId', requireAuth, async (req, res) => {
  const clubId = req.club?.id ?? req.user?.club_id ?? null
  const targetId = Number(req.params.userId)
  if (req.user.role !== 'admin' && req.user.id !== targetId)
    return res.status(403).json({ message: 'Forbidden.' })
  try {
    const { rows: ledger } = await pool.query(
      `SELECT id, delta, note, session_type, session_id, created_by, created_at
       FROM coaching_hour_ledger
       WHERE user_id=$1 AND club_id=$2
       ORDER BY created_at DESC
       LIMIT 50`,
      [targetId, clubId]
    )
    const { rows: [bal] } = await pool.query(
      `SELECT COALESCE(SUM(delta), 0)::numeric AS balance
       FROM coaching_hour_ledger WHERE user_id=$1 AND club_id=$2`,
      [targetId, clubId]
    )
    const round = v => Math.round(parseFloat(v) * 100) / 100
    res.json({ balance: round(bal.balance), ledger })
  } catch { res.status(500).json({ message: 'Server error.' }) }
})

// POST /api/coaching/hours/:userId  — admin manually credits or debits dollars
// body: { delta, note }
router.post('/hours/:userId', requireAuth, requireAdmin, async (req, res) => {
  const clubId = req.club?.id ?? req.user?.club_id ?? null
  const targetId = Number(req.params.userId)
  const { delta, note } = req.body
  if (delta === undefined || delta === null || delta === 0)
    return res.status(400).json({ message: 'delta is required and must be non-zero.' })
  if (!Number.isFinite(Number(delta)) || Math.abs(Number(delta)) > 10000)
    return res.status(400).json({ message: 'delta must be a finite number between -10000 and 10000.' })
  try {
    await pool.query(
      `INSERT INTO coaching_hour_ledger (user_id, delta, note, session_type, created_by, club_id)
       VALUES ($1, $2, $3, 'credit', $4, $5)`,
      [targetId, delta, note ?? null, req.user.id, clubId]
    )
    const { rows: [bal] } = await pool.query(
      `SELECT COALESCE(SUM(delta), 0)::numeric AS balance
       FROM coaching_hour_ledger WHERE user_id=$1 AND club_id=$2`,
      [targetId, clubId]
    )
    const round = v => Math.round(parseFloat(v) * 100) / 100
    const newBalance = round(bal.balance)

    // Notify the member
    const sign    = delta > 0 ? '+' : ''
    const noteStr = note ? `\nNote: ${note}` : ''
    await sendSystemMessage(
      req.user.id,
      targetId,
      `💰 Your coaching credit has been updated.\n${sign}$${round(delta)}${noteStr}\nNew balance: $${newBalance}`
    )

    // Notify admin if balance went negative
    if (newBalance < 0) {
      const { rows: [u] } = await pool.query('SELECT name FROM users WHERE id=$1', [targetId])
      sendSystemMessage(
        targetId,
        req.user.id,
        `⚠️ Coaching balance alert: ${u?.name ?? 'A student'}'s balance is now $${newBalance}.`
      )
    }

    res.json({ message: 'Balance updated.', balance: newBalance })
  } catch { res.status(500).json({ message: 'Server error.' }) }
})

// ── Coaching Reviews ──────────────────────────────────────────────────────────

// GET /api/coaching/reviews/recent  — admin: recent sessions with any feedback (coach or student)
router.get('/reviews/recent', requireAuth, requireAdmin, async (req, res) => {
  const clubId = req.club?.id ?? req.user?.club_id ?? null
  const limit  = Math.min(parseInt(req.query.limit) || 50, 100)
  try {
    const { rows } = await pool.query(
      `SELECT cs.id AS session_id, cs.date, cs.start_time, cs.end_time,
              u.name  AS student_name,
              co.name AS coach_name,
              cr.body             AS review_body,
              cr.skills           AS review_skills,
              cr.student_rating   AS student_rating,
              cr.student_comment  AS student_comment,
              cr.updated_at       AS coach_updated_at,
              cr.student_submitted_at
       FROM coaching_reviews cr
       JOIN coaching_sessions cs ON cs.id = cr.session_id
       JOIN users   u  ON u.id  = cs.student_id
       JOIN coaches co ON co.id = cs.coach_id
       WHERE cs.club_id = $1
         AND (cr.body IS NOT NULL AND cr.body != '' OR cr.skills != '[]' OR cr.student_rating IS NOT NULL)
       ORDER BY GREATEST(cr.updated_at, COALESCE(cr.student_submitted_at, cr.updated_at)) DESC
       LIMIT $2`,
      [clubId, limit]
    )
    res.json({ reviews: rows })
  } catch (e) { res.status(500).json({ message: 'Server error.' }) }
})

// GET /api/coaching/reviews/session/:sessionId  — get review for a specific session
router.get('/reviews/session/:sessionId', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM coaching_reviews WHERE session_id=$1',
      [req.params.sessionId]
    )
    res.json({ review: rows[0] ?? null })
  } catch (e) { res.status(500).json({ message: 'Server error.' }) }
})

// POST /api/coaching/reviews  — coach creates a review for a session (also auto check-in)
// body: { session_id, skills, body }
router.post('/reviews', requireAuth, async (req, res) => {
  const clubId = req.club?.id ?? req.user?.club_id ?? null
  const { session_id, skills = [], body = '' } = req.body
  if (!session_id) return res.status(400).json({ message: 'session_id is required.' })
  if (!skills.length && !body.trim())
    return res.status(400).json({ message: 'At least one skill or notes required.' })
  const client = await pool.connect()
  try {
    const coachRow = await pool.query('SELECT id FROM coaches WHERE user_id=$1 AND club_id=$2', [req.user.id, clubId])
    if (!coachRow.rows[0]) return res.status(403).json({ message: 'Not a coach.' })
    const coachId = coachRow.rows[0].id

    await client.query('BEGIN')

    // Insert review
    const { rows } = await client.query(
      `INSERT INTO coaching_reviews (session_id, coach_id, student_id, skills, body)
       SELECT $1, $2, cs.student_id, $3, $4
       FROM coaching_sessions cs WHERE cs.id=$1 AND cs.club_id=$5
       ON CONFLICT (session_id) DO NOTHING
       RETURNING *`,
      [session_id, coachId, JSON.stringify(skills), body.trim(), clubId]
    )

    // Auto check-in the student (idempotent)
    const { rows: [sessRow] } = await client.query(
      'SELECT student_id, date, group_id FROM coaching_sessions WHERE id=$1 AND club_id=$2', [session_id, clubId]
    )
    if (sessRow) {
      const { rowCount: ciCount } = await client.query(
        `INSERT INTO check_ins (user_id, type, reference_id, date, checked_in_by)
         VALUES ($1, 'coaching', $2, $3, $4)
         ON CONFLICT (user_id, type, reference_id) DO NOTHING`,
        [sessRow.student_id, session_id, sessRow.date, req.user.id]
      )
      // Deduct balance only on first check-in
      if (ciCount > 0) {
        const sessionType = sessRow.group_id ? 'group' : 'solo'
        const { rows: [priceRow] } = await client.query(
          'SELECT price FROM coaching_prices WHERE session_type=$1 AND club_id=$2', [sessionType, clubId]
        )
        const amount = priceRow?.price ?? (sessionType === 'group' ? 50 : 70)
        await client.query(
          `INSERT INTO coaching_hour_ledger (user_id, delta, note, session_type, session_id, created_by, club_id)
           VALUES ($1, $2, 'Coaching session attended', $3, $4, $5, $6)`,
          [sessRow.student_id, -amount, sessionType, session_id, req.user.id, clubId]
        )
      }
    }

    await client.query('COMMIT')
    res.status(201).json({ review: rows[0] ?? null })
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    res.status(500).json({ message: 'Server error.' })
  } finally { client.release() }
})

// PUT /api/coaching/reviews/:id  — coach updates an existing review
// body: { skills, body }
router.put('/reviews/:id', requireAuth, async (req, res) => {
  const clubId = req.club?.id ?? req.user?.club_id ?? null
  const { skills = [], body = '' } = req.body
  try {
    const { rows } = await pool.query(
      `UPDATE coaching_reviews SET skills=$1, body=$2, updated_at=NOW()
       WHERE id=$3 AND coach_id=(SELECT id FROM coaches WHERE user_id=$4 AND club_id=$5)
       RETURNING *`,
      [JSON.stringify(skills), body.trim(), req.params.id, req.user.id, clubId]
    )
    if (!rows[0]) return res.status(404).json({ message: 'Review not found.' })
    res.json({ review: rows[0] })
  } catch (e) { res.status(500).json({ message: 'Server error.' }) }
})

// POST /api/coaching/reviews/student  — student submits rating (1-5) + optional comment
// body: { session_id, rating, comment? }
router.post('/reviews/student', requireAuth, async (req, res) => {
  const clubId = req.club?.id ?? req.user?.club_id ?? null
  const { session_id, rating, comment = '' } = req.body
  if (!session_id) return res.status(400).json({ message: 'session_id is required.' })
  if (!rating || rating < 1 || rating > 5)
    return res.status(400).json({ message: 'rating must be between 1 and 5.' })
  try {
    // Verify session belongs to this student and is in the past
    const { rows: [sess] } = await pool.query(
      `SELECT id, student_id FROM coaching_sessions WHERE id=$1 AND club_id=$2 AND status='confirmed' AND date <= CURRENT_DATE`,
      [session_id, clubId]
    )
    if (!sess) return res.status(404).json({ message: 'Session not found.' })
    if (sess.student_id !== req.user.id) return res.status(403).json({ message: 'Forbidden.' })

    // Upsert: update if coach review row already exists, otherwise insert new row
    const { rows } = await pool.query(
      `INSERT INTO coaching_reviews (session_id, coach_id, student_id, skills, body, student_rating, student_comment, student_submitted_at)
       SELECT $1, cs.coach_id, cs.student_id, '[]', '', $2, $3, NOW()
       FROM coaching_sessions cs WHERE cs.id=$1
       ON CONFLICT (session_id) DO UPDATE
         SET student_rating=$2, student_comment=$3, student_submitted_at=NOW()
       RETURNING *`,
      [session_id, rating, comment.trim() || null]
    )
    res.json({ review: rows[0] })
  } catch (e) { res.status(500).json({ message: 'Server error.' }) }
})

// GET /api/coaching/my-history  — student sees all past sessions with attendance status
router.get('/my-history', requireAuth, async (req, res) => {
  const clubId = req.club?.id ?? req.user?.club_id ?? null
  try {
    const { rows } = await pool.query(
      `SELECT cs.id, cs.date, cs.start_time, cs.end_time,
              u.name AS coach_name,
              EXISTS(
                SELECT 1 FROM check_ins ci
                WHERE ci.type='coaching' AND ci.reference_id=cs.id::text AND ci.user_id=cs.student_id
              ) AS checked_in,
              COALESCE((
                SELECT ci.no_show FROM check_ins ci
                WHERE ci.type='coaching' AND ci.reference_id=cs.id::text AND ci.user_id=cs.student_id
                LIMIT 1
              ), FALSE) AS no_show,
              cr.skills            AS review_skills,
              cr.body             AS review_body,
              cr.student_rating   AS student_rating,
              cr.student_comment  AS student_comment,
              (SELECT ABS(chl.delta) FROM coaching_hour_ledger chl
               WHERE chl.session_id = cs.id AND chl.club_id = $2
               ORDER BY chl.id DESC LIMIT 1) AS charged
       FROM coaching_sessions cs
       JOIN coaches co ON co.id = cs.coach_id
       JOIN users u ON u.id = co.user_id
       LEFT JOIN coaching_reviews cr ON cr.session_id = cs.id
       WHERE cs.student_id=$1 AND cs.club_id=$2 AND cs.status='confirmed' AND cs.date <= CURRENT_DATE
       ORDER BY cs.date DESC
       LIMIT 100`,
      [req.user.id, clubId]
    )
    res.json({ sessions: rows })
  } catch (e) { res.status(500).json({ message: 'Server error.' }) }
})

// GET /api/coaching/reviews/my  — student sees their reviews (with session info + skills)
router.get('/reviews/my', requireAuth, async (req, res) => {
  const clubId = req.club?.id ?? req.user?.club_id ?? null
  try {
    const { rows } = await pool.query(
      `SELECT cr.id, cr.skills, cr.body, cr.created_at, cr.updated_at,
              u.name AS coach_name,
              cs.date, cs.start_time, cs.end_time
       FROM coaching_reviews cr
       JOIN coaches co ON co.id = cr.coach_id
       JOIN users u ON u.id = co.user_id
       JOIN coaching_sessions cs ON cs.id = cr.session_id
       WHERE cs.student_id=$1 AND cs.club_id=$2
       ORDER BY cs.date DESC`,
      [req.user.id, clubId]
    )
    res.json({ reviews: rows })
  } catch (e) { res.status(500).json({ message: 'Server error.' }) }
})

// GET /api/coaching/prices  — current session prices (admin only)
router.get('/prices', requireAuth, requireAdmin, async (req, res) => {
  const clubId = req.club?.id ?? req.user?.club_id ?? null
  try {
    const { rows } = await pool.query('SELECT session_type, price FROM coaching_prices WHERE club_id=$1', [clubId])
    const prices = Object.fromEntries(rows.map(r => [r.session_type, parseFloat(r.price)]))
    res.json({ prices })
  } catch { res.status(500).json({ message: 'Server error.' }) }
})

// PUT /api/coaching/prices  — update session prices (admin only)
// body: { solo: 70, group: 50 }
router.put('/prices', requireAuth, requireAdmin, async (req, res) => {
  const clubId = req.club?.id ?? req.user?.club_id ?? null
  const { solo, group } = req.body
  if (solo === undefined || group === undefined || solo <= 0 || group <= 0)
    return res.status(400).json({ message: 'solo and group prices are required and must be positive.' })
  try {
    await pool.query('UPDATE coaching_prices SET price=$1 WHERE session_type=$2 AND club_id=$3', [solo, 'solo', clubId])
    await pool.query('UPDATE coaching_prices SET price=$1 WHERE session_type=$2 AND club_id=$3', [group, 'group', clubId])
    res.json({ message: 'Prices updated.', prices: { solo, group } })
  } catch { res.status(500).json({ message: 'Server error.' }) }
})

// GET /api/coaching/student-prices/:userId
router.get('/student-prices/:userId', requireAuth, requireAdmin, async (req, res) => {
  const clubId = req.club?.id ?? req.user?.club_id ?? null
  const userId = Number(req.params.userId)
  try {
    // Fallback to global prices if no student-specific row
    const { rows: global } = await pool.query('SELECT session_type, price FROM coaching_prices WHERE club_id=$1', [clubId])
    const globalMap = Object.fromEntries(global.map(r => [r.session_type, parseFloat(r.price)]))
    const { rows: student } = await pool.query(
      'SELECT solo_price, group_price FROM student_coaching_prices WHERE user_id=$1',
      [userId]
    )
    const row = student[0]
    res.json({
      solo_price:  row?.solo_price  != null ? parseFloat(row.solo_price)  : (globalMap.solo  ?? 70),
      group_price: row?.group_price != null ? parseFloat(row.group_price) : (globalMap.group ?? 50),
    })
  } catch { res.status(500).json({ message: 'Server error.' }) }
})

// PUT /api/coaching/student-prices/:userId
router.put('/student-prices/:userId', requireAuth, requireAdmin, async (req, res) => {
  const userId = Number(req.params.userId)
  const { solo_price, group_price } = req.body
  if (!solo_price || !group_price || solo_price <= 0 || group_price <= 0)
    return res.status(400).json({ message: 'solo_price and group_price are required and must be positive.' })
  try {
    await pool.query(
      `INSERT INTO student_coaching_prices (user_id, solo_price, group_price)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id) DO UPDATE SET solo_price=$2, group_price=$3`,
      [userId, solo_price, group_price]
    )
    res.json({ solo_price: parseFloat(solo_price), group_price: parseFloat(group_price) })
  } catch { res.status(500).json({ message: 'Server error.' }) }
})

// ─── LEAVE REQUESTS ──────────────────────────────────────────────────────────

// Helper: find up to `limit` available time slots for a coach in the next 14 days
// Returns array of { date, start_time, end_time }
async function getAvailableSlots(clubId, coachId, durationMins, excludeSessionId) {
  const DOW_MAP = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }
  const { rows: schedule } = await pool.query(
    `SELECT day, start_time, end_time FROM schedule WHERE is_active=TRUE AND club_id=$1`,
    [clubId]
  )

  const slots = []
  const today = new Date()
  today.setHours(0, 0, 0, 0)

  for (let d = 1; d <= 14 && slots.length < 20; d++) {
    const date = new Date(today)
    date.setDate(today.getDate() + d)
    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
    const dayName = dayNames[date.getDay()]
    // Use local date string to avoid UTC offset shifting the date back by 1 day
    const isoDate = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`

    const openWindows = schedule.filter(s => s.day === dayName)
    for (const window of openWindows) {
      // Generate candidate slots of `durationMins` within this window
      const winStart = window.start_time.slice(0, 5) // 'HH:MM'
      const winEnd   = window.end_time.slice(0, 5)
      const [wsh, wsm] = winStart.split(':').map(Number)
      const [weh, wem] = winEnd.split(':').map(Number)
      const winStartMins = wsh * 60 + wsm
      const winEndMins   = weh * 60 + wem

      let cursor = winStartMins
      while (cursor + durationMins <= winEndMins && slots.length < 20) {
        const slotStart = `${String(Math.floor(cursor / 60)).padStart(2, '0')}:${String(cursor % 60).padStart(2, '0')}:00`
        const slotEnd   = `${String(Math.floor((cursor + durationMins) / 60)).padStart(2, '0')}:${String((cursor + durationMins) % 60).padStart(2, '0')}:00`

        // Check coach has no confirmed session at this time
        const { rows: coachBusy } = await pool.query(
          `SELECT 1 FROM coaching_sessions
           WHERE coach_id=$1 AND date=$2 AND status='confirmed' AND club_id=$3
             AND id != $4 AND start_time < $6::time AND end_time > $5::time LIMIT 1`,
          [coachId, isoDate, clubId, excludeSessionId ?? 0, slotStart, slotEnd]
        )
        if (coachBusy.length) { cursor += 30; continue }

        // Check a court is available (count-based, 6 courts total)
        const { rows: [{ total_used }] } = await pool.query(
          `SELECT
             (SELECT COUNT(DISTINCT COALESCE(group_id::text, id::text)) FROM coaching_sessions
              WHERE date=$1 AND status='confirmed' AND club_id=$4
                AND id != $5 AND start_time < $3::time AND end_time > $2::time) +
             (SELECT COUNT(DISTINCT booking_group_id) FROM bookings
              WHERE date=$1 AND status='confirmed' AND club_id=$4
                AND start_time < $3::time AND end_time > $2::time) +
             (SELECT COALESCE(SUM(num_courts), 0) FROM social_play_sessions
              WHERE date=$1 AND status='open' AND club_id=$4
                AND start_time < $3::time AND end_time > $2::time)
           AS total_used`,
          [isoDate, slotStart, slotEnd, clubId, excludeSessionId ?? 0]
        )
        if (Number(total_used) < 6) {
          slots.push({ date: isoDate, start_time: slotStart, end_time: slotEnd })
        }
        cursor += 30
      }
    }
  }
  return slots
}

// POST /api/coaching/leave-requests  (student)
// body: { session_id, reason? }
router.post('/leave-requests', requireAuth, async (req, res) => {
  if (req.user.role !== 'member') return res.status(403).json({ message: 'Only members can submit leave requests.' })
  const clubId = req.club?.id ?? req.user?.club_id ?? null
  const { session_id, reason } = req.body
  if (!session_id) return res.status(400).json({ message: 'session_id is required.' })
  try {
    // Verify session belongs to this student, is upcoming + confirmed
    const { rows: [session] } = await pool.query(
      `SELECT cs.*, c.name AS coach_name
       FROM coaching_sessions cs
       JOIN coaches c ON c.id = cs.coach_id
       WHERE cs.id=$1 AND cs.student_id=$2 AND cs.status='confirmed' AND cs.club_id=$3
         AND cs.date >= CURRENT_DATE`,
      [session_id, req.user.id, clubId]
    )
    if (!session) return res.status(404).json({ message: 'Session not found or not eligible for leave request.' })

    // Check no active leave request already exists
    const { rows: existing } = await pool.query(
      `SELECT 1 FROM session_leave_requests
       WHERE session_id=$1 AND status IN ('pending','approved') LIMIT 1`,
      [session_id]
    )
    if (existing.length) return res.status(409).json({ message: 'A leave request for this session already exists.' })

    // Find ALL admins for this club
    const { rows: admins } = await pool.query(
      `SELECT id FROM users WHERE role='admin' AND club_id=$1 ORDER BY id`,
      [clubId]
    )
    if (!admins.length) return res.status(500).json({ message: 'No admin found.' })

    // Insert leave request
    const { rows: [req_row] } = await pool.query(
      `INSERT INTO session_leave_requests (session_id, student_id, club_id, reason)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [session_id, req.user.id, clubId, reason || null]
    )

    // Send a message to every admin so any of them can act on it
    const timeRange = `${fmtTime(session.start_time)} – ${fmtTime(session.end_time)}`
    const msgBody = `📋 Leave Request\nSession: ${session.coach_name} · ${fmtDate(session.date)} · ${timeRange}${reason ? `\nReason: ${reason}` : ''}`
    for (const admin of admins) {
      const { rows: [msg] } = await pool.query(
        `INSERT INTO messages (sender_id, recipient_id, body, metadata)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [req.user.id, admin.id, msgBody, JSON.stringify({ type: 'leave_request', request_id: req_row.id, session_id })]
      )
      await pool.query(
        'INSERT INTO message_reads (message_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [msg.id, req.user.id]
      )
      // Un-hide thread for both parties so the message surfaces in inbox
      await pool.query(
        `DELETE FROM message_thread_hidden
         WHERE (user_id=$1 AND other_user_id=$2) OR (user_id=$2 AND other_user_id=$1)`,
        [req.user.id, admin.id]
      )
    }

    res.status(201).json({ request_id: req_row.id })
  } catch (e) { console.error(e); res.status(500).json({ message: 'Server error.' }) }
})

// POST /api/coaching/leave-requests/:id/approve  (admin)
router.post('/leave-requests/:id/approve', requireAuth, requireAdmin, async (req, res) => {
  const clubId = req.club?.id ?? req.user?.club_id ?? null
  try {
    const { rows: [lr] } = await pool.query(
      `SELECT slr.*, cs.coach_id, cs.start_time, cs.end_time, cs.date,
              u.name AS student_name
       FROM session_leave_requests slr
       JOIN coaching_sessions cs ON cs.id = slr.session_id
       JOIN users u ON u.id = slr.student_id
       WHERE slr.id=$1 AND slr.status='pending' AND slr.club_id=$2`,
      [req.params.id, clubId]
    )
    if (!lr) return res.status(404).json({ message: 'Leave request not found or not pending.' })

    // Compute duration in minutes
    const [sh, sm] = lr.start_time.slice(0, 5).split(':').map(Number)
    const [eh, em] = lr.end_time.slice(0, 5).split(':').map(Number)
    const durationMins = (eh * 60 + em) - (sh * 60 + sm)

    // Find available slots
    const slots = await getAvailableSlots(clubId, lr.coach_id, durationMins, lr.session_id)

    // Update leave request — store available slots so select-slot can validate later
    await pool.query(
      `UPDATE session_leave_requests
       SET status='approved', expires_at=NOW() + INTERVAL '48 hours', resolved_by=$1, available_slots=$3
       WHERE id=$2`,
      [req.user.id, lr.id, JSON.stringify(slots)]
    )

    // Build slot options message to student
    const timeRange = `${fmtTime(lr.start_time)} – ${fmtTime(lr.end_time)}`
    let msgBody = `✅ Your leave request has been approved.\nOriginal: ${fmtDate(lr.date)}, ${timeRange}\n\nPlease choose a makeup time within 48 hours, otherwise standard cancellation policy applies.`
    if (slots.length === 0) {
      msgBody += '\n\n(No available slots found. Please contact us to arrange an alternative.)'
    }

    const { rows: [{ expires_at }] } = await pool.query(
      `SELECT expires_at FROM session_leave_requests WHERE id=$1`, [lr.id]
    )

    const { rows: [msg] } = await pool.query(
      `INSERT INTO messages (sender_id, recipient_id, body, metadata)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [req.user.id, lr.student_id, msgBody,
       JSON.stringify({ type: 'slot_options', request_id: lr.id, slots, expires_at })]
    )
    await pool.query(
      'INSERT INTO message_reads (message_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [msg.id, req.user.id]
    )

    res.json({ slots })
  } catch (e) { console.error(e); res.status(500).json({ message: 'Server error.' }) }
})

// POST /api/coaching/leave-requests/:id/reject  (admin)
router.post('/leave-requests/:id/reject', requireAuth, requireAdmin, async (req, res) => {
  const clubId = req.club?.id ?? req.user?.club_id ?? null
  try {
    const { rows: [lr] } = await pool.query(
      `UPDATE session_leave_requests
       SET status='rejected', resolved_at=NOW(), resolved_by=$1
       WHERE id=$2 AND status='pending' AND club_id=$3 RETURNING id`,
      [req.user.id, req.params.id, clubId]
    )
    if (!lr) return res.status(404).json({ message: 'Leave request not found or not pending.' })
    res.json({ message: 'Rejected.' })
  } catch (e) { console.error(e); res.status(500).json({ message: 'Server error.' }) }
})

// POST /api/coaching/leave-requests/:id/select-slot  (student)
// body: { date, start_time, end_time }
router.post('/leave-requests/:id/select-slot', requireAuth, async (req, res) => {
  const clubId = req.club?.id ?? req.user?.club_id ?? null
  const { date, start_time, end_time } = req.body
  if (!date || !start_time || !end_time) return res.status(400).json({ message: 'date, start_time and end_time are required.' })

  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    const { rows: [lr] } = await client.query(
      `SELECT slr.*, u.name AS student_name
       FROM session_leave_requests slr
       JOIN users u ON u.id = slr.student_id
       WHERE slr.id=$1 AND slr.student_id=$2 AND slr.status='approved' AND slr.club_id=$3
       FOR UPDATE`,
      [req.params.id, req.user.id, clubId]
    )
    if (!lr) {
      await client.query('ROLLBACK')
      return res.status(404).json({ message: 'Leave request not found or not in approved state.' })
    }
    if (lr.expires_at && new Date(lr.expires_at) < new Date()) {
      await client.query('ROLLBACK')
      return res.status(409).json({ message: 'Selection window has expired.' })
    }

    // Validate that the chosen slot was one of the offered options
    if (lr.available_slots && lr.available_slots.length > 0) {
      const norm = s => ({
        d: (typeof s.date === 'string' ? s.date : new Date(s.date).toISOString()).slice(0, 10),
        s: (s.start_time || '').slice(0, 5),
        e: (s.end_time   || '').slice(0, 5),
      })
      const req_slot = norm({ date, start_time, end_time })
      const valid = lr.available_slots.some(s => {
        const n = norm(s)
        return n.d === req_slot.d && n.s === req_slot.s && n.e === req_slot.e
      })
      if (!valid) {
        await client.query('ROLLBACK')
        return res.status(400).json({ message: 'The selected slot is not one of the offered options.' })
      }
    }

    // Fetch session + reschedule it
    const { rows: [session] } = await client.query(
      'SELECT * FROM coaching_sessions WHERE id=$1 AND club_id=$2', [lr.session_id, clubId]
    )
    if (!session) {
      await client.query('ROLLBACK')
      return res.status(404).json({ message: 'Session not found.' })
    }

    await checkAndAssignCourt(client, session, date, start_time, end_time, [], clubId)
    const { rows: [updated] } = await client.query(
      'UPDATE coaching_sessions SET date=$1, start_time=$2, end_time=$3, court_id=NULL, status=\'confirmed\' WHERE id=$4 AND club_id=$5 RETURNING *',
      [date, start_time, end_time, session.id, clubId]
    )

    // Mark leave request as rescheduled
    await client.query(
      `UPDATE session_leave_requests SET status='rescheduled', resolved_at=NOW() WHERE id=$1`,
      [lr.id]
    )

    await client.query('COMMIT')

    // Notify all three parties
    const timeRange = `${fmtTime(start_time)} – ${fmtTime(end_time)}`
    const newDate = fmtDate(date)
    const studentMsg = `✅ Your session has been rescheduled.\nNew time: ${newDate}, ${timeRange}`
    const adminMsg   = `✅ Session rescheduled: ${lr.student_name} → ${newDate}, ${timeRange}`
    const coachMsg   = `📅 Session update: ${lr.student_name} rescheduled to ${newDate}, ${timeRange}`

    const { rows: adminRows } = await pool.query(
      `SELECT id FROM users WHERE role='admin' AND club_id=$1 ORDER BY id`, [clubId]
    )
    const { rows: [coachRow] } = await pool.query(
      `SELECT user_id FROM coaches WHERE id=$1`, [session.coach_id]
    )
    const firstAdmin = adminRows[0]
    // Use the admin who originally approved (same thread as the slot options message)
    const approvingAdminId = lr.resolved_by ?? firstAdmin?.id

    // Student confirmation — from the approving admin so it lands in the same thread as slot options
    await sendSystemMessage(approvingAdminId, req.user.id, studentMsg)
    // All admins get the confirmation — sent from the student so it lands in their conversation thread
    for (const admin of adminRows) {
      await sendSystemMessage(req.user.id, admin.id, adminMsg)
    }
    // Coach confirmation
    if (coachRow?.user_id) await sendSystemMessage(approvingAdminId ?? firstAdmin?.id, coachRow.user_id, coachMsg)

    res.json({ session: updated })
  } catch (err) {
    await client.query('ROLLBACK')
    return rescheduleConflictResponse(err, res)
  } finally { client.release() }
})

// POST /api/coaching/coach-leave  (admin)
// Admin triggers coach leave → creates approved leave requests for each affected student
// body: { coach_user_id, date_from, date_to?, reason? }
router.post('/coach-leave', requireAuth, requireAdmin, async (req, res) => {
  const clubId = req.club?.id ?? req.user?.club_id ?? null
  const { coach_user_id, date_from, date_to, reason } = req.body
  if (!coach_user_id || !date_from) return res.status(400).json({ message: 'coach_user_id and date_from are required.' })

  try {
    // Resolve coach
    const { rows: [coach] } = await pool.query(
      `SELECT co.id, co.name FROM coaches co WHERE co.user_id=$1 AND co.club_id=$2`,
      [coach_user_id, clubId]
    )
    if (!coach) return res.status(404).json({ message: 'Coach not found.' })

    // Find all confirmed sessions for this coach in the date range
    const { rows: sessions } = await pool.query(
      `SELECT cs.*, u.name AS student_name
       FROM coaching_sessions cs
       JOIN users u ON u.id = cs.student_id
       WHERE cs.coach_id=$1 AND cs.status='confirmed' AND cs.club_id=$2
         AND cs.date >= $3 AND cs.date <= $4
       ORDER BY cs.date, cs.start_time`,
      [coach.id, clubId, date_from, date_to || date_from]
    )

    if (!sessions.length) {
      return res.json({ message: 'No confirmed sessions found in that date range.', processed: 0 })
    }

    const results = []
    const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString()

    for (const session of sessions) {
      // Skip if already has an active leave request
      const { rows: existing } = await pool.query(
        `SELECT 1 FROM session_leave_requests
         WHERE session_id=$1 AND status IN ('pending','approved') LIMIT 1`,
        [session.id]
      )
      if (existing.length) continue

      // Compute session duration in minutes
      const [sh, sm] = session.start_time.slice(0,5).split(':').map(Number)
      const [eh, em] = session.end_time.slice(0,5).split(':').map(Number)
      const durationMins = (eh * 60 + em) - (sh * 60 + sm)

      // Find available makeup slots
      const slots = await getAvailableSlots(clubId, coach.id, durationMins, session.id)

      // Create an already-approved leave request
      const { rows: [lr] } = await pool.query(
        `INSERT INTO session_leave_requests
           (session_id, student_id, club_id, reason, status, expires_at, resolved_by)
         VALUES ($1, $2, $3, $4, 'approved', $5, $6)
         RETURNING id`,
        [session.id, session.student_id, clubId, reason || `${coach.name} leave`, expiresAt, req.user.id]
      )

      // Build message body
      const timeRange = `${fmtTime(session.start_time)} – ${fmtTime(session.end_time)}`
      let msgBody = `📅 Your session with ${coach.name} on ${fmtDate(session.date)} (${timeRange}) has been cancelled due to coach leave.\n\nPlease choose a makeup time within 48 hours:`
      if (slots.length === 0) {
        msgBody += '\n\n(No available slots found. Please contact us to arrange an alternative.)'
      }

      // Send slot options message to student
      const { rows: [msg] } = await pool.query(
        `INSERT INTO messages (sender_id, recipient_id, body, metadata)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [req.user.id, session.student_id, msgBody,
         JSON.stringify({ type: 'slot_options', request_id: lr.id, slots, expires_at: expiresAt })]
      )
      await pool.query(
        'INSERT INTO message_reads (message_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [msg.id, req.user.id]
      )
      await pool.query(
        `DELETE FROM message_thread_hidden
         WHERE (user_id=$1 AND other_user_id=$2) OR (user_id=$2 AND other_user_id=$1)`,
        [req.user.id, session.student_id]
      )

      results.push({ session_id: session.id, student: session.student_name, slots_offered: slots.length })
    }

    res.json({
      message: `Processed ${results.length} session${results.length !== 1 ? 's' : ''}. Students have been notified with makeup options.`,
      processed: results.length,
      results,
    })
  } catch (e) {
    console.error('[coach-leave]', e)
    res.status(500).json({ message: 'Server error.' })
  }
})

// ── Coach Leave Requests (coach-initiated) ────────────────────────────────────

// GET /api/coaching/coach-sessions?date=YYYY-MM-DD  (coach)
// Returns the coach's confirmed sessions on a given date for session selection.
router.get('/coach-sessions', requireAuth, async (req, res) => {
  if (req.user.role !== 'coach') return res.status(403).json({ message: 'Coaches only.' })
  const clubId = req.club?.id ?? req.user?.club_id ?? null
  const { date } = req.query
  if (!date) return res.status(400).json({ message: 'date is required.' })
  try {
    const { rows } = await pool.query(
      `SELECT cs.id, cs.date, cs.start_time, cs.end_time,
              u.name AS student_name
       FROM coaching_sessions cs
       JOIN coaches co ON co.id = cs.coach_id
       JOIN users u ON u.id = cs.student_id
       WHERE co.user_id = $1 AND cs.date = $2 AND cs.status = 'confirmed' AND cs.club_id = $3
       ORDER BY cs.start_time`,
      [req.user.id, date, clubId]
    )
    res.json({ sessions: rows })
  } catch (e) { console.error(e); res.status(500).json({ message: 'Server error.' }) }
})

// POST /api/coaching/coach-leave-requests  (coach)
// Coach submits a leave request with selected session IDs. Admin sees full list.
router.post('/coach-leave-requests', requireAuth, async (req, res) => {
  const clubId = req.club?.id ?? req.user?.club_id ?? null
  if (req.user.role !== 'coach') return res.status(403).json({ message: 'Only coaches can submit leave requests.' })

  const { date_from, reason, session_ids } = req.body
  if (!date_from) return res.status(400).json({ message: 'date_from is required.' })

  try {
    // Find admin for this club
    const { rows: [admin] } = await pool.query(
      `SELECT id FROM users WHERE role='admin' AND club_id=$1 LIMIT 1`, [clubId]
    )
    if (!admin) return res.status(500).json({ message: 'No admin found for this club.' })

    // Fetch session details to include in message metadata
    let sessions = []
    if (Array.isArray(session_ids) && session_ids.length > 0) {
      const { rows } = await pool.query(
        `SELECT cs.id, cs.date, cs.start_time, cs.end_time, u.name AS student_name
         FROM coaching_sessions cs
         JOIN users u ON u.id = cs.student_id
         WHERE cs.id = ANY($1::int[]) AND cs.club_id = $2`,
        [session_ids, clubId]
      )
      sessions = rows
    }

    // Insert leave request
    const { rows: [lr] } = await pool.query(
      `INSERT INTO coach_leave_requests (coach_user_id, date_from, date_to, reason, club_id, session_ids)
       VALUES ($1,$2,$2,$3,$4,$5) RETURNING id`,
      [req.user.id, date_from, reason || null, clubId, JSON.stringify(session_ids || [])]
    )

    const dateLabel = new Date(date_from + 'T12:00:00').toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })

    // Build message body with session list
    let sessionLines = sessions.map(s =>
      `  • ${fmtDate(s.date)} · ${fmtTime(s.start_time)}–${fmtTime(s.end_time)} (${s.student_name})`
    ).join('\n')
    const msgBody = `📋 Coach Leave Request\nDate: ${dateLabel}\nReason: ${reason || 'No reason given.'}${sessionLines ? '\n\nAffected sessions:\n' + sessionLines : ''}`

    // Send message to admin
    const { rows: [msg] } = await pool.query(
      `INSERT INTO messages (sender_id, recipient_id, body, metadata)
       VALUES ($1,$2,$3,$4) RETURNING id`,
      [req.user.id, admin.id, msgBody,
       JSON.stringify({ type: 'coach_leave_request', request_id: lr.id, sessions })]
    )
    await pool.query(
      'INSERT INTO message_reads (message_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
      [msg.id, req.user.id]
    )
    await pool.query(
      `DELETE FROM message_thread_hidden
       WHERE (user_id=$1 AND other_user_id=$2) OR (user_id=$2 AND other_user_id=$1)`,
      [req.user.id, admin.id]
    )

    res.status(201).json({ request_id: lr.id })
  } catch (e) {
    console.error('[coach-leave-requests]', e)
    res.status(500).json({ message: 'Server error.' })
  }
})

// POST /api/coaching/coach-leave-requests/:id/approve  (admin)
// Just approves the leave. Admin then assigns substitute coaches separately.
router.post('/coach-leave-requests/:id/approve', requireAuth, requireAdmin, async (req, res) => {
  const clubId = req.club?.id ?? req.user?.club_id ?? null
  try {
    const { rows: [lr] } = await pool.query(
      `SELECT clr.*, u.name AS coach_name
       FROM coach_leave_requests clr
       JOIN users u ON u.id = clr.coach_user_id
       WHERE clr.id=$1 AND clr.status='pending' AND clr.club_id=$2`,
      [req.params.id, clubId]
    )
    if (!lr) return res.status(404).json({ message: 'Leave request not found or already actioned.' })

    // Approve the request
    await pool.query(
      `UPDATE coach_leave_requests SET status='approved', resolved_by=$1, resolved_at=NOW() WHERE id=$2`,
      [req.user.id, lr.id]
    )

    // Notify coach that leave is approved
    const dateLabel = fmtDate(String(lr.date_from).slice(0,10))
    const coachMsg = `✅ Your leave request for ${dateLabel} has been approved. The admin will arrange coverage for your sessions.`
    const { rows: [notif] } = await pool.query(
      `INSERT INTO messages (sender_id, recipient_id, body) VALUES ($1,$2,$3) RETURNING id`,
      [req.user.id, lr.coach_user_id, coachMsg]
    )
    await pool.query('INSERT INTO message_reads (message_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [notif.id, req.user.id])

    res.json({ message: 'Approved.' })
  } catch (e) {
    console.error('[coach-leave-requests/approve]', e)
    res.status(500).json({ message: 'Server error.' })
  }
})

// POST /api/coaching/coach-leave-requests/:id/assign-cover  (admin)
// Admin assigns substitute coaches for specific sessions.
// body: { coverages: [{ session_id, sub_coach_id }] }
router.post('/coach-leave-requests/:id/assign-cover', requireAuth, requireAdmin, async (req, res) => {
  const clubId = req.club?.id ?? req.user?.club_id ?? null
  const { coverages } = req.body
  if (!Array.isArray(coverages) || coverages.length === 0)
    return res.status(400).json({ message: 'coverages array is required.' })

  try {
    const { rows: [lr] } = await pool.query(
      `SELECT clr.*, u.name AS coach_name
       FROM coach_leave_requests clr
       JOIN users u ON u.id = clr.coach_user_id
       WHERE clr.id=$1 AND clr.status='approved' AND clr.club_id=$2`,
      [req.params.id, clubId]
    )
    if (!lr) return res.status(404).json({ message: 'Approved leave request not found.' })

    // Insert coverage requests
    const inserted = []
    for (const cv of coverages) {
      const { rows: [ccr] } = await pool.query(
        `INSERT INTO coach_coverage_requests (leave_req_id, session_id, sub_coach_id, club_id)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT DO NOTHING RETURNING *`,
        [lr.id, cv.session_id, cv.sub_coach_id, clubId]
      )
      if (ccr) inserted.push(ccr)
    }

    // Group by substitute coach to send one message per coach
    const byCoach = {}
    for (const ccr of inserted) {
      if (!byCoach[ccr.sub_coach_id]) byCoach[ccr.sub_coach_id] = []
      byCoach[ccr.sub_coach_id].push(ccr)
    }

    for (const [subCoachId, items] of Object.entries(byCoach)) {
      // Get sub coach user_id
      const { rows: [subCoach] } = await pool.query(
        `SELECT co.id, co.name, u.id AS user_id
         FROM coaches co JOIN users u ON u.id = co.user_id
         WHERE co.id=$1`, [subCoachId]
      )
      if (!subCoach?.user_id) continue

      // Fetch session details for this coach's assignments
      const sessionIds = items.map(i => i.session_id)
      const { rows: sessions } = await pool.query(
        `SELECT cs.id, cs.date, cs.start_time, cs.end_time, u.name AS student_name
         FROM coaching_sessions cs JOIN users u ON u.id = cs.student_id
         WHERE cs.id = ANY($1::int[])
         ORDER BY cs.date, cs.start_time`,
        [sessionIds]
      )

      // Build message
      const sessionLines = sessions.map(s =>
        `  • ${fmtDate(s.date)} · ${fmtTime(s.start_time)}–${fmtTime(s.end_time)} (${s.student_name})`
      ).join('\n')
      const msgBody = `📅 Coverage Request\nCan you cover sessions for ${lr.coach_name}?\n\n${sessionLines}\n\nPlease accept or decline below.`

      const coveragesForMsg = items.map(ccr => {
        const s = sessions.find(x => x.id === ccr.session_id) || {}
        return { id: ccr.id, session_id: ccr.session_id, date: s.date, start_time: s.start_time, end_time: s.end_time, student_name: s.student_name }
      })

      const { rows: [msg] } = await pool.query(
        `INSERT INTO messages (sender_id, recipient_id, body, metadata)
         VALUES ($1,$2,$3,$4) RETURNING id`,
        [req.user.id, subCoach.user_id, msgBody,
         JSON.stringify({ type: 'coverage_request', leave_req_id: lr.id, coverages: coveragesForMsg })]
      )
      await pool.query('INSERT INTO message_reads (message_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [msg.id, req.user.id])
      await pool.query(`DELETE FROM message_thread_hidden WHERE (user_id=$1 AND other_user_id=$2) OR (user_id=$2 AND other_user_id=$1)`, [req.user.id, subCoach.user_id])
    }

    res.json({ message: 'Coverage requests sent.', count: inserted.length })
  } catch (e) {
    console.error('[assign-cover]', e)
    res.status(500).json({ message: 'Server error.' })
  }
})

// POST /api/coaching/coverage-requests/:id/respond  (coach)
// body: { accept: true|false }
router.post('/coverage-requests/:id/respond', requireAuth, async (req, res) => {
  if (req.user.role !== 'coach') return res.status(403).json({ message: 'Coaches only.' })
  const clubId = req.club?.id ?? req.user?.club_id ?? null
  const { accept } = req.body

  try {
    // Get coverage request + sub coach
    const { rows: [ccr] } = await pool.query(
      `SELECT ccr.*, co.user_id AS sub_user_id, co.name AS sub_coach_name,
              cs.date, cs.start_time, cs.end_time, cs.student_id,
              u.name AS student_name,
              clr.coach_user_id AS orig_coach_user_id
       FROM coach_coverage_requests ccr
       JOIN coaches co ON co.id = ccr.sub_coach_id
       JOIN coaching_sessions cs ON cs.id = ccr.session_id
       JOIN users u ON u.id = cs.student_id
       JOIN coach_leave_requests clr ON clr.id = ccr.leave_req_id
       WHERE ccr.id=$1 AND co.user_id=$2 AND ccr.status='pending' AND ccr.club_id=$3`,
      [req.params.id, req.user.id, clubId]
    )
    if (!ccr) return res.status(404).json({ message: 'Coverage request not found or already responded.' })

    const newStatus = accept ? 'accepted' : 'declined'
    await pool.query(`UPDATE coach_coverage_requests SET status=$1 WHERE id=$2`, [newStatus, ccr.id])

    // Find admin
    const { rows: [admin] } = await pool.query(
      `SELECT id FROM users WHERE role='admin' AND club_id=$1 LIMIT 1`, [clubId]
    )

    const sessionLabel = `${fmtDate(ccr.date)} · ${fmtTime(ccr.start_time)}–${fmtTime(ccr.end_time)}`

    if (accept) {
      // Reassign session to substitute coach
      const { rowCount } = await pool.query(
        `UPDATE coaching_sessions SET coach_id=$1, status='confirmed' WHERE id=$2`,
        [ccr.sub_coach_id, ccr.session_id]
      )
      console.log(`[coverage-respond] accept: session_id=${ccr.session_id}, new coach_id=${ccr.sub_coach_id}, rows_updated=${rowCount}`)
      // Notify admin
      if (admin) await sendSystemMessage(req.user.id, admin.id,
        `✅ ${ccr.sub_coach_name} accepted coverage for ${sessionLabel} (${ccr.student_name}).`)
    } else {
      // Notify admin with actionable message — includes metadata so frontend can show "Offer Slot" button
      if (admin) {
        const declineBody = `❌ ${ccr.sub_coach_name} 無法代課\n課程：${sessionLabel}\n學生：${ccr.student_name}\n\n請安排其他代課教練，或讓學生自行選擇補課時間。`
        const { rows: [dm] } = await pool.query(
          `INSERT INTO messages (sender_id, recipient_id, body, metadata)
           VALUES ($1,$2,$3,$4) RETURNING id`,
          [req.user.id, admin.id, declineBody,
           JSON.stringify({
             type: 'coverage_declined',
             session_id: ccr.session_id,
             leave_req_id: ccr.leave_req_id,
             coverage_id: ccr.id,
             // embed session details so frontend doesn't need an extra fetch
             session: { id: ccr.session_id, date: ccr.date, start_time: ccr.start_time, end_time: ccr.end_time, student_name: ccr.student_name },
           })]
        )
        await pool.query('INSERT INTO message_reads (message_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [dm.id, req.user.id])
      }
    }

    res.json({ message: accept ? 'Coverage accepted.' : 'Coverage declined.' })
  } catch (e) {
    console.error('[coverage-respond]', e)
    res.status(500).json({ message: 'Server error.' })
  }
})

// POST /api/coaching/coach-leave-requests/:id/offer-student-slots  (admin)
// For uncovered sessions: cancel sessions and offer students makeup slots.
router.post('/coach-leave-requests/:id/offer-student-slots', requireAuth, requireAdmin, async (req, res) => {
  const clubId = req.club?.id ?? req.user?.club_id ?? null
  try {
    const { rows: [lr] } = await pool.query(
      `SELECT clr.*, u.name AS coach_name
       FROM coach_leave_requests clr JOIN users u ON u.id = clr.coach_user_id
       WHERE clr.id=$1 AND clr.club_id=$2`,
      [req.params.id, clubId]
    )
    if (!lr) return res.status(404).json({ message: 'Leave request not found.' })

    // Find uncovered sessions (no accepted coverage)
    const sessionIds = lr.session_ids || []
    if (!sessionIds.length) return res.json({ message: 'No sessions to process.', count: 0 })

    const { rows: sessions } = await pool.query(
      `SELECT cs.*, u.name AS student_name
       FROM coaching_sessions cs JOIN users u ON u.id = cs.student_id
       WHERE cs.id = ANY($1::int[]) AND cs.status IN ('confirmed','leave_cancelled')
         AND NOT EXISTS (
           SELECT 1 FROM coach_coverage_requests ccr
           WHERE ccr.session_id = cs.id AND ccr.status = 'accepted'
         )`,
      [sessionIds]
    )

    const { rows: [coach] } = await pool.query(
      `SELECT id FROM coaches WHERE user_id=$1 AND club_id=$2`, [lr.coach_user_id, clubId]
    )

    const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString()
    let count = 0
    for (const session of sessions) {
      try {
        const { rows: existing } = await pool.query(
          `SELECT 1 FROM session_leave_requests WHERE session_id=$1 AND status IN ('pending','approved','rescheduled') LIMIT 1`,
          [session.id]
        )
        if (existing.length) continue

        const [sh, sm] = session.start_time.slice(0,5).split(':').map(Number)
        const [eh, em] = session.end_time.slice(0,5).split(':').map(Number)
        const durationMins = (eh * 60 + em) - (sh * 60 + sm)
        const slots = coach ? await getAvailableSlots(clubId, coach.id, durationMins, session.id) : []

        await pool.query(`UPDATE coaching_sessions SET status='leave_cancelled' WHERE id=$1`, [session.id])

        const { rows: [slr] } = await pool.query(
          `INSERT INTO session_leave_requests
             (session_id, student_id, club_id, reason, status, expires_at, resolved_by)
           VALUES ($1,$2,$3,$4,'approved',$5,$6) RETURNING id`,
          [session.id, session.student_id, clubId, lr.reason || `${lr.coach_name} leave`, expiresAt, req.user.id]
        )
        const timeRange = `${fmtTime(session.start_time)} – ${fmtTime(session.end_time)}`
        const msgBody = `📅 Your session with ${lr.coach_name} on ${fmtDate(session.date)} (${timeRange}) has been cancelled due to coach leave.\n\nPlease choose a makeup time within 48 hours:${slots.length === 0 ? '\n\n(No available slots found. Please contact us.)' : ''}`
        const { rows: [msg] } = await pool.query(
          `INSERT INTO messages (sender_id, recipient_id, body, metadata)
           VALUES ($1,$2,$3,$4) RETURNING id`,
          [req.user.id, session.student_id, msgBody,
           JSON.stringify({ type: 'slot_options', request_id: slr.id, slots, expires_at: expiresAt })]
        )
        await pool.query('INSERT INTO message_reads (message_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [msg.id, req.user.id])
        await pool.query(`DELETE FROM message_thread_hidden WHERE (user_id=$1 AND other_user_id=$2) OR (user_id=$2 AND other_user_id=$1)`, [req.user.id, session.student_id])
        count++
      } catch (err) {
        console.error(`[offer-student-slots] session ${session.id}:`, err)
      }
    }

    res.json({ message: 'Student slot options sent.', count })
  } catch (e) {
    console.error('[offer-student-slots]', e)
    res.status(500).json({ message: 'Server error.' })
  }
})

// POST /api/coaching/sessions/:sessionId/offer-student-slot  (admin)
// Offer makeup slot options to the student of a single uncovered session.
router.post('/sessions/:sessionId/offer-student-slot', requireAuth, requireAdmin, async (req, res) => {
  const clubId = req.club?.id ?? req.user?.club_id ?? null
  const { sessionId } = req.params
  try {
    const { rows: [session] } = await pool.query(
      `SELECT cs.*, u.name AS student_name, co.id AS coach_rec_id, clru.name AS coach_name
       FROM coaching_sessions cs
       JOIN users u ON u.id = cs.student_id
       JOIN coaches co ON co.id = cs.coach_id
       LEFT JOIN users clru ON clru.id = co.user_id
       WHERE cs.id=$1 AND cs.club_id=$2`,
      [sessionId, clubId]
    )
    if (!session) return res.status(404).json({ message: 'Session not found.' })

    // Block if a cover coach has already accepted this session
    const { rows: coveredRows } = await pool.query(
      `SELECT 1 FROM coach_coverage_requests WHERE session_id=$1 AND status='accepted' LIMIT 1`,
      [sessionId]
    )
    if (coveredRows.length) return res.status(409).json({ message: 'This session already has an accepted cover coach.' })

    // Check no active student leave request already
    const { rows: existing } = await pool.query(
      `SELECT 1 FROM session_leave_requests WHERE session_id=$1 AND status IN ('pending','approved','rescheduled') LIMIT 1`,
      [sessionId]
    )
    if (existing.length) return res.status(409).json({ message: 'Student already has an active leave/slot request for this session.' })

    const [sh, sm] = session.start_time.slice(0,5).split(':').map(Number)
    const [eh, em] = session.end_time.slice(0,5).split(':').map(Number)
    const durationMins = (eh * 60 + em) - (sh * 60 + sm)
    const slots = await getAvailableSlots(clubId, session.coach_rec_id, durationMins, Number(sessionId))

    await pool.query(`UPDATE coaching_sessions SET status='leave_cancelled' WHERE id=$1`, [sessionId])

    const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString()
    const { rows: [slr] } = await pool.query(
      `INSERT INTO session_leave_requests (session_id, student_id, club_id, reason, status, expires_at, resolved_by)
       VALUES ($1,$2,$3,$4,'approved',$5,$6) RETURNING id`,
      [sessionId, session.student_id, clubId, 'Coach unavailable', expiresAt, req.user.id]
    )
    const timeRange = `${fmtTime(session.start_time)} – ${fmtTime(session.end_time)}`
    const msgBody = `📅 Your session on ${fmtDate(session.date)} (${timeRange}) has been cancelled as the coach is unavailable.\n\nPlease choose a makeup time within 48 hours:${slots.length === 0 ? '\n\n(No available slots found. Please contact us.)' : ''}`
    const { rows: [msg] } = await pool.query(
      `INSERT INTO messages (sender_id, recipient_id, body, metadata) VALUES ($1,$2,$3,$4) RETURNING id`,
      [req.user.id, session.student_id, msgBody,
       JSON.stringify({ type: 'slot_options', request_id: slr.id, slots, expires_at: expiresAt })]
    )
    await pool.query('INSERT INTO message_reads (message_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [msg.id, req.user.id])
    await pool.query(`DELETE FROM message_thread_hidden WHERE (user_id=$1 AND other_user_id=$2) OR (user_id=$2 AND other_user_id=$1)`, [req.user.id, session.student_id])

    res.json({ message: 'Slot options sent to student.' })
  } catch (e) {
    console.error('[offer-student-slot]', e)
    res.status(500).json({ message: 'Server error.' })
  }
})

// POST /api/coaching/coach-leave-requests/:id/reject  (admin)
router.post('/coach-leave-requests/:id/reject', requireAuth, requireAdmin, async (req, res) => {
  const clubId = req.club?.id ?? req.user?.club_id ?? null
  try {
    const { rows: [lr] } = await pool.query(
      `SELECT * FROM coach_leave_requests WHERE id=$1 AND status='pending' AND club_id=$2`,
      [req.params.id, clubId]
    )
    if (!lr) return res.status(404).json({ message: 'Leave request not found or already actioned.' })

    await pool.query(
      `UPDATE coach_leave_requests SET status='rejected', resolved_by=$1, resolved_at=NOW() WHERE id=$2`,
      [req.user.id, lr.id]
    )
    res.json({ message: 'Rejected.' })
  } catch (e) {
    console.error('[coach-leave-requests/reject]', e)
    res.status(500).json({ message: 'Server error.' })
  }
})

module.exports = router
