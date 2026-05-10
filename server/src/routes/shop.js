const router  = require('express').Router()
const pool    = require('../db')
const multer  = require('multer')
const path    = require('path')
const fs      = require('fs')
const { requireAuth } = require('../middleware/auth')

const UPLOAD_DIR = path.join(__dirname, '../../uploads/products')
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true })

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename:    (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase()
    cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`)
  },
})
const upload = multer({ storage, limits: { fileSize: 5 * 1024 * 1024 } })

const CATEGORIES = ['rubbers', 'blades', 'care', 'shoes', 'balls', 'rackets']

// SQL fragment: aggregate images per product
const IMAGE_AGG = `
  COALESCE(
    json_agg(
      json_build_object('id', pi.id, 'url', '/uploads/products/' || pi.filename, 'sort_order', pi.sort_order)
      ORDER BY pi.sort_order ASC, pi.id ASC
    ) FILTER (WHERE pi.id IS NOT NULL),
    '[]'::json
  ) AS images
`

// GET /api/shop/products?category=rubbers  — public
router.get('/products', async (req, res) => {
  const clubId = req.club?.id ?? req.user?.club_id ?? null
  const { category } = req.query
  try {
    const catFilter = category && CATEGORIES.includes(category) ? `AND p.category=$2` : ''
    const params = category && CATEGORIES.includes(category) ? [clubId, category] : [clubId]
    const { rows } = await pool.query(
      `SELECT p.id, p.name, p.category, p.price, p.description, p.sort_order,
              p.code, p.product_type, p.reaction_property, p.vibration_property,
              p.structure, p.thickness, p.head_size,
              ${IMAGE_AGG}
       FROM products p
       LEFT JOIN product_images pi ON pi.product_id = p.id
       WHERE p.club_id=$1 AND p.is_active=TRUE ${catFilter}
       GROUP BY p.id
       ORDER BY p.sort_order ASC, p.id ASC`,
      params
    )
    res.json({ products: rows })
  } catch (e) { console.error(e); res.status(500).json({ message: 'Server error.' }) }
})

// GET /api/shop/products/admin — admin: all products including inactive
// NOTE: must be before /products/:id or Express matches 'admin' as :id
router.get('/products/admin', requireAuth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ message: 'Admin only.' })
  const clubId = req.club?.id ?? req.user?.club_id ?? null
  try {
    const { rows } = await pool.query(
      `SELECT p.id, p.name, p.category, p.price, p.description, p.sort_order, p.is_active,
              p.code, p.product_type, p.reaction_property, p.vibration_property,
              p.structure, p.thickness, p.head_size,
              ${IMAGE_AGG}
       FROM products p
       LEFT JOIN product_images pi ON pi.product_id = p.id
       WHERE p.club_id=$1
       GROUP BY p.id
       ORDER BY p.sort_order ASC, p.id ASC`,
      [clubId]
    )
    res.json({ products: rows })
  } catch (e) { console.error(e); res.status(500).json({ message: 'Server error.' }) }
})

// GET /api/shop/products/:id — public, single product with all images
router.get('/products/:id', async (req, res) => {
  const clubId = req.club?.id ?? req.user?.club_id ?? null
  try {
    const { rows: [p] } = await pool.query(
      `SELECT p.id, p.name, p.category, p.price, p.description, p.sort_order,
              p.code, p.product_type, p.reaction_property, p.vibration_property,
              p.structure, p.thickness, p.head_size,
              ${IMAGE_AGG}
       FROM products p
       LEFT JOIN product_images pi ON pi.product_id = p.id
       WHERE p.id=$1 AND p.club_id=$2 AND p.is_active=TRUE
       GROUP BY p.id`,
      [req.params.id, clubId]
    )
    if (!p) return res.status(404).json({ message: 'Not found.' })
    res.json({ product: p })
  } catch (e) { console.error(e); res.status(500).json({ message: 'Server error.' }) }
})

// POST /api/shop/products (admin)
router.post('/products', requireAuth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ message: 'Admin only.' })
  const clubId = req.club?.id ?? req.user?.club_id ?? null
  const { name, category, price, description, sort_order, stock,
          code, product_type, reaction_property, vibration_property,
          structure, thickness, head_size } = req.body
  if (!name || !category) return res.status(400).json({ message: 'name and category required.' })
  if (!CATEGORIES.includes(category)) return res.status(400).json({ message: 'Invalid category.' })
  try {
    const { rows: [p] } = await pool.query(
      `INSERT INTO products
         (name, category, price, description, sort_order, stock, club_id,
          code, product_type, reaction_property, vibration_property, structure, thickness, head_size)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       RETURNING *`,
      [name, category, price ?? null, description ?? null, sort_order ?? 0, stock ?? null, clubId,
       code ?? null, product_type ?? null, reaction_property ?? null, vibration_property ?? null,
       structure ?? null, thickness ?? null, head_size ?? null]
    )
    res.status(201).json({ product: { ...p, images: [] } })
  } catch (e) { console.error(e); res.status(500).json({ message: 'Server error.' }) }
})

// PATCH /api/shop/products/:id (admin)
router.patch('/products/:id', requireAuth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ message: 'Admin only.' })
  const clubId = req.club?.id ?? req.user?.club_id ?? null
  const { name, category, price, description, sort_order, is_active, stock,
          code, product_type, reaction_property, vibration_property,
          structure, thickness, head_size } = req.body
  try {
    const { rows: [p] } = await pool.query(
      `UPDATE products SET
         name=$1, category=$2, price=$3, description=$4, sort_order=$5, is_active=$6, stock=$7,
         code=$8, product_type=$9, reaction_property=$10, vibration_property=$11,
         structure=$12, thickness=$13, head_size=$14
       WHERE id=$15 AND club_id=$16
       RETURNING *`,
      [name, category, price ?? null, description ?? null, sort_order ?? 0, is_active ?? true, stock ?? null,
       code ?? null, product_type ?? null, reaction_property ?? null, vibration_property ?? null,
       structure ?? null, thickness ?? null, head_size ?? null,
       req.params.id, clubId]
    )
    if (!p) return res.status(404).json({ message: 'Not found.' })
    // Return with current images
    const { rows: imgs } = await pool.query(
      `SELECT id, '/uploads/products/' || filename AS url, sort_order
       FROM product_images WHERE product_id=$1 ORDER BY sort_order, id`, [p.id]
    )
    res.json({ product: { ...p, images: imgs } })
  } catch (e) { console.error(e); res.status(500).json({ message: 'Server error.' }) }
})

// DELETE /api/shop/products/:id (admin)
router.delete('/products/:id', requireAuth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ message: 'Admin only.' })
  const clubId = req.club?.id ?? req.user?.club_id ?? null
  try {
    // delete image files
    const { rows: imgs } = await pool.query(
      'SELECT filename FROM product_images WHERE product_id=$1', [req.params.id]
    )
    for (const img of imgs) {
      fs.unlink(path.join(UPLOAD_DIR, img.filename), () => {})
    }
    // also check legacy image_url
    const { rows: [p] } = await pool.query(
      'SELECT image_url FROM products WHERE id=$1 AND club_id=$2', [req.params.id, clubId]
    )
    if (p?.image_url) {
      fs.unlink(path.join(UPLOAD_DIR, path.basename(p.image_url)), () => {})
    }
    await pool.query('DELETE FROM products WHERE id=$1 AND club_id=$2', [req.params.id, clubId])
    res.json({ message: 'Deleted.' })
  } catch (e) { console.error(e); res.status(500).json({ message: 'Server error.' }) }
})

// POST /api/shop/products/:id/images (admin) — upload one image (max 6 per product)
router.post('/products/:id/images', requireAuth, upload.single('image'), async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ message: 'Admin only.' })
  const clubId = req.club?.id ?? req.user?.club_id ?? null
  if (!req.file) return res.status(400).json({ message: 'No file uploaded.' })
  try {
    // Verify product belongs to this club
    const { rows: [prod] } = await pool.query(
      'SELECT id FROM products WHERE id=$1 AND club_id=$2', [req.params.id, clubId]
    )
    if (!prod) { fs.unlink(req.file.path, () => {}); return res.status(404).json({ message: 'Product not found.' }) }

    // Count existing images
    const { rows: [cnt] } = await pool.query(
      'SELECT COUNT(*)::int AS n FROM product_images WHERE product_id=$1', [req.params.id]
    )
    if (cnt.n >= 6) {
      fs.unlink(req.file.path, () => {})
      return res.status(400).json({ message: 'Maximum 6 images per product.' })
    }

    const { rows: [img] } = await pool.query(
      `INSERT INTO product_images (product_id, filename, sort_order, club_id)
       VALUES ($1,$2,$3,$4) RETURNING id, '/uploads/products/' || filename AS url, sort_order`,
      [req.params.id, req.file.filename, cnt.n, clubId]
    )
    res.status(201).json({ image: img })
  } catch (e) { console.error(e); res.status(500).json({ message: 'Server error.' }) }
})

// DELETE /api/shop/products/:id/images/:imageId (admin)
router.delete('/products/:id/images/:imageId', requireAuth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ message: 'Admin only.' })
  const clubId = req.club?.id ?? req.user?.club_id ?? null
  try {
    const { rows: [img] } = await pool.query(
      `DELETE FROM product_images
       WHERE id=$1 AND product_id=$2
         AND product_id IN (SELECT id FROM products WHERE club_id=$3)
       RETURNING filename`,
      [req.params.imageId, req.params.id, clubId]
    )
    if (!img) return res.status(404).json({ message: 'Not found.' })
    fs.unlink(path.join(UPLOAD_DIR, img.filename), () => {})
    res.json({ message: 'Deleted.' })
  } catch (e) { console.error(e); res.status(500).json({ message: 'Server error.' }) }
})

// Serve product images (legacy single image_url too)
router.get('/images/:filename', (req, res) => {
  res.sendFile(path.join(UPLOAD_DIR, req.params.filename))
})

// ── Orders ────────────────────────────────────────────────────────────────────

// POST /api/shop/orders  — called after Stripe payment succeeds
// body: { intentId, delivery_type, address }
router.post('/orders', requireAuth, async (req, res) => {
  const { intentId, delivery_type, address } = req.body
  if (!intentId) return res.status(400).json({ message: 'intentId is required.' })
  const clubId = req.club?.id ?? req.user?.club_id ?? null
  const client = await pool.connect()
  try {
    // Prevent double-save
    const { rows: [existing] } = await client.query(
      'SELECT id FROM shop_orders WHERE payment_intent_id=$1', [intentId]
    )
    if (existing) return res.json({ order_id: existing.id })

    // Retrieve intent from Stripe to verify payment and recover items
    const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY)
    const intent = await stripe.paymentIntents.retrieve(intentId)
    if (intent.status !== 'succeeded')
      return res.status(402).json({ message: 'Payment not completed.' })
    if (String(intent.metadata.user_id) !== String(req.user.id))
      return res.status(403).json({ message: 'Not your payment.' })
    if (Number(intent.metadata.club_id) !== clubId)
      return res.status(403).json({ message: 'Club mismatch.' })

    const items = JSON.parse(intent.metadata.items || '[]')
    const totalCents = intent.amount

    await client.query('BEGIN')
    const { rows: [order] } = await client.query(
      `INSERT INTO shop_orders (user_id, club_id, payment_intent_id, status, delivery_type, address, total_cents)
       VALUES ($1,$2,$3,'paid',$4,$5,$6) RETURNING id`,
      [req.user.id, clubId, intentId, delivery_type || 'collect', address ? JSON.stringify(address) : null, totalCents]
    )
    for (const item of items) {
      await client.query(
        `INSERT INTO shop_order_items (order_id, product_id, name, qty, price_cents)
         VALUES ($1,$2,$3,$4,$5)`,
        [order.id, item.product_id, item.name, item.qty, item.price_cents]
      )
      // Decrement stock if tracked
      await client.query(
        `UPDATE products SET stock = stock - $1
         WHERE id=$2 AND stock IS NOT NULL AND club_id=$3`,
        [item.qty, item.product_id, clubId]
      )
    }
    await client.query('COMMIT')
    res.status(201).json({ order_id: order.id })
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    console.error('[shop/orders]', err.message)
    res.status(500).json({ message: 'Failed to save order.' })
  } finally {
    client.release()
  }
})

// GET /api/shop/orders  — admin: all orders; member: own orders
router.get('/orders', requireAuth, async (req, res) => {
  const clubId  = req.club?.id ?? req.user?.club_id ?? null
  const isAdmin = req.user.role === 'admin'
  try {
    const { rows } = await pool.query(
      `SELECT
         o.id, o.status, o.delivery_type, o.total_cents, o.created_at,
         o.address,
         u.name AS user_name, u.email AS user_email,
         json_agg(
           json_build_object('name', oi.name, 'qty', oi.qty, 'price_cents', oi.price_cents)
           ORDER BY oi.id
         ) AS items
       FROM shop_orders o
       JOIN users u ON u.id = o.user_id
       JOIN shop_order_items oi ON oi.order_id = o.id
       WHERE o.club_id=$1 ${isAdmin ? '' : 'AND o.user_id=$2'}
       GROUP BY o.id, u.name, u.email
       ORDER BY o.created_at DESC`,
      isAdmin ? [clubId] : [clubId, req.user.id]
    )
    res.json({ orders: rows })
  } catch (err) {
    console.error('[shop/orders GET]', err.message)
    res.status(500).json({ message: 'Server error.' })
  }
})

// PATCH /api/shop/orders/:id  — admin: update status
router.patch('/orders/:id', requireAuth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ message: 'Admin only.' })
  const { status } = req.body
  const clubId = req.club?.id ?? req.user?.club_id ?? null
  const VALID = ['pending','paid','processing','shipped','completed','cancelled']
  if (!VALID.includes(status)) return res.status(400).json({ message: 'Invalid status.' })
  try {
    const { rows: [row] } = await pool.query(
      'UPDATE shop_orders SET status=$1 WHERE id=$2 AND club_id=$3 RETURNING id',
      [status, req.params.id, clubId]
    )
    if (!row) return res.status(404).json({ message: 'Not found.' })
    res.json({ message: 'Updated.' })
  } catch { res.status(500).json({ message: 'Server error.' }) }
})

module.exports = router
