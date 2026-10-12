const router = require('express').Router()
const pool   = require('../db')
const { requireAuth } = require('../middleware/auth')

// Public-safe view (no PII). Email and phone are only exposed to admins or to
// the member themselves; otherwise any logged-in user could collect every
// member's contact details by walking the /:id route.
const publicUser = (u) => ({
  id: u.id, name: u.name, role: u.role,
  avatar_url: u.avatar_url, created_at: u.created_at,
})
const fullUser = (u) => ({ ...publicUser(u), email: u.email, phone: u.phone })

// GET /api/members/:id
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const clubId = req.club?.id ?? req.user?.club_id ?? null
    const { rows } = await pool.query(
      'SELECT * FROM users WHERE id=$1 AND club_id=$2',
      [req.params.id, clubId]
    )
    if (!rows[0]) return res.status(404).json({ message: 'Member not found.' })
    const canSeePII = req.user.role === 'admin' || String(req.user.id) === String(rows[0].id)
    res.json({ member: (canSeePII ? fullUser : publicUser)(rows[0]) })
  } catch { res.status(500).json({ message: 'Server error.' }) }
})

// GET /api/members/:id/stats
router.get('/:id/stats', requireAuth, async (req, res) => {
  try {
    const clubId = req.club?.id ?? req.user?.club_id ?? null
    const bookings = await pool.query(
      "SELECT COUNT(*)::int FROM bookings WHERE user_id=$1 AND club_id=$2 AND status='confirmed'",
      [req.params.id, clubId]
    )
    const tournaments = await pool.query(
      `SELECT COUNT(*)::int FROM tournament_registrations tr
       JOIN tournaments t ON t.id = tr.tournament_id
       WHERE tr.user_id=$1 AND t.club_id=$2`,
      [req.params.id, clubId]
    )
    res.json({
      bookings:    bookings.rows[0].count,
      tournaments: tournaments.rows[0].count,
    })
  } catch { res.status(500).json({ message: 'Server error.' }) }
})

module.exports = router
