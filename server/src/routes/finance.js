const router = require('express').Router()
const pool   = require('../db')
const { requireAuth, requireAdmin } = require('../middleware/auth')

// ── Cash transactions ─────────────────────────────────────────────────────────

router.post('/cash', requireAuth, requireAdmin, async (req, res) => {
  const clubId = req.club?.id ?? req.user?.club_id ?? null
  const { amount, category, description, member_id, type } = req.body
  if (!amount || isNaN(amount) || Number(amount) <= 0)
    return res.status(400).json({ message: 'Valid amount required.' })
  const incomeCategories  = ['booking', 'social', 'coaching', 'shop', 'other']
  const expenseCategories = ['salary', 'rent', 'supplies', 'other']
  const txType = type === 'expense' ? 'expense' : 'income'
  const validCategories = txType === 'expense' ? expenseCategories : incomeCategories
  if (category && !validCategories.includes(category))
    return res.status(400).json({ message: 'Invalid category.' })
  try {
    const { rows: [row] } = await pool.query(
      `INSERT INTO cash_transactions (club_id, amount, category, description, member_id, recorded_by, type)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [clubId, Number(amount), category || 'other', description || null, member_id || null, req.user.id, txType]
    )
    res.json({ transaction: row })
  } catch (e) { res.status(500).json({ message: 'Server error.' }) }
})

router.get('/cash', requireAuth, requireAdmin, async (req, res) => {
  const clubId = req.club?.id ?? req.user?.club_id ?? null
  const { from, to } = req.query
  try {
    const { rows } = await pool.query(
      `SELECT ct.*, u.name AS member_name, u.email AS member_email,
              r.name AS recorded_by_name
       FROM cash_transactions ct
       LEFT JOIN users u ON u.id = ct.member_id
       LEFT JOIN users r ON r.id = ct.recorded_by
       WHERE ct.club_id = $1
         AND ($2::date IS NULL OR ct.created_at::date >= $2::date)
         AND ($3::date IS NULL OR ct.created_at::date <= $3::date)
       ORDER BY ct.created_at DESC`,
      [clubId, from || null, to || null]
    )
    res.json({ transactions: rows })
  } catch (e) { res.status(500).json({ message: 'Server error.' }) }
})

router.delete('/cash/:id', requireAuth, requireAdmin, async (req, res) => {
  const clubId = req.club?.id ?? req.user?.club_id ?? null
  try {
    const { rowCount } = await pool.query(
      `DELETE FROM cash_transactions WHERE id=$1 AND club_id=$2`,
      [req.params.id, clubId]
    )
    if (!rowCount) return res.status(404).json({ message: 'Not found.' })
    res.json({ message: 'Deleted.' })
  } catch { res.status(500).json({ message: 'Server error.' }) }
})

// ── Recurring expenses ────────────────────────────────────────────────────────

router.get('/recurring', requireAuth, requireAdmin, async (req, res) => {
  const clubId = req.club?.id ?? req.user?.club_id ?? null
  try {
    const { rows } = await pool.query(
      `SELECT * FROM recurring_expenses WHERE club_id=$1 ORDER BY id`,
      [clubId]
    )
    res.json({ recurring: rows })
  } catch (e) { res.status(500).json({ message: 'Server error.' }) }
})

router.post('/recurring', requireAuth, requireAdmin, async (req, res) => {
  const clubId = req.club?.id ?? req.user?.club_id ?? null
  const { description, amount, category } = req.body
  if (!description?.trim() || !amount || isNaN(amount) || Number(amount) <= 0)
    return res.status(400).json({ message: 'Description and valid amount required.' })
  try {
    const { rows: [row] } = await pool.query(
      `INSERT INTO recurring_expenses (club_id, category, description, amount)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [clubId, category || 'rent', description.trim(), Number(amount)]
    )
    res.json({ recurring: row })
  } catch (e) { res.status(500).json({ message: 'Server error.' }) }
})

router.put('/recurring/:id', requireAuth, requireAdmin, async (req, res) => {
  const clubId = req.club?.id ?? req.user?.club_id ?? null
  const { description, amount, category, is_active } = req.body
  try {
    const { rows: [row] } = await pool.query(
      `UPDATE recurring_expenses
       SET description = COALESCE($3, description),
           amount      = COALESCE($4, amount),
           category    = COALESCE($5, category),
           is_active   = COALESCE($6, is_active)
       WHERE id=$1 AND club_id=$2 RETURNING *`,
      [req.params.id, clubId, description || null, amount ? Number(amount) : null, category || null, is_active ?? null]
    )
    if (!row) return res.status(404).json({ message: 'Not found.' })
    res.json({ recurring: row })
  } catch (e) { res.status(500).json({ message: 'Server error.' }) }
})

router.delete('/recurring/:id', requireAuth, requireAdmin, async (req, res) => {
  const clubId = req.club?.id ?? req.user?.club_id ?? null
  try {
    const { rowCount } = await pool.query(
      `DELETE FROM recurring_expenses WHERE id=$1 AND club_id=$2`,
      [req.params.id, clubId]
    )
    if (!rowCount) return res.status(404).json({ message: 'Not found.' })
    res.json({ message: 'Deleted.' })
  } catch { res.status(500).json({ message: 'Server error.' }) }
})

// ── Coach pay rates ───────────────────────────────────────────────────────────

router.get('/coach-rates', requireAuth, requireAdmin, async (req, res) => {
  const clubId = req.club?.id ?? req.user?.club_id ?? null
  try {
    const { rows } = await pool.query(
      `SELECT id, name, pay_rate_per_session FROM coaches
       WHERE club_id=$1 AND is_active=TRUE ORDER BY name`,
      [clubId]
    )
    res.json({ coaches: rows })
  } catch (e) { res.status(500).json({ message: 'Server error.' }) }
})

router.put('/coach-rates/:id', requireAuth, requireAdmin, async (req, res) => {
  const clubId = req.club?.id ?? req.user?.club_id ?? null
  const { pay_rate_per_session } = req.body
  if (pay_rate_per_session !== null && (isNaN(pay_rate_per_session) || Number(pay_rate_per_session) < 0))
    return res.status(400).json({ message: 'Invalid rate.' })
  try {
    const { rows: [row] } = await pool.query(
      `UPDATE coaches SET pay_rate_per_session=$1 WHERE id=$2 AND club_id=$3 RETURNING id, name, pay_rate_per_session`,
      [pay_rate_per_session === null ? null : Number(pay_rate_per_session), req.params.id, clubId]
    )
    if (!row) return res.status(404).json({ message: 'Not found.' })
    res.json({ coach: row })
  } catch (e) { res.status(500).json({ message: 'Server error.' }) }
})

// ── Unified finance report ────────────────────────────────────────────────────

router.get('/report', requireAuth, requireAdmin, async (req, res) => {
  const clubId = req.club?.id ?? req.user?.club_id ?? null
  const from = req.query.from || new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0, 10)
  const to   = req.query.to   || new Date().toISOString().slice(0, 10)

  try {
    // 1. Online bookings
    const { rows: bookingRows } = await pool.query(
      `SELECT b.date::text AS date, 'booking' AS category, 'online' AS payment_type, 'income' AS type,
              b.amount_paid::float AS amount, u.name AS member_name,
              b.booking_group_id::text AS reference
       FROM bookings b JOIN users u ON u.id = b.user_id
       WHERE b.club_id=$1 AND b.date>=$2 AND b.date<=$3
         AND b.status='confirmed' AND b.payment_mode='immediate'
         AND b.amount_paid IS NOT NULL AND b.amount_paid > 0`,
      [clubId, from, to]
    )

    // 2. Online social play
    const { rows: socialRows } = await pool.query(
      `SELECT s.date::text AS date, 'social' AS category, 'online' AS payment_type, 'income' AS type,
              (s.price_cents/100.0)::float AS amount, u.name AS member_name, s.title AS reference
       FROM social_play_participants p
       JOIN social_play_sessions s ON s.id=p.session_id
       JOIN users u ON u.id=p.user_id
       WHERE s.club_id=$1 AND s.date>=$2 AND s.date<=$3
         AND p.payment_mode='immediate' AND p.payment_intent_id IS NOT NULL AND s.price_cents>0`,
      [clubId, from, to]
    )

    // 3. Coaching charges (ledger)
    const { rows: coachingRows } = await pool.query(
      `SELECT l.created_at::date::text AS date, 'coaching' AS category, 'online' AS payment_type, 'income' AS type,
              ABS(l.delta)::float AS amount, u.name AS member_name,
              COALESCE(cs.date::text,'manual') AS reference
       FROM coaching_hour_ledger l
       JOIN users u ON u.id=l.user_id
       LEFT JOIN coaching_sessions cs ON cs.id=l.session_id
       WHERE l.club_id=$1 AND l.created_at::date>=$2 AND l.created_at::date<=$3 AND l.delta<0`,
      [clubId, from, to]
    )

    // 4. Manual cash transactions
    const { rows: cashRows } = await pool.query(
      `SELECT ct.id, ct.created_at::date::text AS date, ct.category,
              'cash' AS payment_type, ct.type, ct.amount::float AS amount,
              COALESCE(u.name,'N/A') AS member_name, COALESCE(ct.description,'') AS reference
       FROM cash_transactions ct
       LEFT JOIN users u ON u.id=ct.member_id
       WHERE ct.club_id=$1 AND ct.created_at::date>=$2 AND ct.created_at::date<=$3`,
      [clubId, from, to]
    )

    // 5. Auto: recurring expenses (one entry per active recurring item)
    const { rows: recurringRows } = await pool.query(
      `SELECT id, category, description, amount::float FROM recurring_expenses
       WHERE club_id=$1 AND is_active=TRUE`,
      [clubId]
    )
    const recurringAutoRows = recurringRows.map(r => ({
      date: to,
      category: r.category,
      payment_type: 'auto',
      type: 'expense',
      amount: r.amount,
      member_name: '',
      reference: r.description,
      recurring_id: r.id,
    }))

    // 6. Auto: coach salary (sessions × pay_rate in date range)
    const { rows: salaryRows } = await pool.query(
      `SELECT c.id AS coach_id, c.name AS coach_name,
              c.pay_rate_per_session::float AS rate,
              COUNT(cs.id)::int AS session_count
       FROM coaches c
       JOIN coaching_sessions cs ON cs.coach_id=c.id
       WHERE c.club_id=$1 AND c.is_active=TRUE
         AND cs.date::date>=$2 AND cs.date::date<=$3
         AND cs.status='completed'
         AND c.pay_rate_per_session IS NOT NULL AND c.pay_rate_per_session > 0
       GROUP BY c.id, c.name, c.pay_rate_per_session
       HAVING COUNT(cs.id) > 0`,
      [clubId, from, to]
    )
    const salaryAutoRows = salaryRows.map(r => ({
      date: to,
      category: 'salary',
      payment_type: 'auto',
      type: 'expense',
      amount: Math.round(r.rate * r.session_count * 100) / 100,
      member_name: '',
      reference: `${r.coach_name} · ${r.session_count} session${r.session_count !== 1 ? 's' : ''} × $${r.rate}`,
      coach_id: r.coach_id,
      session_count: r.session_count,
      rate: r.rate,
    }))

    const allRows = [
      ...bookingRows, ...socialRows, ...coachingRows, ...cashRows,
      ...recurringAutoRows, ...salaryAutoRows,
    ].sort((a, b) => b.date.localeCompare(a.date))

    // Summary
    const summary = {
      income: 0, expense: 0, net: 0,
      online: 0, cash: 0,
      booking: 0, social: 0, coaching: 0, shop: 0,
      salary: 0, rent: 0, supplies: 0,
      other_income: 0, other_expense: 0,
    }
    for (const r of allRows) {
      if (r.type === 'expense') {
        summary.expense += r.amount
        if (r.category === 'other') summary.other_expense += r.amount
        else summary[r.category] = (summary[r.category] || 0) + r.amount
      } else {
        summary.income += r.amount
        if (r.payment_type !== 'auto') summary[r.payment_type] = (summary[r.payment_type] || 0) + r.amount
        if (r.category === 'other') summary.other_income += r.amount
        else summary[r.category] = (summary[r.category] || 0) + r.amount
      }
    }
    summary.net = summary.income - summary.expense
    Object.keys(summary).forEach(k => { summary[k] = Math.round(summary[k] * 100) / 100 })

    res.json({ from, to, summary, rows: allRows })
  } catch (e) {
    console.error('[finance/report]', e.message)
    res.status(500).json({ message: 'Server error.' })
  }
})

// ── Member wallet ─────────────────────────────────────────────────────────────

// GET /api/finance/wallet/:userId
router.get('/wallet/:userId', requireAuth, requireAdmin, async (req, res) => {
  const clubId = req.club?.id ?? req.user?.club_id ?? null
  try {
    const { rows: ledger } = await pool.query(
      `SELECT l.id, l.delta, l.note, l.session_type, l.created_at,
              u.name AS created_by_name
       FROM coaching_hour_ledger l
       LEFT JOIN users u ON u.id = l.created_by
       WHERE l.user_id=$1 AND l.club_id=$2
       ORDER BY l.created_at DESC LIMIT 50`,
      [req.params.userId, clubId]
    )
    const { rows: [bal] } = await pool.query(
      `SELECT COALESCE(SUM(delta),0)::numeric AS balance
       FROM coaching_hour_ledger WHERE user_id=$1 AND club_id=$2`,
      [req.params.userId, clubId]
    )
    res.json({ balance: Math.round(Number(bal.balance) * 100) / 100, ledger })
  } catch (e) { res.status(500).json({ message: 'Server error.' }) }
})

// POST /api/finance/wallet/:userId/topup  — credit or adjustment
// Writes to coaching_hour_ledger AND (if positive) cash_transactions as income
router.post('/wallet/:userId/topup', requireAuth, requireAdmin, async (req, res) => {
  const clubId = req.club?.id ?? req.user?.club_id ?? null
  const { delta, note } = req.body
  if (!delta || isNaN(delta) || Number(delta) === 0)
    return res.status(400).json({ message: 'Non-zero delta required.' })
  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    // 1. Write ledger entry
    await client.query(
      `INSERT INTO coaching_hour_ledger (user_id, delta, note, session_type, created_by, club_id)
       VALUES ($1, $2, $3, 'credit', $4, $5)`,
      [req.params.userId, Number(delta), note || null, req.user.id, clubId]
    )

    // 2. If it's a top-up (positive), also record as cash income
    if (Number(delta) > 0) {
      const { rows: [usr] } = await client.query('SELECT name FROM users WHERE id=$1', [req.params.userId])
      await client.query(
        `INSERT INTO cash_transactions (club_id, amount, category, description, member_id, recorded_by, type)
         VALUES ($1, $2, 'coaching', $3, $4, $5, 'income')`,
        [clubId, Number(delta), note || `Wallet top-up — ${usr?.name ?? 'member'}`, req.params.userId, req.user.id]
      )
    }

    await client.query('COMMIT')

    const { rows: [bal] } = await pool.query(
      `SELECT COALESCE(SUM(delta),0)::numeric AS balance
       FROM coaching_hour_ledger WHERE user_id=$1 AND club_id=$2`,
      [req.params.userId, clubId]
    )
    res.json({ balance: Math.round(Number(bal.balance) * 100) / 100 })
  } catch (e) {
    await client.query('ROLLBACK')
    console.error('[finance/wallet/topup]', e.message)
    res.status(500).json({ message: 'Server error.' })
  } finally { client.release() }
})

module.exports = router
