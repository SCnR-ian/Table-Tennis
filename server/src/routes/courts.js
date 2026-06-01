const router = require('express').Router()
const pool   = require('../db')
const { requireAuth, requireAdmin } = require('../middleware/auth')

// GET /api/courts
router.get('/', requireAuth, async (req, res) => {
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

// PUT /api/courts/count (admin) — set total active court count
router.put('/count', requireAuth, requireAdmin, async (req, res) => {
  const { count } = req.body
  const n = parseInt(count, 10)
  if (!n || n < 1 || n > 50) return res.status(400).json({ message: 'Count must be 1–50.' })
  const clubId = req.club?.id ?? req.user?.club_id ?? null
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const { rows: all } = await client.query(
      'SELECT id, is_active FROM courts WHERE club_id=$1 ORDER BY id', [clubId]
    )
    const active   = all.filter(c => c.is_active)
    const inactive = all.filter(c => !c.is_active)

    if (n > active.length) {
      // Re-activate previously deactivated courts first, then insert new ones
      const toReactivate = inactive.slice(0, n - active.length)
      if (toReactivate.length > 0) {
        await client.query(
          'UPDATE courts SET is_active=TRUE WHERE id=ANY($1)',
          [toReactivate.map(r => r.id)]
        )
      }
      const stillNeeded = n - active.length - toReactivate.length
      for (let i = 0; i < stillNeeded; i++) {
        await client.query(
          'INSERT INTO courts (name, club_id, is_active) VALUES ($1,$2,TRUE)',
          [`Court ${all.length + i + 1}`, clubId]
        )
      }
    } else if (n < active.length) {
      const toDeactivate = active.slice(n).map(r => r.id)
      await client.query(
        'UPDATE courts SET is_active=FALSE WHERE id=ANY($1)', [toDeactivate]
      )
    }
    await client.query('COMMIT')
    const { rows } = await client.query(
      'SELECT * FROM courts WHERE is_active=TRUE AND club_id=$1 ORDER BY id', [clubId]
    )
    res.json({ courts: rows })
  } catch (err) {
    await client.query('ROLLBACK')
    res.status(500).json({ message: 'Server error.' })
  } finally { client.release() }
})

module.exports = router
