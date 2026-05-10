const router = require('express').Router()
const pool   = require('../db')
const { requireAuth, requireAdmin } = require('../middleware/auth')

// GET /api/articles?type=competition|news|achievement&limit=20&offset=0
router.get('/', async (req, res) => {
  const clubId = req.club?.id ?? req.user?.club_id ?? null
  const { type, limit = 20, offset = 0 } = req.query
  try {
    const conditions = ['club_id=$1']
    const params = [clubId]
    if (type) { conditions.push(`type=$${params.length + 1}`); params.push(type) }
    const { rows } = await pool.query(
      `SELECT id, type, title, subtitle, body, image_data, image_type,
              COALESCE(gallery_images, '[]'::jsonb) AS gallery_images,
              is_pinned, published_at, created_by
       FROM club_articles
       WHERE ${conditions.join(' AND ')}
       ORDER BY is_pinned DESC, published_at DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    )
    res.json({ articles: rows })
  } catch (e) {
    console.error(e)
    res.status(500).json({ message: 'Server error.' })
  }
})

// GET /api/articles/:id
router.get('/:id', async (req, res) => {
  const clubId = req.club?.id ?? req.user?.club_id ?? null
  try {
    const { rows: [article] } = await pool.query(
      `SELECT a.*, u.name AS author_name
       FROM club_articles a LEFT JOIN users u ON u.id = a.created_by
       WHERE a.id=$1 AND a.club_id=$2`,
      [req.params.id, clubId]
    )
    if (!article) return res.status(404).json({ message: 'Not found.' })
    res.json({ article })
  } catch (e) {
    res.status(500).json({ message: 'Server error.' })
  }
})

// POST /api/articles  (admin)
router.post('/', requireAuth, requireAdmin, async (req, res) => {
  const clubId = req.club?.id ?? req.user?.club_id ?? null
  const { type, title, subtitle, body, image_data, image_type, gallery_images, is_pinned, published_at } = req.body
  if (!type || !title) return res.status(400).json({ message: 'type and title are required.' })
  if (!['competition','news','achievement'].includes(type))
    return res.status(400).json({ message: 'Invalid type.' })
  if (image_data && image_data.length > 5_000_000)
    return res.status(400).json({ message: 'Cover image too large (max ~4 MB).' })
  const gallery = Array.isArray(gallery_images) ? gallery_images.slice(0, 5) : []
  try {
    const { rows: [article] } = await pool.query(
      `INSERT INTO club_articles (type, title, subtitle, body, image_data, image_type, gallery_images, is_pinned, published_at, created_by, club_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [type, title, subtitle||null, body||null, image_data||null, image_type||null,
       JSON.stringify(gallery), is_pinned??false, published_at||new Date(), req.user.id, clubId]
    )
    res.json({ article })
  } catch (e) {
    console.error(e)
    res.status(500).json({ message: 'Server error.' })
  }
})

// PUT /api/articles/:id  (admin)
router.put('/:id', requireAuth, requireAdmin, async (req, res) => {
  const clubId = req.club?.id ?? req.user?.club_id ?? null
  const { type, title, subtitle, body, image_data, image_type, gallery_images, is_pinned, published_at } = req.body
  if (type && !['competition','news','achievement'].includes(type))
    return res.status(400).json({ message: 'Invalid type.' })
  if (image_data && image_data.length > 5_000_000)
    return res.status(400).json({ message: 'Cover image too large (max ~4 MB).' })
  const gallery = Array.isArray(gallery_images) ? gallery_images.slice(0, 5) : null
  try {
    const { rows: [article] } = await pool.query(
      `UPDATE club_articles SET
         type=COALESCE($1,type), title=COALESCE($2,title), subtitle=$3, body=$4,
         image_data=COALESCE($5,image_data), image_type=COALESCE($6,image_type),
         gallery_images=COALESCE($7,gallery_images),
         is_pinned=COALESCE($8,is_pinned), published_at=COALESCE($9,published_at)
       WHERE id=$10 AND club_id=$11 RETURNING *`,
      [type||null, title||null, subtitle??null, body??null,
       image_data||null, image_type||null,
       gallery !== null ? JSON.stringify(gallery) : null,
       is_pinned??null, published_at||null, req.params.id, clubId]
    )
    if (!article) return res.status(404).json({ message: 'Not found.' })
    res.json({ article })
  } catch (e) {
    console.error(e)
    res.status(500).json({ message: 'Server error.' })
  }
})

// DELETE /api/articles/:id  (admin)
router.delete('/:id', requireAuth, requireAdmin, async (req, res) => {
  const clubId = req.club?.id ?? req.user?.club_id ?? null
  try {
    const { rows } = await pool.query(
      `DELETE FROM club_articles WHERE id=$1 AND club_id=$2 RETURNING id`,
      [req.params.id, clubId]
    )
    if (!rows[0]) return res.status(404).json({ message: 'Not found.' })
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ message: 'Server error.' })
  }
})

module.exports = router
