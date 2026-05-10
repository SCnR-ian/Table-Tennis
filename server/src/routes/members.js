const router = require('express').Router()
const pool   = require('../db')
const { requireAuth } = require('../middleware/auth')

const safeUser = (u) => ({
  id: u.id, name: u.name, email: u.email,
  role: u.role, phone: u.phone, avatar_url: u.avatar_url, created_at: u.created_at,
})

// GET /api/members/:id
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const clubId = req.club?.id ?? req.user?.club_id ?? null
    const { rows } = await pool.query(
      'SELECT * FROM users WHERE id=$1 AND club_id=$2',
      [req.params.id, clubId]
    )
    if (!rows[0]) return res.status(404).json({ message: 'Member not found.' })
    res.json({ member: safeUser(rows[0]) })
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
