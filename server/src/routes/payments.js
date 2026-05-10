// ─── Payments Route ───────────────────────────────────────────────────────────
// POST /api/payments/authorize         →  creates a Stripe PaymentIntent (hold or charge)
// POST /api/payments/confirm-authorize →  confirms authorization and saves to DB
// POST /api/payments/capture/:id       →  admin capture (no-show charge)
// POST /api/payments/void/:id          →  release a card hold
// POST /api/payments/shop-intent       →  shop order PaymentIntent
// GET  /api/payments/config            →  returns publishable key to frontend
// ─────────────────────────────────────────────────────────────────────────────

const router = require("express").Router();
const pool = require("../db");
const { requireAuth } = require("../middleware/auth");
const { randomUUID } = require("crypto");
const {
  checkOpenHours,
  maxConcurrentCourts,
} = require("../utils/scheduleCheck");
const { sendBookingConfirmation, sendSocialPlayJoined } = require('../utils/email')

// Lazy-load Stripe so the server still boots without the package installed
// (will throw a clear error only when a payment endpoint is called)
function getStripe() {
  if (!process.env.STRIPE_SECRET_KEY) {
    throw new Error("STRIPE_SECRET_KEY is not set in environment variables.");
  }
  return require("stripe")(process.env.STRIPE_SECRET_KEY);
}

// ─── Pricing ─────────────────────────────────────────────────────────────────
// AUD cents per 30-minute slot
const PRICE_PER_30_MIN_CENTS = 500; // AUD $7.50 → 60 min = $15, 90 = $22.50, 120 = $30

function calcAmount(startTime, endTime) {
  const toMins = (t) => {
    const [h, m] = t.substring(0, 5).split(":").map(Number);
    return h * 60 + m;
  };
  const slots = (toMins(endTime) - toMins(startTime)) / 30;
  return slots * PRICE_PER_30_MIN_CENTS; // amount in cents
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
function toMins(t) {
  const [h, m] = t.substring(0, 5).split(":").map(Number);
  return h * 60 + m;
}
function minsToTime(mins) {
  return `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}:00`;
}

// ─── GET /api/payments/config ─────────────────────────────────────────────────
// Returns Stripe publishable key so frontend can initialise Stripe.js
router.get("/config", (req, res) => {
  if (!process.env.STRIPE_PUBLISHABLE_KEY) {
    return res
      .status(500)
      .json({ message: "Stripe is not configured on this server." });
  }
  res.json({ publishableKey: process.env.STRIPE_PUBLISHABLE_KEY });
});

// ─── POST /api/payments/create-intent (REMOVED) ──────────────────────────────
// Replaced by /authorize + /confirm-authorize (hold-based flow).
// Kept as dead route returning 410 Gone so old clients get a clear error.
router.post("/create-intent", (req, res) =>
  res.status(410).json({ message: "This endpoint has been removed. Use /authorize instead." })
)

router.post("/confirm", (req, res) =>
  res.status(410).json({ message: "This endpoint has been removed. Use /confirm-authorize instead." })
)

// ─── POST /api/payments/authorize ────────────────────────────────────────────
// Creates a PaymentIntent.
// payment_mode:'hold'      → capture_method:'manual' (card held, not charged)
// payment_mode:'immediate' → charged immediately
// type:'booking' defaults to 'hold'; type:'social' defaults to 'immediate'
router.post("/authorize", requireAuth, async (req, res) => {
  const { type, date, start_time, end_time, session_id, payment_mode: rawMode } = req.body;
  if (!type) return res.status(400).json({ message: "type is required." });
  const payment_mode = rawMode === 'immediate' ? 'immediate' : rawMode === 'hold' ? 'hold'
    : (type === 'booking' ? 'hold' : 'immediate');

  const clubId = req.club?.id ?? req.user?.club_id ?? null;
  try {
    const stripe = getStripe();
    let amount, description, metadata;

    if (type === "booking") {
      if (!date || !start_time || !end_time)
        return res
          .status(400)
          .json({
            message: "date, start_time and end_time required for booking.",
          });
      const startMins = toMins(start_time),
        endMins = toMins(end_time);
      if (endMins <= startMins || endMins - startMins < 60)
        return res.status(400).json({ message: "Invalid time range." });

      const scheduleError = await checkOpenHours(
        date,
        start_time,
        end_time,
        clubId,
      );
      if (scheduleError)
        return res.status(409).json({ message: scheduleError });

      const { maxUsed, totalCourts } = await maxConcurrentCourts(
        pool,
        date,
        start_time,
        end_time,
        clubId,
      );
      if (maxUsed >= totalCourts)
        return res
          .status(409)
          .json({
            message: "Sorry, all courts are fully booked at that time.",
          });

      amount = calcAmount(start_time, end_time);
      const durationMins = endMins - startMins;
      description = `Court booking hold – ${date} ${start_time.substring(0, 5)}–${end_time.substring(0, 5)} (${durationMins} min)`;
      metadata = {
        type: "booking",
        payment_mode,
        user_id: String(req.user.id),
        club_id: String(clubId),
        date,
        start_time,
        end_time,
      };
    } else if (type === "social") {
      if (!session_id)
        return res
          .status(400)
          .json({ message: "session_id required for social." });
      const { rows } = await pool.query(
        "SELECT price_cents, title FROM social_play_sessions WHERE id=$1 AND club_id=$2",
        [session_id, clubId],
      );
      if (!rows.length)
        return res.status(404).json({ message: "Session not found." });
      amount = rows[0].price_cents;
      if (!amount || amount < 50)
        return res
          .status(400)
          .json({ message: "This session has no authorization fee." });
      description = `Social play hold – ${rows[0].title || "Social Play"} session ${session_id}`;
      metadata = {
        type: "social",
        payment_mode,
        user_id: String(req.user.id),
        club_id: String(clubId),
        session_id: String(session_id),
      };
    } else {
      return res
        .status(400)
        .json({ message: "type must be booking or social." });
    }

    const intent = await stripe.paymentIntents.create({
      amount,
      currency: "aud",
      payment_method_types: ["card"],
      ...(payment_mode === "hold" ? { capture_method: "manual" } : {}),
      metadata,
      description,
    });

    res.json({
      clientSecret: intent.client_secret,
      amount,
      intentId: intent.id,
    });
  } catch (err) {
    console.error("[payments] authorize error:", err.message);
    res
      .status(500)
      .json({ message: "Failed to create authorization. Please try again." });
  }
});

// ─── POST /api/payments/confirm-authorize ─────────────────────────────────────
// After frontend confirms the card, saves the booking (status: authorized, not paid).
router.post("/confirm-authorize", requireAuth, async (req, res) => {
  const { intentId } = req.body;
  if (!intentId)
    return res.status(400).json({ message: "intentId is required." });

  const client = await pool.connect();
  try {
    const stripe = getStripe();
    const intent = await stripe.paymentIntents.retrieve(intentId);

    const {
      type,
      payment_mode,
      date,
      start_time,
      end_time,
      club_id: metaClub,
      session_id,
    } = intent.metadata;

    // hold → requires_capture; immediate → succeeded
    const expectedStatus = payment_mode === "hold" ? "requires_capture" : "succeeded"
    if (intent.status !== expectedStatus)
      return res.status(402).json({ message: `Payment not completed (status: ${intent.status}).` });
    if (String(intent.metadata.user_id) !== String(req.user.id))
      return res.status(403).json({ message: "Authorization does not belong to this user." });
    // Strict club validation
    const metaClubNum = Number(metaClub)
    const currentClubId = req.club?.id ?? req.user?.club_id ?? null
    if (!metaClubNum || metaClubNum !== currentClubId) {
      await client.query("ROLLBACK")
      await stripe.paymentIntents.cancel(intentId).catch(() => {})
      return res.status(403).json({ message: 'Authorization is not valid for this club.' })
    }
    const clubId = metaClubNum;

    await client.query("BEGIN");

    if (type === "booking") {
      const { maxUsed, totalCourts } = await maxConcurrentCourts(
        client,
        date,
        start_time,
        end_time,
        clubId,
      );
      if (maxUsed >= totalCourts) {
        await client.query("ROLLBACK");
        await stripe.paymentIntents.cancel(intentId).catch(() => {});
        return res
          .status(409)
          .json({
            message:
              "Sorry, all courts were just taken. Your authorization has been cancelled.",
          });
      }

      const startMins = toMins(start_time),
        endMins = toMins(end_time);
      const groupId = randomUUID();
      const amountPerSlot = intent.amount / ((endMins - startMins) / 30) / 100;

      for (let t = startMins; t < endMins; t += 30) {
        await client.query(
          `INSERT INTO bookings
             (user_id, date, start_time, end_time, booking_group_id, payment_intent_id, amount_paid, payment_mode, club_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            req.user.id,
            date,
            minsToTime(t),
            minsToTime(t + 30),
            groupId,
            intentId,
            amountPerSlot,
            payment_mode || 'hold',
            clubId,
          ],
        );
      }

      await client.query("COMMIT");

      // Notify admin (fire-and-forget)
      pool.query(`SELECT id FROM users WHERE role='admin' AND club_id=$1 LIMIT 1`, [clubId])
        .then(({ rows: [admin] }) => {
          if (!admin) return;
          const fmtTime = t => { const [h, m] = t.substring(0,5).split(':').map(Number); return `${h%12||12}:${String(m).padStart(2,'0')} ${h>=12?'PM':'AM'}`; };
          const body = `🏓 ${req.user.name} booked a table on ${date} · ${fmtTime(start_time)}–${fmtTime(end_time)}`;
          pool.query(`INSERT INTO messages (sender_id, recipient_id, body, club_id) VALUES ($1,$2,$3,$4)`,
            [req.user.id, admin.id, body, clubId]).catch(() => {});
        }).catch(() => {});

      // Confirmation email to member (fire-and-forget)
      pool.query('SELECT name FROM users WHERE id=$1', [req.user.id])
        .then(({ rows: [u] }) => sendBookingConfirmation({
          to: req.user.email, name: u?.name,
          date, start_time, end_time,
        })).catch(() => {})

      res
        .status(201)
        .json({ message: "Booking authorized.", booking_group_id: groupId });
    } else if (type === "social") {
      // Check not already joined
      const { rows: existing } = await client.query(
        "SELECT 1 FROM social_play_participants WHERE session_id=$1 AND user_id=$2",
        [session_id, req.user.id],
      );
      if (existing.length) {
        await client.query("ROLLBACK");
        await stripe.paymentIntents.cancel(intentId).catch(() => {});
        return res
          .status(409)
          .json({ message: "You have already joined this session." });
      }
      await client.query(
        "INSERT INTO social_play_participants (session_id, user_id, payment_intent_id, payment_mode) VALUES ($1,$2,$3,$4)",
        [session_id, req.user.id, intentId, payment_mode || 'immediate'],
      );
      await client.query("COMMIT");

      // Notify admin + send confirmation email (fire-and-forget)
      Promise.all([
        pool.query(`SELECT id FROM users WHERE role='admin' AND club_id=$1 LIMIT 1`, [clubId]),
        pool.query(`SELECT title, date FROM social_play_sessions WHERE id=$1`, [session_id]),
        pool.query(`SELECT name FROM users WHERE id=$1`, [req.user.id]),
      ])
        .then(([{ rows: [admin] }, { rows: [s] }, { rows: [u] }]) => {
          if (s) {
            if (admin) {
              pool.query(
                `INSERT INTO messages (sender_id, recipient_id, body, club_id) VALUES ($1,$2,$3,$4)`,
                [req.user.id, admin.id, `📋 ${u?.name ?? req.user.email} joined "${s.title || 'Social Play'}" on ${s.date}`, clubId],
              ).catch(() => {})
            }
            sendSocialPlayJoined({ to: req.user.email, name: u?.name, title: s.title, date: s.date }).catch(() => {})
          }
        })
        .catch(() => {});

      res.status(201).json({ message: "Joined session. Card authorized." });
    }
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("[payments] confirm-authorize error:", err.message);
    res.status(500).json({ message: "Failed to confirm authorization." });
  } finally {
    client.release();
  }
});

// ─── POST /api/payments/authorize-extension ──────────────────────────────────
// Creates a hold PaymentIntent for a booking extension.
// body: { groupId, extra_minutes }
router.post("/authorize-extension", requireAuth, async (req, res) => {
  const { groupId, extra_minutes } = req.body;
  const extra = Number(extra_minutes);
  if (!groupId || !extra || extra % 30 !== 0 || extra <= 0)
    return res.status(400).json({ message: "groupId and extra_minutes (multiple of 30) are required." });

  const clubId = req.club?.id ?? req.user?.club_id ?? null;
  try {
    const { rows } = await pool.query(
      `SELECT user_id, date, MAX(end_time) AS end_time FROM bookings
       WHERE booking_group_id=$1 AND club_id=$2 GROUP BY user_id, date`,
      [groupId, clubId]
    );
    if (!rows[0]) return res.status(404).json({ message: "Booking not found." });
    if (rows[0].user_id !== req.user.id)
      return res.status(403).json({ message: "Forbidden." });

    const { date, end_time } = rows[0];
    // Build start/end for the extension window
    const toM = (t) => { const [h, m] = t.substring(0,5).split(":").map(Number); return h*60+m; };
    const extStart = minsToTime(toM(end_time));
    const extEnd   = minsToTime(toM(end_time) + extra);
    const amount   = (extra / 30) * PRICE_PER_30_MIN_CENTS;

    const stripe = getStripe();
    const intent = await stripe.paymentIntents.create({
      amount,
      currency: "aud",
      payment_method_types: ["card"],
      capture_method: "manual",
      metadata: {
        type: "booking_extension",
        user_id: String(req.user.id),
        club_id: String(clubId),
        group_id: String(groupId),
        date,
        start_time: extStart,
        end_time: extEnd,
      },
      description: `Extension hold – ${date} ${extStart.substring(0,5)}–${extEnd.substring(0,5)} (+${extra} min)`,
    });

    res.json({ clientSecret: intent.client_secret, intentId: intent.id, amount });
  } catch (err) {
    console.error("[payments] authorize-extension error:", err.message);
    res.status(500).json({ message: "Failed to create extension. Please try again." });
  }
});

// ─── POST /api/payments/capture/:intentId ─────────────────────────────────────
// Admin only: capture (charge) an authorized PaymentIntent (no-show).
router.post("/capture/:intentId", requireAuth, async (req, res) => {
  if (req.user.role !== "admin")
    return res.status(403).json({ message: "Admins only." });
  try {
    const stripe = getStripe();
    const intent = await stripe.paymentIntents.capture(req.params.intentId);
    res.json({ status: intent.status, amount: intent.amount });
  } catch (err) {
    console.error("[payments] capture error:", err.message);
    res.status(500).json({ message: err.message });
  }
});

// ─── POST /api/payments/void/:intentId ───────────────────────────────────────
// Cancel an authorized PaymentIntent (user showed up — release the hold).
router.post("/void/:intentId", requireAuth, async (req, res) => {
  if (req.user.role !== "admin")
    return res.status(403).json({ message: "Admins only." });
  try {
    const stripe = getStripe();
    await stripe.paymentIntents.cancel(req.params.intentId);
    res.json({ message: "Authorization released." });
  } catch (err) {
    console.error("[payments] void error:", err.message);
    res.status(500).json({ message: err.message });
  }
});

// ─── POST /api/payments/shop-intent ──────────────────────────────────────────
// Creates a Stripe PaymentIntent for a shopping cart order.
// Body: { items: [{ product_id, qty }] }
// Verifies prices from DB (never trust frontend amounts).
router.post("/shop-intent", requireAuth, async (req, res) => {
  const { items } = req.body;
  if (!Array.isArray(items) || items.length === 0)
    return res.status(400).json({ message: "items array is required." });

  const clubId = req.club?.id ?? req.user?.club_id ?? null;
  try {
    const stripe = getStripe();

    // Fetch real prices and stock from DB
    const ids = items.map((i) => i.product_id);
    const { rows: products } = await pool.query(
      `SELECT id, name, price, stock FROM products WHERE id = ANY($1) AND club_id=$2 AND is_active=TRUE`,
      [ids, clubId],
    );

    // Build line items and calculate total; enforce stock
    let totalCents = 0;
    const lineItems = [];
    for (const item of items) {
      const product = products.find((p) => p.id === item.product_id);
      if (!product)
        return res
          .status(400)
          .json({ message: `Product ${item.product_id} not found.` });
      if (!product.price)
        return res
          .status(400)
          .json({ message: `Product "${product.name}" has no price set.` });
      const qty = Math.max(1, Math.floor(item.qty));
      if (product.stock !== null && product.stock !== undefined && product.stock < qty)
        return res.status(409).json({ message: `"${product.name}" only has ${product.stock} left in stock.` });
      const cents = Math.round(Number(product.price) * 100) * qty;
      totalCents += cents;
      lineItems.push({ product_id: product.id, name: product.name, qty, price_cents: cents });
    }

    if (totalCents < 50)
      return res.status(400).json({ message: "Order total is too small." });

    const description = lineItems.map((l) => `${l.name} ×${l.qty}`).join(", ");

    const paymentIntent = await stripe.paymentIntents.create({
      amount: totalCents,
      currency: "aud",
      payment_method_types: ["card"],
      metadata: {
        user_id: String(req.user.id),
        club_id: String(clubId),
        type: "shop_order",
        items: JSON.stringify(lineItems),
      },
      description: `Shop order: ${description}`,
    });

    res.json({
      clientSecret: paymentIntent.client_secret,
      intentId: paymentIntent.id,
      amount: totalCents,
      currency: "aud",
    });
  } catch (err) {
    console.error("[payments] shop-intent error:", err.message);
    if (err.message.includes("STRIPE_SECRET_KEY"))
      return res
        .status(503)
        .json({ message: "Payment system is not configured." });
    res
      .status(500)
      .json({ message: "Failed to create payment. Please try again." });
  }
});

module.exports = router;
