const router = require('express').Router()
const pool   = require('../db')
const { requireAuth, requireAdmin } = require('../middleware/auth')

// GET /api/schedule  — returns active rows for members, all rows for admin
router.get('/', async (req, res) => {
  try {
    const clubId  = req.club?.id ?? req.user?.club_id ?? null
    // If ?all=1 and admin, return every row (including inactive)
    const showAll = req.query.all === '1'
    const { rows } = await pool.query(
      `SELECT * FROM schedule WHERE club_id=$1 ${showAll ? '' : "AND is_active=TRUE"} ORDER BY id`,
      [clubId]
    )
    res.json({ schedule: rows })
  } catch { res.status(500).json({ message: 'Server error.' }) }
})

// PATCH /api/schedule/:id  (admin) — update a single open-hours row
router.patch('/:id', requireAuth, requireAdmin, async (req, res) => {
  const { day, start_time, end_time, label, is_active } = req.body
  const clubId = req.club?.id ?? req.user?.club_id ?? null
  try {
    const fields = []
    const vals   = []
    let i = 1
    if (day        !== undefined) { fields.push(`day=$${i++}`);        vals.push(day) }
    if (start_time !== undefined) { fields.push(`start_time=$${i++}`); vals.push(start_time) }
    if (end_time   !== undefined) { fields.push(`end_time=$${i++}`);   vals.push(end_time) }
    if (label      !== undefined) { fields.push(`label=$${i++}`);      vals.push(label) }
    if (is_active  !== undefined) { fields.push(`is_active=$${i++}`);  vals.push(is_active) }
    if (!fields.length) return res.status(400).json({ message: 'Nothing to update.' })
    vals.push(req.params.id, clubId)
    const { rows: [row] } = await pool.query(
      `UPDATE schedule SET ${fields.join(', ')} WHERE id=$${i} AND club_id=$${i+1} RETURNING *`,
      vals
    )
    if (!row) return res.status(404).json({ message: 'Not found.' })
    res.json({ row })
  } catch { res.status(500).json({ message: 'Server error.' }) }
})

// POST /api/schedule  (admin) — add a new open-hours row
router.post('/', requireAuth, requireAdmin, async (req, res) => {
  const { day, start_time, end_time, label } = req.body
  if (!day || !start_time || !end_time || !label)
    return res.status(400).json({ message: 'day, start_time, end_time and label are required.' })
  const clubId = req.club?.id ?? req.user?.club_id ?? null
  try {
    const { rows: [row] } = await pool.query(
      `INSERT INTO schedule (day, start_time, end_time, label, club_id) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [day, start_time, end_time, label, clubId]
    )
    res.status(201).json({ row })
  } catch { res.status(500).json({ message: 'Server error.' }) }
})

// DELETE /api/schedule/:id  (admin)
router.delete('/:id', requireAuth, requireAdmin, async (req, res) => {
  const clubId = req.club?.id ?? req.user?.club_id ?? null
  try {
    const { rowCount } = await pool.query(
      'DELETE FROM schedule WHERE id=$1 AND club_id=$2',
      [req.params.id, clubId]
    )
    if (rowCount === 0) return res.status(404).json({ message: 'Not found.' })
    res.json({ message: 'Deleted.' })
  } catch { res.status(500).json({ message: 'Server error.' }) }
})

module.exports = router
