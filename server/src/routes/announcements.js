const router = require('express').Router()
const pool   = require('../db')
const { requireAuth, requireAdmin } = require('../middleware/auth')

// GET /api/announcements
router.get('/', async (req, res) => {
  try {
    const clubId = req.club?.id ?? req.user?.club_id ?? null
    const limit = Math.min(parseInt(req.query.limit) || 20, 100)
    const { rows } = await pool.query(
      'SELECT * FROM announcements WHERE club_id=$1 ORDER BY created_at DESC LIMIT $2',
      [clubId, limit]
    )
    res.json({ announcements: rows })
  } catch { res.status(500).json({ message: 'Server error.' }) }
})

// POST /api/announcements  (admin)
router.post('/', requireAuth, requireAdmin, async (req, res) => {
  const { title, body } = req.body
  if (!title?.trim() || !body?.trim())
    return res.status(400).json({ message: 'title and body are required.' })
  const clubId = req.club?.id ?? req.user?.club_id ?? null
  try {
    const { rows: [row] } = await pool.query(
      `INSERT INTO announcements (title, body, club_id) VALUES ($1,$2,$3) RETURNING *`,
      [title.trim(), body.trim(), clubId]
    )
    res.status(201).json({ announcement: row })
  } catch { res.status(500).json({ message: 'Server error.' }) }
})

// PUT /api/announcements/:id  (admin)
router.put('/:id', requireAuth, requireAdmin, async (req, res) => {
  const { title, body } = req.body
  if (!title?.trim() || !body?.trim())
    return res.status(400).json({ message: 'title and body are required.' })
  const clubId = req.club?.id ?? req.user?.club_id ?? null
  try {
    const { rows: [row] } = await pool.query(
      `UPDATE announcements SET title=$1, body=$2 WHERE id=$3 AND club_id=$4 RETURNING *`,
      [title.trim(), body.trim(), req.params.id, clubId]
    )
    if (!row) return res.status(404).json({ message: 'Not found.' })
    res.json({ announcement: row })
  } catch { res.status(500).json({ message: 'Server error.' }) }
})

// DELETE /api/announcements/:id  (admin)
router.delete('/:id', requireAuth, requireAdmin, async (req, res) => {
  const clubId = req.club?.id ?? req.user?.club_id ?? null
  try {
    const { rowCount } = await pool.query(
      'DELETE FROM announcements WHERE id=$1 AND club_id=$2',
      [req.params.id, clubId]
    )
    if (rowCount === 0) return res.status(404).json({ message: 'Not found.' })
    res.json({ message: 'Deleted.' })
  } catch { res.status(500).json({ message: 'Server error.' }) }
})

module.exports = router
