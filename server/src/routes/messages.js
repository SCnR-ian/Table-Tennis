const router = require('express').Router()
const pool   = require('../db')
const { requireAuth } = require('../middleware/auth')

// ── Helpers ──────────────────────────────────────────────────────────────────

// Fetch reaction summaries for a set of message ids
async function getReactions(messageIds, viewerId) {
  if (!messageIds.length) return {}
  const { rows } = await pool.query(`
    SELECT message_id, emoji,
           COUNT(*)::int AS count,
           bool_or(user_id = $2) AS reacted_by_me
    FROM message_reactions
    WHERE message_id = ANY($1)
    GROUP BY message_id, emoji
  `, [messageIds, viewerId])
  const map = {}
  for (const r of rows) {
    if (!map[r.message_id]) map[r.message_id] = []
    map[r.message_id].push({ emoji: r.emoji, count: r.count, reacted_by_me: r.reacted_by_me })
  }
  return map
}

// ── Endpoints ─────────────────────────────────────────────────────────────────

// GET /api/messages/admins  — any authenticated user can fetch the club's admin list
router.get('/admins', requireAuth, async (req, res) => {
  const clubId = req.club?.id ?? req.user?.club_id ?? null
  try {
    const { rows } = await pool.query(
      `SELECT id, name FROM users WHERE role='admin' AND club_id=$1 ORDER BY name`,
      [clubId]
    )
    res.json({ admins: rows })
  } catch { res.status(500).json({ message: 'Server error.' }) }
})

// GET /api/messages/unread-count
router.get('/unread-count', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT COUNT(*) AS count FROM messages m
      WHERE (m.recipient_id = $1 OR m.recipient_id IS NULL)
        AND m.sender_id != $1
        AND m.deleted_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM message_reads mr
          WHERE mr.message_id = m.id AND mr.user_id = $1
        )
    `, [req.user.id])
    res.json({ count: Number(rows[0].count) })
  } catch { res.status(500).json({ message: 'Server error.' }) }
})

// GET /api/messages/inbox
router.get('/inbox', requireAuth, async (req, res) => {
  const uid = req.user.id
  try {
    const { rows: announcements } = await pool.query(`
      SELECT m.id, m.body, m.created_at, m.recipient_id, m.deleted_at, m.edited_at,
             u.name AS sender_name, u.id AS sender_id,
             EXISTS(
               SELECT 1 FROM message_reads mr WHERE mr.message_id = m.id AND mr.user_id = $1
             ) AS is_read
      FROM messages m
      JOIN users u ON u.id = m.sender_id
      WHERE m.recipient_id IS NULL
        AND m.deleted_at IS NULL
      ORDER BY m.created_at DESC
    `, [uid])

    const { rows: threads } = await pool.query(`
      SELECT * FROM (
        SELECT DISTINCT ON (other_user)
          CASE WHEN m.sender_id = $1 THEN m.recipient_id ELSE m.sender_id END AS other_user,
          m.id, m.body, m.created_at, m.sender_id, m.recipient_id, m.deleted_at,
          u.name AS other_name,
          u.role AS other_role,
          EXISTS(
            SELECT 1 FROM message_reads mr WHERE mr.message_id = m.id AND mr.user_id = $1
          ) AS is_read
        FROM messages m
        JOIN users u ON u.id = CASE WHEN m.sender_id = $1 THEN m.recipient_id ELSE m.sender_id END
        WHERE m.recipient_id IS NOT NULL
          AND (m.sender_id = $1 OR m.recipient_id = $1)
          AND NOT EXISTS (
            SELECT 1 FROM message_thread_hidden h
            WHERE h.user_id = $1
              AND h.other_user_id = CASE WHEN m.sender_id = $1 THEN m.recipient_id ELSE m.sender_id END
          )
        ORDER BY other_user, m.created_at DESC
      ) t
      ORDER BY t.created_at DESC
    `, [uid])

    res.json({ announcements, threads })
  } catch (err) {
    console.error(err)
    res.status(500).json({ message: 'Server error.' })
  }
})

// GET /api/messages/thread/:userId
router.get('/thread/:userId', requireAuth, async (req, res) => {
  const uid   = req.user.id
  const other = Number(req.params.userId)
  try {
    const { rows } = await pool.query(`
      SELECT m.id, m.body, m.created_at, m.edited_at, m.deleted_at,
             m.sender_id, m.recipient_id,
             m.attachment_data, m.attachment_type, m.attachment_name,
             m.metadata,
             u.name AS sender_name,
             EXISTS(
               SELECT 1 FROM message_reads mr WHERE mr.message_id = m.id AND mr.user_id = $1
             ) AS is_read,
             -- read by recipient (for messages I sent)
             CASE WHEN m.sender_id = $1 THEN
               EXISTS(SELECT 1 FROM message_reads mr WHERE mr.message_id = m.id AND mr.user_id = $2)
             ELSE FALSE END AS read_by_recipient,
             slr.status AS leave_request_status,
             slr.expires_at AS leave_request_expires_at,
             clr.status AS coach_leave_request_status,
             ccr_agg.coverage_statuses AS coverage_statuses
      FROM messages m
      JOIN users u ON u.id = m.sender_id
      LEFT JOIN session_leave_requests slr
        ON m.metadata IS NOT NULL
        AND m.metadata->>'type' IN ('leave_request','slot_options')
        AND (m.metadata->>'request_id')::int = slr.id
      LEFT JOIN coach_leave_requests clr
        ON m.metadata IS NOT NULL
        AND m.metadata->>'type' = 'coach_leave_request'
        AND (m.metadata->>'request_id')::int = clr.id
      LEFT JOIN (
        SELECT leave_req_id,
          JSON_AGG(JSON_BUILD_OBJECT('id', id, 'session_id', session_id, 'status', status, 'sub_coach_id', sub_coach_id) ORDER BY id) AS coverage_statuses
        FROM coach_coverage_requests
        GROUP BY leave_req_id
      ) ccr_agg
        ON m.metadata IS NOT NULL
        AND m.metadata->>'type' = 'coverage_request'
        AND (m.metadata->>'leave_req_id')::int = ccr_agg.leave_req_id
      WHERE (m.sender_id = $1 AND m.recipient_id = $2)
         OR (m.sender_id = $2 AND m.recipient_id = $1)
      ORDER BY m.created_at ASC
    `, [uid, other])

    // Mark all unread incoming messages as read
    await pool.query(`
      INSERT INTO message_reads (message_id, user_id)
      SELECT m.id, $1 FROM messages m
      WHERE (m.sender_id = $2 AND m.recipient_id = $1)
        AND NOT EXISTS (
          SELECT 1 FROM message_reads mr WHERE mr.message_id = m.id AND mr.user_id = $1
        )
      ON CONFLICT DO NOTHING
    `, [uid, other])

    const messageIds = rows.map(r => r.id)
    const reactionsMap = await getReactions(messageIds, uid)
    const messages = rows.map(r => ({
      ...r,
      deleted: !!r.deleted_at,
      body: r.deleted_at ? null : r.body,
      reactions: reactionsMap[r.id] ?? [],
      metadata: r.metadata ?? null,
      leave_request_status: r.leave_request_status ?? null,
      leave_request_expires_at: r.leave_request_expires_at ?? null,
      coach_leave_request_status: r.coach_leave_request_status ?? null,
      coverage_statuses: r.coverage_statuses ?? null,
    }))

    res.json({ messages })
  } catch (err) {
    console.error(err)
    res.status(500).json({ message: 'Server error.' })
  }
})

// POST /api/messages
router.post('/', requireAuth, async (req, res) => {
  const { recipient_id, body, attachment_data, attachment_type, attachment_name } = req.body
  if (!body?.trim() && !attachment_data)
    return res.status(400).json({ message: 'Message body or attachment is required.' })

  if (!recipient_id && req.user.role !== 'admin')
    return res.status(403).json({ message: 'Only admins can send announcements.' })

  if (recipient_id && req.user.role !== 'admin') {
    const clubId = req.club?.id ?? req.user?.club_id ?? null
    const { rows } = await pool.query('SELECT role FROM users WHERE id=$1 AND club_id=$2', [recipient_id, clubId])
    if (!rows[0] || rows[0].role !== 'admin')
      return res.status(403).json({ message: 'Members can only message admins.' })
  }

  if (attachment_data && attachment_data.length > 2_700_000)
    return res.status(400).json({ message: 'Image too large (max 2 MB).' })

  try {
    const { rows } = await pool.query(
      `INSERT INTO messages (sender_id, recipient_id, body, attachment_data, attachment_type, attachment_name)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [req.user.id, recipient_id ?? null, body?.trim() ?? null,
       attachment_data ?? null, attachment_type ?? null, attachment_name ?? null]
    )
    await pool.query(
      'INSERT INTO message_reads (message_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [rows[0].id, req.user.id]
    )
    // Un-hide thread for both parties when a new message is sent
    if (recipient_id) {
      await pool.query(
        `DELETE FROM message_thread_hidden
         WHERE (user_id=$1 AND other_user_id=$2) OR (user_id=$2 AND other_user_id=$1)`,
        [req.user.id, recipient_id]
      )
    }
    res.json({ message: rows[0] })
  } catch (err) {
    console.error(err)
    res.status(500).json({ message: 'Server error.' })
  }
})

// PUT /api/messages/:id  — edit own message
router.put('/:id', requireAuth, async (req, res) => {
  const { body } = req.body
  if (!body?.trim()) return res.status(400).json({ message: 'Body is required.' })
  try {
    const { rows } = await pool.query(
      `UPDATE messages SET body=$1, edited_at=NOW()
       WHERE id=$2 AND sender_id=$3 AND deleted_at IS NULL RETURNING *`,
      [body.trim(), req.params.id, req.user.id]
    )
    if (!rows[0]) return res.status(404).json({ message: 'Message not found.' })
    res.json({ message: rows[0] })
  } catch { res.status(500).json({ message: 'Server error.' }) }
})

// DELETE /api/messages/thread/:userId  — hide conversation for current user only
router.delete('/thread/:userId', requireAuth, async (req, res) => {
  const uid   = req.user.id
  const other = Number(req.params.userId)
  try {
    await pool.query(
      `INSERT INTO message_thread_hidden (user_id, other_user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [uid, other]
    )
    res.json({ ok: true })
  } catch { res.status(500).json({ message: 'Server error.' }) }
})

// DELETE /api/messages/:id  — soft delete own message
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `UPDATE messages SET deleted_at=NOW()
       WHERE id=$1 AND sender_id=$2 AND deleted_at IS NULL RETURNING id`,
      [req.params.id, req.user.id]
    )
    if (!rows[0]) return res.status(404).json({ message: 'Message not found.' })
    res.json({ ok: true })
  } catch { res.status(500).json({ message: 'Server error.' }) }
})

// POST /api/messages/:id/react  — toggle emoji reaction
router.post('/:id/react', requireAuth, async (req, res) => {
  const { emoji } = req.body
  if (!emoji) return res.status(400).json({ message: 'emoji is required.' })
  try {
    // Check if reaction already exists
    const { rows: existing } = await pool.query(
      `SELECT 1 FROM message_reactions WHERE message_id=$1 AND user_id=$2 AND emoji=$3`,
      [req.params.id, req.user.id, emoji]
    )
    if (existing.length) {
      await pool.query(
        `DELETE FROM message_reactions WHERE message_id=$1 AND user_id=$2 AND emoji=$3`,
        [req.params.id, req.user.id, emoji]
      )
    } else {
      await pool.query(
        `INSERT INTO message_reactions (message_id, user_id, emoji) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [req.params.id, req.user.id, emoji]
      )
    }
    const reactionsMap = await getReactions([Number(req.params.id)], req.user.id)
    res.json({ reactions: reactionsMap[Number(req.params.id)] ?? [] })
  } catch { res.status(500).json({ message: 'Server error.' }) }
})

// POST /api/messages/:id/read
router.post('/:id/read', requireAuth, async (req, res) => {
  try {
    await pool.query(
      'INSERT INTO message_reads (message_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [req.params.id, req.user.id]
    )
    res.json({ ok: true })
  } catch { res.status(500).json({ message: 'Server error.' }) }
})

module.exports = router
