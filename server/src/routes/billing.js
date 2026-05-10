const router = require('express').Router()
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY)
const pool   = require('../db')
const { requireAuth, requireAdmin } = require('../middleware/auth')

const PRICE_ID     = process.env.STRIPE_PRICE_ID || 'price_1TVmMQvJRi3GAqlocEoliUq'
const FLINTHER_URL = process.env.FLINTHER_URL    || 'https://flinther.com'
const FREE_LIMIT   = 25

// GET /api/billing/status
router.get('/status', requireAuth, async (req, res) => {
  try {
    const clubId = req.club?.id ?? req.user?.club_id ?? null
    if (!clubId) return res.json({ status: 'free', exempt: false, member_count: 0, limit: FREE_LIMIT })

    const { rows: [club] } = await pool.query(
      'SELECT billing_status, billing_exempt, stripe_subscription_id FROM clubs WHERE id=$1', [clubId]
    )
    const { rows: [cnt] } = await pool.query(
      `SELECT COUNT(*)::int AS count FROM users
       WHERE club_id=$1 AND (is_active IS NULL OR is_active = TRUE) AND is_walkin IS NOT TRUE`, [clubId]
    )
    res.json({
      status:           club?.billing_status || 'free',
      exempt:           club?.billing_exempt || false,
      member_count:     cnt.count,
      limit:            FREE_LIMIT,
      has_subscription: !!club?.stripe_subscription_id,
    })
  } catch (err) {
    console.error(err)
    res.status(500).json({ message: 'Server error.' })
  }
})

// POST /api/billing/checkout — create Stripe Checkout session
router.post('/checkout', requireAuth, requireAdmin, async (req, res) => {
  try {
    const clubId = req.club?.id ?? req.user?.club_id ?? null
    const { rows: [admin] } = await pool.query('SELECT email FROM users WHERE id=$1', [req.user.id])

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [{ price: PRICE_ID, quantity: 1 }],
      customer_email: admin.email,
      metadata: { club_id: String(clubId) },
      success_url: `${FLINTHER_URL}/admin?billing=success`,
      cancel_url:  `${FLINTHER_URL}/admin`,
    })
    res.json({ url: session.url })
  } catch (err) {
    console.error(err)
    res.status(500).json({ message: 'Server error.' })
  }
})

// POST /api/billing/portal — Stripe Customer Portal (manage/cancel subscription)
router.post('/portal', requireAuth, requireAdmin, async (req, res) => {
  try {
    const clubId = req.club?.id ?? req.user?.club_id ?? null
    const { rows: [club] } = await pool.query('SELECT stripe_customer_id FROM clubs WHERE id=$1', [clubId])
    if (!club?.stripe_customer_id) return res.status(400).json({ message: 'No active subscription.' })

    const session = await stripe.billingPortal.sessions.create({
      customer:   club.stripe_customer_id,
      return_url: `${FLINTHER_URL}/admin`,
    })
    res.json({ url: session.url })
  } catch (err) {
    console.error(err)
    res.status(500).json({ message: 'Server error.' })
  }
})

// POST /api/billing/webhook — Stripe events
router.post('/webhook', async (req, res) => {
  const sig    = req.headers['stripe-signature']
  const secret = process.env.STRIPE_WEBHOOK_SECRET
  let event
  try {
    event = secret
      ? stripe.webhooks.constructEvent(req.body, sig, secret)
      : JSON.parse(req.body.toString())
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`)
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const s = event.data.object
        if (s.mode !== 'subscription') break
        const clubId = s.metadata?.club_id
        if (!clubId) break
        await pool.query(
          `UPDATE clubs SET stripe_customer_id=$1, stripe_subscription_id=$2, billing_status='active' WHERE id=$3`,
          [s.customer, s.subscription, clubId]
        )
        break
      }
      case 'invoice.paid': {
        const inv = event.data.object
        if (!inv.subscription) break
        await pool.query(
          `UPDATE clubs SET billing_status='active' WHERE stripe_subscription_id=$1`,
          [inv.subscription]
        )
        break
      }
      case 'invoice.payment_failed': {
        const inv = event.data.object
        if (!inv.subscription) break
        await pool.query(
          `UPDATE clubs SET billing_status='past_due' WHERE stripe_subscription_id=$1`,
          [inv.subscription]
        )
        break
      }
      case 'customer.subscription.deleted': {
        const sub = event.data.object
        await pool.query(
          `UPDATE clubs SET billing_status='free', stripe_subscription_id=NULL WHERE stripe_subscription_id=$1`,
          [sub.id]
        )
        break
      }
    }
  } catch (err) {
    console.error('[billing webhook]', err.message)
  }

  res.json({ received: true })
})

module.exports = router
