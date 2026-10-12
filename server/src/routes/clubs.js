// ─── Clubs Route ──────────────────────────────────────────────────────────────
// GET  /api/clubs/current    → returns current club info
// PATCH /api/clubs/current   → admin only: update name / settings
// POST  /api/clubs/logo      → admin only: upload club logo
// ─────────────────────────────────────────────────────────────────────────────

const router  = require('express').Router()
const pool    = require('../db')
const multer  = require('multer')
const path    = require('path')
const fs      = require('fs')
const { requireAuth } = require('../middleware/auth')
const { bustClubCache } = require('../middleware/tenant')

const upload = multer({ dest: 'uploads/logos/', limits: { fileSize: 5 * 1024 * 1024 } })

function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ message: 'Admin only.' })
  next()
}

// GET /api/clubs/current
router.get('/current', (req, res) => {
  if (!req.club) return res.status(404).json({ message: 'Club not found.' })
  const { id, name, subdomain, settings } = req.club
  res.json({ id, name, subdomain, settings })
})

// PATCH /api/clubs/current
router.patch('/current', requireAuth, requireAdmin, async (req, res) => {
  if (!req.club) return res.status(404).json({ message: 'Club not found.' })

  const allowed = ['name', 'settings']
  const updates = {}
  for (const key of allowed) {
    if (req.body[key] !== undefined) updates[key] = req.body[key]
  }
  if (!Object.keys(updates).length)
    return res.status(400).json({ message: 'Nothing to update.' })

  try {
    const setClauses = Object.keys(updates).map((k, i) => `${k} = $${i + 2}`)
    const values     = [req.club.id, ...Object.values(updates)]

    const { rows } = await pool.query(
      `UPDATE clubs SET ${setClauses.join(', ')} WHERE id=$1 RETURNING id, name, subdomain, settings`,
      values
    )
    if (!rows[0]) return res.status(404).json({ message: 'Club not found.' })

    // Bust the tenant cache so the next request picks up the new values
    bustClubCache()

    res.json({ club: rows[0] })
  } catch (err) {
    console.error('[clubs] patch error:', err.message)
    res.status(500).json({ message: 'Server error.' })
  }
})

// POST /api/clubs/logo — upload/replace club logo
router.post('/logo', requireAuth, requireAdmin, upload.single('logo'), async (req, res) => {
  if (!req.club) return res.status(404).json({ message: 'Club not found.' })
  if (!req.file) return res.status(400).json({ message: 'No file uploaded.' })
  try {
    const ext  = path.extname(req.file.originalname) || '.png'
    const dest = path.join('uploads', 'logos', `club-${req.club.id}${ext}`)
    fs.renameSync(req.file.path, dest)
    const logoUrl = `/uploads/logos/club-${req.club.id}${ext}`
    await pool.query(
      `UPDATE clubs SET settings = jsonb_set(settings, '{theme,logoUrl}', $1) WHERE id=$2`,
      [JSON.stringify(logoUrl), req.club.id]
    )
    bustClubCache()
    res.json({ logoUrl })
  } catch (err) {
    if (req.file) fs.unlink(req.file.path, () => {})
    console.error('[clubs/logo]', err.message)
    res.status(500).json({ message: 'Server error.' })
  }
})

module.exports = router
