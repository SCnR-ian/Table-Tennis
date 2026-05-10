const router = require('express').Router()
const pool   = require('../db')
const multer = require('multer')
const { requireAuth, requireAdmin } = require('../middleware/auth')

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true)
    else cb(new Error('Only image files are allowed.'))
  },
})

// GET /api/pages/content — all page content sections (public)
router.get('/content', async (req, res) => {
  try {
    const clubId = req.club?.id ?? req.user?.club_id ?? null
    const { rows } = await pool.query(
      'SELECT id, content FROM page_content WHERE club_id=$1',
      [clubId]
    )
    const result = Object.fromEntries(rows.map(r => [r.id, r.content]))
    res.json({ content: result })
  } catch { res.status(500).json({ message: 'Server error.' }) }
})

// PUT /api/pages/content/:id — upsert a section's content (admin)
router.put('/content/:id', requireAuth, requireAdmin, async (req, res) => {
  const { content } = req.body
  if (!content || typeof content !== 'object')
    return res.status(400).json({ message: 'content object is required.' })
  try {
    const clubId = req.club?.id ?? req.user?.club_id ?? null
    await pool.query(
      `INSERT INTO page_content (id, club_id, content, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (club_id, id) DO UPDATE SET content=$3, updated_at=NOW()`,
      [req.params.id, clubId, JSON.stringify(content)]
    )
    res.json({ ok: true })
  } catch { res.status(500).json({ message: 'Server error.' }) }
})

// GET /api/pages/image-ids?prefix=... — list populated image IDs (public)
router.get('/image-ids', async (req, res) => {
  try {
    const clubId = req.club?.id ?? req.user?.club_id ?? null
    const { prefix } = req.query
    let q = 'SELECT id FROM page_images WHERE image_data IS NOT NULL AND club_id=$1'
    const params = [clubId]
    if (prefix) { q += " AND id LIKE $2 ESCAPE '\\'"; params.push(`${prefix.replace(/[_%]/g, c => '\\' + c)}%`) }
    const { rows } = await pool.query(q, params)
    res.json({ ids: rows.map(r => r.id) })
  } catch { res.status(500).json({ message: 'Server error.' }) }
})

// GET /api/pages/images/:id — serve a page image (public)
router.get('/images/:id', async (req, res) => {
  try {
    const clubId = req.club?.id ?? req.user?.club_id ?? null
    const { rows } = await pool.query(
      'SELECT image_data, image_filename FROM page_images WHERE id=$1 AND club_id=$2',
      [req.params.id, clubId]
    )
    if (!rows[0]?.image_data) return res.status(404).json({ message: 'No image.' })
    const buf  = Buffer.from(rows[0].image_data, 'base64')
    const ext  = (rows[0].image_filename || '').split('.').pop().toLowerCase()
    const mime = ext === 'png' ? 'image/png' : ext === 'gif' ? 'image/gif' : 'image/jpeg'
    res.setHeader('Content-Type', mime)
    res.setHeader('Cache-Control', 'public, max-age=3600')
    res.send(buf)
  } catch { res.status(500).json({ message: 'Server error.' }) }
})

// POST /api/pages/images/:id — upload a page image (admin)
router.post('/images/:id', requireAuth, requireAdmin, upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ message: 'No image file provided.' })
  try {
    const clubId = req.club?.id ?? req.user?.club_id ?? null
    const imageData = req.file.buffer.toString('base64')
    await pool.query(
      `INSERT INTO page_images (id, club_id, image_data, image_filename, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (club_id, id) DO UPDATE SET image_data=$3, image_filename=$4, updated_at=NOW()`,
      [req.params.id, clubId, imageData, req.file.originalname]
    )
    res.json({ ok: true })
  } catch { res.status(500).json({ message: 'Server error.' }) }
})

// DELETE /api/pages/images/:id — remove a page image (admin)
router.delete('/images/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const clubId = req.club?.id ?? req.user?.club_id ?? null
    await pool.query(
      'DELETE FROM page_images WHERE id=$1 AND club_id=$2',
      [req.params.id, clubId]
    )
    res.json({ ok: true })
  } catch { res.status(500).json({ message: 'Server error.' }) }
})

module.exports = router
