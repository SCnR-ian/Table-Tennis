const router = require('express').Router()
const pool   = require('../db')
const { requireAuth, requireAdmin } = require('../middleware/auth')

// All analytics routes are admin-only
router.use(requireAuth, requireAdmin)

// GET /api/analytics/overview
// Returns:
//   memberGrowth   – weekly new-member counts for the last 12 weeks
//   slotPopularity – day × time-slot activity counts (bookings + coaching + social)
//   attendance     – per-member activity count + last active date
router.get('/overview', async (req, res) => {
  try {
    const clubId = req.club?.id ?? req.user?.club_id ?? null

    // ── 1. Member growth (last 12 weeks, grouped by week) ─────────────────────
    const { rows: growthRows } = await pool.query(`
      SELECT
        TO_CHAR(DATE_TRUNC('week', created_at), 'YYYY-MM-DD') AS week,
        COUNT(*)::int AS new_members
      FROM users
      WHERE role != 'admin'
        AND club_id = $1
        AND created_at >= NOW() - INTERVAL '12 weeks'
      GROUP BY week
      ORDER BY week ASC
    `, [clubId])

    // ── 2. Slot popularity ────────────────────────────────────────────────────
    const { rows: slotRows } = await pool.query(`
      WITH activities AS (
        SELECT date, start_time FROM bookings WHERE status = 'confirmed' AND club_id = $1
        UNION ALL
        SELECT date, start_time FROM coaching_sessions
          WHERE status = 'confirmed' AND club_id = $1 AND group_id IS NULL
        UNION ALL
        SELECT date, start_time FROM (
          SELECT DISTINCT ON (group_id, date, start_time) date, start_time
          FROM coaching_sessions WHERE status = 'confirmed' AND club_id = $1 AND group_id IS NOT NULL
          ORDER BY group_id, date, start_time
        ) cg
        UNION ALL
        SELECT date, start_time FROM social_play_sessions WHERE status = 'open' AND club_id = $1
      )
      SELECT
        TO_CHAR(date, 'Dy') AS day_label,
        EXTRACT(DOW FROM date)::int AS dow,
        TO_CHAR(start_time, 'HH24:MI') AS slot,
        COUNT(*)::int AS count
      FROM activities
      GROUP BY dow, day_label, slot
      ORDER BY dow ASC, slot ASC
    `, [clubId])

    // ── 3. Member attendance ──────────────────────────────────────────────────
    const { rows: attendanceRows } = await pool.query(`
      WITH activity AS (
        SELECT user_id, date FROM bookings WHERE status = 'confirmed' AND club_id = $1
        UNION ALL
        SELECT student_id AS user_id, date FROM coaching_sessions
          WHERE status = 'confirmed' AND club_id = $1
        UNION ALL
        SELECT spp.user_id, sps.date
        FROM social_play_participants spp
        JOIN social_play_sessions sps ON sps.id = spp.session_id
        WHERE sps.status != 'cancelled' AND sps.club_id = $1
      )
      SELECT
        u.id,
        u.name,
        u.email,
        u.created_at,
        COUNT(a.user_id)::int     AS total_activities,
        MAX(a.date)               AS last_active
      FROM users u
      LEFT JOIN activity a ON a.user_id = u.id
      WHERE u.role != 'admin' AND u.club_id = $1
      GROUP BY u.id, u.name, u.email, u.created_at
      ORDER BY total_activities DESC, u.name ASC
    `, [clubId])

    res.json({
      memberGrowth:   growthRows,
      slotPopularity: slotRows,
      attendance:     attendanceRows,
    })
  } catch (err) {
    console.error('Analytics error:', err)
    res.status(500).json({ message: 'Server error.' })
  }
})

module.exports = router
