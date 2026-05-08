// ─── Clubs Route ──────────────────────────────────────────────────────────────
// GET  /api/clubs/current    → returns current club info
// PATCH /api/clubs/current   → admin only: update name / settings
// POST /api/clubs/register   → authenticated user self-registers a new club
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

// GET /api/clubs/mine — returns the club the authenticated user belongs to (platform context)
router.get('/mine', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT c.id, c.name, c.subdomain, c.settings
       FROM users u JOIN clubs c ON c.id = u.club_id
       WHERE u.id = $1`,
      [req.user.id]
    )
    if (!rows[0]) return res.json({ club: null })
    res.json({ club: rows[0] })
  } catch (err) {
    console.error('[clubs/mine]', err.message)
    res.status(500).json({ message: 'Server error.' })
  }
})

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
    bustClubCache(rows[0].subdomain)

    res.json({ club: rows[0] })
  } catch (err) {
    console.error('[clubs] patch error:', err.message)
    res.status(500).json({ message: 'Server error.' })
  }
})

// ── POST /api/clubs/register ─────────────────────────────────────────────────
// Self-service club registration. The authenticated user becomes the club admin.
router.post('/register', requireAuth, upload.single('logo'), async (req, res) => {
  const { name, subdomain, courts, schedule: scheduleJson } = req.body

  if (!name || !subdomain)
    return res.status(400).json({ message: 'Club name and subdomain are required.' })

  const numCourts = Math.max(1, parseInt(courts, 10) || 4)
  // schedule: { Mon: { open: true, from: '09:00', to: '22:00' }, ... }
  const scheduleData = (() => { try { return JSON.parse(scheduleJson) } catch { return {} } })()

  const DAY_LABELS = { Mon:'Monday', Tue:'Tuesday', Wed:'Wednesday', Thu:'Thursday', Fri:'Friday', Sat:'Saturday', Sun:'Sunday' }

  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    // 1. Club row
    const settings = {
      address: '', contactPhone: '', contactEmail: '',
      theme: { primaryColor: '#c0392b' },
    }
    const { rows: [club] } = await client.query(
      `INSERT INTO clubs (name, subdomain, settings) VALUES ($1, $2, $3) RETURNING *`,
      [name, subdomain, settings]
    )
    const clubId = club.id

    // 2. Courts
    for (let i = 1; i <= numCourts; i++) {
      await client.query(`INSERT INTO courts (name, club_id) VALUES ($1, $2)`, [`Court ${i}`, clubId])
    }

    // 3. Schedule — per-day hours
    for (const [day, cfg] of Object.entries(scheduleData)) {
      if (!cfg?.open) continue
      await client.query(
        `INSERT INTO schedule (day, label, start_time, end_time, is_active, club_id)
         VALUES ($1, $2, $3, $4, TRUE, $5)`,
        [day, DAY_LABELS[day] || day, cfg.from || '09:00', cfg.to || '22:00', clubId]
      )
    }

    // 4. Walk-in user
    await client.query(
      `INSERT INTO users (name, email, password_hash, role, is_walkin, club_id)
       VALUES ($1, $2, 'walkin', 'member', TRUE, $3)`,
      [`${name} Walk-in`, `walkin@${subdomain}.internal`, clubId]
    )

    // 5. Coaching prices
    await client.query(
      `INSERT INTO coaching_prices (session_type, price, club_id) VALUES ('solo',70,$1),('group',50,$1)`,
      [clubId]
    )

    // 6. Promote the requesting user to admin of this club
    await client.query(
      `UPDATE users SET role='admin', club_id=$1 WHERE id=$2`,
      [clubId, req.user.id]
    )

    // 7. Handle logo upload
    if (req.file) {
      const ext     = path.extname(req.file.originalname) || '.png'
      const dest    = path.join('uploads', 'logos', `club-${clubId}${ext}`)
      fs.renameSync(req.file.path, dest)
      const logoUrl = `/uploads/logos/club-${clubId}${ext}`
      await client.query(
        `UPDATE clubs SET settings = jsonb_set(settings, '{theme,logoUrl}', $1) WHERE id=$2`,
        [JSON.stringify(logoUrl), clubId]
      )
    }

    await client.query('COMMIT')
    res.status(201).json({ club: { id: clubId, name, subdomain } })
  } catch (err) {
    await client.query('ROLLBACK')
    if (req.file) fs.unlink(req.file.path, () => {})
    console.error('[clubs/register]', err.message)
    if (err.code === '23505')
      return res.status(409).json({ message: 'That URL is already taken. Please choose another.' })
    res.status(500).json({ message: 'Server error.' })
  } finally {
    client.release()
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
    bustClubCache(req.club.subdomain)
    res.json({ logoUrl })
  } catch (err) {
    if (req.file) fs.unlink(req.file.path, () => {})
    console.error('[clubs/logo]', err.message)
    res.status(500).json({ message: 'Server error.' })
  }
})

module.exports = router
