const jwt  = require('jsonwebtoken')
const pool = require('../db')

async function requireAuth(req, res, next) {
  const header = req.headers.authorization
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ message: 'No token provided.' })
  }
  const token = header.slice(7)
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET)

    if (req.club && payload.club_id !== undefined && payload.club_id !== req.club.id) {
      return res.status(403).json({ message: 'Token not valid for this club.' })
    }

    // Platform context: resolve club from JWT so routes don't need a subdomain header
    if (!req.club && payload.club_id) {
      try {
        const { rows } = await pool.query(
          'SELECT * FROM clubs WHERE id=$1 AND is_active=TRUE',
          [payload.club_id]
        )
        if (rows[0]) req.club = rows[0]
      } catch (err) {
        console.error('[auth] club lookup:', err.message)
      }
    }

    req.user = payload
    next()
  } catch {
    return res.status(401).json({ message: 'Invalid or expired token.' })
  }
}

function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ message: 'Admin access required.' })
  }
  next()
}

module.exports = { requireAuth, requireAdmin }
