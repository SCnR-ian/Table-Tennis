const router = require('express').Router()
const pool   = require('../db')

// GET /api/courts
router.get('/', async (req, res) => {
  try {
    const clubId = req.club?.id ?? req.user?.club_id ?? null
    const { rows } = await pool.query(
      'SELECT * FROM courts WHERE is_active=TRUE AND club_id=$1 ORDER BY id',
      [clubId]
    )
    res.json({ courts: rows })
  } catch { res.status(500).json({ message: 'Server error.' }) }
})

// GET /api/courts/:id
router.get('/:id', async (req, res) => {
  try {
    const clubId = req.club?.id ?? req.user?.club_id ?? null
    const { rows } = await pool.query(
      'SELECT * FROM courts WHERE id=$1 AND club_id=$2',
      [req.params.id, clubId]
    )
    if (!rows[0]) return res.status(404).json({ message: 'Court not found.' })
    res.json({ court: rows[0] })
  } catch { res.status(500).json({ message: 'Server error.' }) }
})

module.exports = router
