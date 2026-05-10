const router = require('express').Router()
const bcrypt = require('bcryptjs')
const pool   = require('../db')
const { requireAuth } = require('../middleware/auth')

const safeUser = (u) => ({
  id: u.id, name: u.name, email: u.email,
  role: u.role, phone: u.phone, avatar_url: u.avatar_url,
  name_changed_at: u.name_changed_at ?? null,
})

// GET /api/profile
router.get('/', requireAuth, async (req, res) => {
  try {
    const clubId = req.club?.id ?? req.user?.club_id ?? null
    const { rows } = await pool.query(
      'SELECT * FROM users WHERE id=$1 AND club_id=$2',
      [req.user.id, clubId]
    )
    if (!rows[0]) return res.status(404).json({ message: 'Not found.' })
    res.json({ user: safeUser(rows[0]) })
  } catch { res.status(500).json({ message: 'Server error.' }) }
})

// PUT /api/profile
router.put('/', requireAuth, async (req, res) => {
  const { name, phone } = req.body
  try {
    const { rows: [current] } = await pool.query(
      'SELECT name, name_changed_at FROM users WHERE id=$1', [req.user.id]
    )
    const nameChanging = name && name.trim() !== current.name

    // Enforce one name change per week
    if (nameChanging && current.name_changed_at) {
      const daysSince = (Date.now() - new Date(current.name_changed_at)) / (1000 * 60 * 60 * 24)
      if (daysSince < 7) {
        const nextAllowed = new Date(new Date(current.name_changed_at).getTime() + 7 * 24 * 60 * 60 * 1000)
        return res.status(429).json({
          message: `You can only change your name once per week. Next allowed: ${nextAllowed.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' })}.`
        })
      }
    }

    const { rows } = await pool.query(
      `UPDATE users SET name=$1, phone=$2, updated_at=NOW()
       ${nameChanging ? ', name_changed_at=NOW()' : ''}
       WHERE id=$3 RETURNING *`,
      [name, phone || null, req.user.id]
    )

    // Notify all admins via message
    if (nameChanging) {
      const clubId = req.club?.id ?? req.user?.club_id ?? null
      const { rows: admins } = await pool.query(
        `SELECT id FROM users WHERE role='admin' AND club_id=$1`,
        [clubId]
      )
      const body = `${current.name} has changed their name to "${name.trim()}".`
      for (const admin of admins) {
        await pool.query(
          `INSERT INTO messages (sender_id, recipient_id, body) VALUES ($1, $2, $3)`,
          [req.user.id, admin.id, body]
        )
      }
    }

    res.json({ user: safeUser(rows[0]) })
  } catch { res.status(500).json({ message: 'Server error.' }) }
})

// POST /api/profile/password
router.post('/password', requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body
  if (!currentPassword || !newPassword)
    return res.status(400).json({ message: 'Both passwords are required.' })

  try {
    const { rows } = await pool.query('SELECT * FROM users WHERE id=$1', [req.user.id])
    const user = rows[0]
    if (!user.password_hash)
      return res.status(400).json({ message: 'OAuth accounts cannot set a password here.' })

    const ok = await bcrypt.compare(currentPassword, user.password_hash)
    if (!ok) return res.status(401).json({ message: 'Current password is incorrect.' })

    const hash = await bcrypt.hash(newPassword, 12)
    await pool.query('UPDATE users SET password_hash=$1, updated_at=NOW() WHERE id=$2', [hash, user.id])
    res.json({ message: 'Password updated.' })
  } catch { res.status(500).json({ message: 'Server error.' }) }
})

module.exports = router
