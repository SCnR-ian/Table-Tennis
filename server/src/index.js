require('dotenv').config()
const express        = require('express')
const cors           = require('cors')
const path           = require('path')
const session        = require('express-session')
const passport       = require('./config/passport')
const cron           = require('node-cron')

const rateLimit = require('express-rate-limit')

const app  = express()
const PORT = process.env.PORT || 8000

// ── Middleware ────────────────────────────────────────────────────────────────
app.set('trust proxy', 1)   // required on Render (runs behind a reverse proxy)
const ALLOWED_ORIGINS = [
  'http://localhost:5173',
  'http://localhost:5174',
  process.env.FRONTEND_URL,
].filter(Boolean)

app.use(cors({
  origin: (origin, cb) => {
    // Allow requests with no origin (mobile apps, curl, server-to-server)
    if (!origin) return cb(null, true)
    if (ALLOWED_ORIGINS.some(o => origin === o) || origin.endsWith('.vercel.app') || origin.endsWith('.flinther.com') || origin === 'https://flinther.com' || origin === 'http://flinther.com' || origin === 'https://eppingtabletennis.com.au' || origin === 'http://eppingtabletennis.com.au' || origin.endsWith('.eppingtabletennis.com.au') || origin.endsWith('.pages.dev') || origin.endsWith('.devtunnels.ms') || /^http:\/\/[a-z0-9-]+\.localhost(:\d+)?$/.test(origin) || /^http:\/\/(localhost|127\.0\.0\.1|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+)(:\d+)?$/.test(origin))
      return cb(null, true)
    cb(new Error(`CORS: origin ${origin} not allowed`))
  },
  credentials: true,
}))
// Raw body needed for Stripe webhook signature verification (must come before express.json)
app.use('/api/billing/webhook', express.raw({ type: 'application/json' }))
app.use(express.json({ limit: '15mb' }))

// Session is only needed during the brief OAuth redirect flow
app.use(session({
  secret:            process.env.SESSION_SECRET || 'dev_secret',
  resave:            false,
  saveUninitialized: false,
  cookie: { secure: process.env.NODE_ENV === 'production', maxAge: 5 * 60 * 1000 },
}))
app.use(passport.initialize())
app.use(passport.session())

// Serve uploaded files (product images, etc.)
app.use('/uploads', express.static(path.join(__dirname, '../uploads')))

// Resolve club from subdomain and attach to req.club on every request
const { tenantMiddleware } = require('./middleware/tenant')
app.use(tenantMiddleware)

// ── Rate limiting ─────────────────────────────────────────────────────────────
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many attempts. Please try again in 15 minutes.' },
})
const feedbackLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many feedback submissions. Please try again later.' },
})

// ── Routes ────────────────────────────────────────────────────────────────────
app.use('/api/auth',          require('./routes/auth'))
app.use('/api/profile',       require('./routes/profile'))
app.use('/api/members',       require('./routes/members'))
app.use('/api/courts',        require('./routes/courts'))
app.use('/api/bookings',      require('./routes/bookings'))
app.use('/api/admin',         require('./routes/admin'))
app.use('/api/coaching',      require('./routes/coaching'))
app.use('/api/social',        require('./routes/social'))
app.use('/api/checkin',       require('./routes/checkin'))
app.use('/api/analytics',     require('./routes/analytics'))
app.use('/api/schedule',      require('./routes/schedule'))
app.use('/api/announcements', require('./routes/announcements'))
app.use('/api/homepage',      require('./routes/homepage'))
app.use('/api/messages',     require('./routes/messages'))
app.use('/api/pages',        require('./routes/pages'))
app.use('/api/articles',     require('./routes/articles'))
app.use('/api/payments',     require('./routes/payments'))
app.use('/api/clubs',        require('./routes/clubs'))
app.use('/api/super-admin', require('./routes/superAdmin'))
app.use('/api/venue',        require('./routes/venue'))
app.use('/api/shop',         require('./routes/shop'))
app.use('/api/ai',           require('./routes/ai'))
app.use('/api/finance',      require('./routes/finance'))
app.use('/api/billing',      require('./routes/billing'))

// ── Platform feedback ─────────────────────────────────────────────────────────
app.post('/api/feedback', feedbackLimiter, async (req, res) => {
  const { message, name, email, page } = req.body
  if (!message?.trim()) return res.status(400).json({ error: 'Message is required.' })
  const { sendFeedback } = require('./utils/email')
  await sendFeedback({ message: message.trim(), name: name?.trim(), email: email?.trim(), page })
  res.json({ ok: true })
})

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => res.json({ status: 'ok' }))

// ── Debug: manually trigger reminders (dev only) ──────────────────────────────
if (process.env.NODE_ENV !== 'production') {
  app.post('/api/debug/send-reminders', async (_req, res) => {
    const { sendReminders } = require('./jobs/reminders')
    await sendReminders()
    res.json({ ok: true })
  })
}

// ── 404 ───────────────────────────────────────────────────────────────────────
app.use((req, res) => res.status(404).json({ message: 'Not found.' }))

// ── Jobs ──────────────────────────────────────────────────────────────────────
require('./jobs/reminders')
require('./jobs/leaveExpiry')

// ── Migrations ────────────────────────────────────────────────────────────────
// Idempotent schema patches applied at startup so new columns are never missing.
async function runMigrations() {
  const pool = require('./db')
  const patches = [
    `ALTER TABLE social_play_sessions ADD COLUMN IF NOT EXISTS recurrence_id UUID`,
    `CREATE INDEX IF NOT EXISTS idx_social_sessions_recurrence ON social_play_sessions(recurrence_id)`,
    `CREATE TABLE IF NOT EXISTS coaching_hour_ledger (
       id         SERIAL        PRIMARY KEY,
       user_id    INTEGER       NOT NULL REFERENCES users(id) ON DELETE CASCADE,
       delta      DECIMAL(6,2)  NOT NULL,
       note       TEXT,
       session_id INTEGER       REFERENCES coaching_sessions(id) ON DELETE SET NULL,
       created_by INTEGER       REFERENCES users(id) ON DELETE SET NULL,
       created_at TIMESTAMPTZ   NOT NULL DEFAULT NOW()
     )`,
    `CREATE INDEX IF NOT EXISTS idx_chl_user ON coaching_hour_ledger(user_id)`,
    `ALTER TABLE check_ins ADD COLUMN IF NOT EXISTS no_show BOOLEAN NOT NULL DEFAULT FALSE`,
    `CREATE TABLE IF NOT EXISTS homepage_cards (
       id              VARCHAR(20)  PRIMARY KEY,
       image_data      TEXT,
       image_filename  VARCHAR(255),
       updated_at      TIMESTAMPTZ  DEFAULT NOW()
     )`,
    `CREATE TABLE IF NOT EXISTS messages (
       id           SERIAL PRIMARY KEY,
       sender_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
       recipient_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
       body         TEXT NOT NULL,
       created_at   TIMESTAMPTZ DEFAULT NOW()
     )`,
    `CREATE TABLE IF NOT EXISTS message_reads (
       message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
       user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
       PRIMARY KEY (message_id, user_id)
     )`,
    `ALTER TABLE coaching_hour_ledger ADD COLUMN IF NOT EXISTS session_type VARCHAR(10)`,
    `CREATE TABLE IF NOT EXISTS coaching_prices (
       session_type VARCHAR(10) PRIMARY KEY,
       price        DECIMAL(8,2) NOT NULL
     )`,
    `INSERT INTO coaching_prices (session_type, price) VALUES ('solo', 70), ('group', 50) ON CONFLICT DO NOTHING`,
    `CREATE TABLE IF NOT EXISTS coaching_reviews (
       id         SERIAL PRIMARY KEY,
       coach_id   INTEGER NOT NULL REFERENCES coaches(id) ON DELETE CASCADE,
       student_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
       body       TEXT NOT NULL,
       created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
     )`,
    `ALTER TABLE coaching_reviews DROP CONSTRAINT IF EXISTS coaching_reviews_coach_id_student_id_milestone_key`,
    `ALTER TABLE coaching_reviews DROP COLUMN IF EXISTS milestone`,
    `ALTER TABLE coaching_reviews ADD COLUMN IF NOT EXISTS session_id INTEGER REFERENCES coaching_sessions(id) ON DELETE CASCADE`,
    `ALTER TABLE coaching_reviews ADD COLUMN IF NOT EXISTS skills JSONB NOT NULL DEFAULT '[]'`,
    `ALTER TABLE coaching_reviews ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`,
    `ALTER TABLE coaching_reviews ALTER COLUMN student_id DROP NOT NULL`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_cr_session ON coaching_reviews(session_id)`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS name_changed_at TIMESTAMPTZ`,
    `ALTER TABLE messages ADD COLUMN IF NOT EXISTS edited_at TIMESTAMPTZ`,
    `ALTER TABLE messages ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ`,
    `ALTER TABLE messages ADD COLUMN IF NOT EXISTS attachment_data TEXT`,
    `ALTER TABLE messages ADD COLUMN IF NOT EXISTS attachment_type VARCHAR(20)`,
    `ALTER TABLE messages ADD COLUMN IF NOT EXISTS attachment_name VARCHAR(255)`,
    `CREATE TABLE IF NOT EXISTS message_reactions (
       message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
       user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
       emoji      VARCHAR(10) NOT NULL,
       PRIMARY KEY (message_id, user_id, emoji)
     )`,
    `CREATE TABLE IF NOT EXISTS message_thread_hidden (
       user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
       other_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
       hidden_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
       PRIMARY KEY (user_id, other_user_id)
     )`,
    `CREATE TABLE IF NOT EXISTS student_coaching_prices (
       user_id     INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
       solo_price  DECIMAL(8,2),
       group_price DECIMAL(8,2)
     )`,
    `CREATE TABLE IF NOT EXISTS page_content (
       id         VARCHAR(60)  PRIMARY KEY,
       content    JSONB        NOT NULL DEFAULT '{}',
       updated_at TIMESTAMPTZ  DEFAULT NOW()
     )`,
    `CREATE TABLE IF NOT EXISTS page_images (
       id             VARCHAR(60)  PRIMARY KEY,
       image_data     TEXT,
       image_filename VARCHAR(255),
       updated_at     TIMESTAMPTZ  DEFAULT NOW()
     )`,
    // ── Payment columns on bookings ──────────────────────────────────────────
    `ALTER TABLE bookings ADD COLUMN IF NOT EXISTS payment_intent_id VARCHAR(255)`,
    `ALTER TABLE bookings ADD COLUMN IF NOT EXISTS amount_paid DECIMAL(8,2)`,
    `CREATE INDEX IF NOT EXISTS idx_bookings_payment_intent ON bookings(payment_intent_id)`,

    // ── Phase A: Multi-tenancy — clubs table + club_id columns ────────────────

    // 1. clubs table
    `CREATE TABLE IF NOT EXISTS clubs (
       id         SERIAL       PRIMARY KEY,
       name       VARCHAR(120) NOT NULL,
       subdomain  VARCHAR(63)  NOT NULL UNIQUE,
       settings   JSONB        NOT NULL DEFAULT '{}',
       is_active  BOOLEAN      NOT NULL DEFAULT TRUE,
       created_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
     )`,

    // 2. Seed Epping as the first club (id=1)
    `INSERT INTO clubs (id, name, subdomain, settings)
     VALUES (1, 'Epping Table Tennis Club', 'epping',
       '{"contactEmail":"info@eppingttclub.com.au","contactPhone":"(02) 9876 5432","address":"33 Oxford St\\nEpping NSW 2121","timezone":"Australia/Sydney"}')
     ON CONFLICT DO NOTHING`,

    // 3. Add club_id to all tenant-scoped tables (DEFAULT 1 preserves existing data)
    `ALTER TABLE users              ADD COLUMN IF NOT EXISTS club_id INTEGER NOT NULL DEFAULT 1 REFERENCES clubs(id)`,
    `CREATE INDEX IF NOT EXISTS idx_users_club              ON users(club_id)`,
    `ALTER TABLE courts             ADD COLUMN IF NOT EXISTS club_id INTEGER NOT NULL DEFAULT 1 REFERENCES clubs(id)`,
    `CREATE INDEX IF NOT EXISTS idx_courts_club             ON courts(club_id)`,
    `ALTER TABLE bookings           ADD COLUMN IF NOT EXISTS club_id INTEGER NOT NULL DEFAULT 1 REFERENCES clubs(id)`,
    `CREATE INDEX IF NOT EXISTS idx_bookings_club           ON bookings(club_id)`,
    `ALTER TABLE coaches            ADD COLUMN IF NOT EXISTS club_id INTEGER NOT NULL DEFAULT 1 REFERENCES clubs(id)`,
    `CREATE INDEX IF NOT EXISTS idx_coaches_club            ON coaches(club_id)`,
    `ALTER TABLE coaching_sessions  ADD COLUMN IF NOT EXISTS club_id INTEGER NOT NULL DEFAULT 1 REFERENCES clubs(id)`,
    `CREATE INDEX IF NOT EXISTS idx_coaching_sessions_club  ON coaching_sessions(club_id)`,
    `ALTER TABLE coaching_hour_ledger ADD COLUMN IF NOT EXISTS club_id INTEGER NOT NULL DEFAULT 1 REFERENCES clubs(id)`,
    `CREATE INDEX IF NOT EXISTS idx_chl_club                ON coaching_hour_ledger(club_id)`,
    `ALTER TABLE social_play_sessions ADD COLUMN IF NOT EXISTS club_id INTEGER NOT NULL DEFAULT 1 REFERENCES clubs(id)`,
    `CREATE INDEX IF NOT EXISTS idx_social_sessions_club    ON social_play_sessions(club_id)`,
    `ALTER TABLE tournaments        ADD COLUMN IF NOT EXISTS club_id INTEGER NOT NULL DEFAULT 1 REFERENCES clubs(id)`,
    `CREATE INDEX IF NOT EXISTS idx_tournaments_club        ON tournaments(club_id)`,
    `ALTER TABLE schedule           ADD COLUMN IF NOT EXISTS club_id INTEGER NOT NULL DEFAULT 1 REFERENCES clubs(id)`,
    `CREATE INDEX IF NOT EXISTS idx_schedule_club           ON schedule(club_id)`,
    `ALTER TABLE announcements      ADD COLUMN IF NOT EXISTS club_id INTEGER NOT NULL DEFAULT 1 REFERENCES clubs(id)`,
    `CREATE INDEX IF NOT EXISTS idx_announcements_club      ON announcements(club_id)`,
    `ALTER TABLE homepage_cards     ADD COLUMN IF NOT EXISTS club_id INTEGER NOT NULL DEFAULT 1 REFERENCES clubs(id)`,
    `ALTER TABLE page_content       ADD COLUMN IF NOT EXISTS club_id INTEGER NOT NULL DEFAULT 1 REFERENCES clubs(id)`,
    `ALTER TABLE page_images        ADD COLUMN IF NOT EXISTS club_id INTEGER NOT NULL DEFAULT 1 REFERENCES clubs(id)`,
    `ALTER TABLE check_ins          ADD COLUMN IF NOT EXISTS club_id INTEGER NOT NULL DEFAULT 1 REFERENCES clubs(id)`,
    `CREATE INDEX IF NOT EXISTS idx_checkins_club           ON check_ins(club_id)`,

    // 4. coaching_prices: add club_id then change PK to (club_id, session_type)
    `ALTER TABLE coaching_prices ADD COLUMN IF NOT EXISTS club_id INTEGER NOT NULL DEFAULT 1 REFERENCES clubs(id)`,
    `ALTER TABLE coaching_prices DROP CONSTRAINT IF EXISTS coaching_prices_pkey`,
    `ALTER TABLE coaching_prices ADD PRIMARY KEY (club_id, session_type)`,

    // 5. homepage_cards, page_content, page_images: composite PK (club_id, id)
    `ALTER TABLE homepage_cards DROP CONSTRAINT IF EXISTS homepage_cards_pkey`,
    `ALTER TABLE homepage_cards ADD PRIMARY KEY (club_id, id)`,
    `ALTER TABLE page_content DROP CONSTRAINT IF EXISTS page_content_pkey`,
    `ALTER TABLE page_content ADD PRIMARY KEY (club_id, id)`,
    `ALTER TABLE page_images DROP CONSTRAINT IF EXISTS page_images_pkey`,
    `ALTER TABLE page_images ADD PRIMARY KEY (club_id, id)`,

    // 6. bookings unique constraints: scope to club
    `ALTER TABLE bookings DROP CONSTRAINT IF EXISTS no_overlap`,
    `ALTER TABLE bookings DROP CONSTRAINT IF EXISTS user_no_double_book`,
    `ALTER TABLE bookings ADD CONSTRAINT no_overlap         UNIQUE (club_id, court_id, date, start_time)`,
    `ALTER TABLE bookings ADD CONSTRAINT user_no_double_book UNIQUE (club_id, user_id,  date, start_time)`,

    // 7. coaching_sessions partial unique indexes: scope to club
    `DROP INDEX IF EXISTS coaching_no_court_overlap`,
    `DROP INDEX IF EXISTS coaching_no_coach_overlap`,
    `DROP INDEX IF EXISTS coaching_no_student_overlap`,
    `CREATE UNIQUE INDEX IF NOT EXISTS coaching_no_court_overlap
       ON coaching_sessions (club_id, court_id, date, start_time)
       WHERE status = 'confirmed' AND group_id IS NULL`,
    `CREATE UNIQUE INDEX IF NOT EXISTS coaching_no_coach_overlap
       ON coaching_sessions (club_id, coach_id, date, start_time)
       WHERE status = 'confirmed' AND group_id IS NULL`,
    `CREATE UNIQUE INDEX IF NOT EXISTS coaching_no_student_overlap
       ON coaching_sessions (club_id, student_id, date, start_time)
       WHERE status = 'confirmed'`,

    // 8. users.email uniqueness: per-club (same email can join two different clubs)
    `ALTER TABLE users DROP CONSTRAINT IF EXISTS users_email_key`,
    `ALTER TABLE users ADD CONSTRAINT users_email_club_unique UNIQUE (club_id, email)`,

    // ── Leave request feature ────────────────────────────────────────────────
    `ALTER TABLE messages ADD COLUMN IF NOT EXISTS metadata JSONB`,
    // ── Student session rating ───────────────────────────────────────────────
    `ALTER TABLE coaching_reviews ADD COLUMN IF NOT EXISTS student_rating INTEGER CHECK (student_rating BETWEEN 1 AND 5)`,
    `ALTER TABLE coaching_reviews ADD COLUMN IF NOT EXISTS student_comment TEXT`,
    `ALTER TABLE coaching_reviews ADD COLUMN IF NOT EXISTS student_submitted_at TIMESTAMPTZ`,
    `CREATE TABLE IF NOT EXISTS session_leave_requests (
       id          SERIAL PRIMARY KEY,
       session_id  INTEGER NOT NULL REFERENCES coaching_sessions(id),
       student_id  INTEGER NOT NULL REFERENCES users(id),
       status      VARCHAR(20) NOT NULL DEFAULT 'pending',
       reason      TEXT,
       expires_at  TIMESTAMPTZ,
       resolved_at TIMESTAMPTZ,
       resolved_by INTEGER REFERENCES users(id),
       club_id     INTEGER NOT NULL DEFAULT 1 REFERENCES clubs(id),
       created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
     )`,

    // ── Venue check-in / check-out ───────────────────────────────────────────
    `ALTER TABLE clubs ADD COLUMN IF NOT EXISTS qr_token VARCHAR(64)`,
    `UPDATE clubs SET qr_token = encode(gen_random_bytes(32), 'hex') WHERE qr_token IS NULL`,
    `CREATE TABLE IF NOT EXISTS venue_checkins (
       id              SERIAL PRIMARY KEY,
       user_id         INTEGER NOT NULL REFERENCES users(id),
       club_id         INTEGER NOT NULL REFERENCES clubs(id),
       date            DATE NOT NULL DEFAULT CURRENT_DATE,
       checked_in_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
       checked_out_at  TIMESTAMPTZ,
       UNIQUE(user_id, club_id, date)
     )`,

    // ── Court assignment: no longer required per-session ────────────────────
    `ALTER TABLE bookings          ALTER COLUMN court_id DROP NOT NULL`,
    `ALTER TABLE coaching_sessions ALTER COLUMN court_id DROP NOT NULL`,

    // ── Shop products ────────────────────────────────────────────────────────
    `CREATE TABLE IF NOT EXISTS products (
       id          SERIAL PRIMARY KEY,
       name        VARCHAR(200) NOT NULL,
       category    VARCHAR(50)  NOT NULL,
       price       DECIMAL(10,2),
       description TEXT,
       sort_order  INTEGER NOT NULL DEFAULT 0,
       is_active   BOOLEAN NOT NULL DEFAULT TRUE,
       club_id     INTEGER NOT NULL DEFAULT 1 REFERENCES clubs(id),
       created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
     )`,
    // ── Product extra fields ──────────────────────────────────────────────────
    `ALTER TABLE products ADD COLUMN IF NOT EXISTS code VARCHAR(50)`,
    `ALTER TABLE products ADD COLUMN IF NOT EXISTS product_type VARCHAR(100)`,
    `ALTER TABLE products ADD COLUMN IF NOT EXISTS reaction_property VARCHAR(20)`,
    `ALTER TABLE products ADD COLUMN IF NOT EXISTS vibration_property VARCHAR(20)`,
    `ALTER TABLE products ADD COLUMN IF NOT EXISTS structure VARCHAR(300)`,
    `ALTER TABLE products ADD COLUMN IF NOT EXISTS thickness VARCHAR(50)`,
    `ALTER TABLE products ADD COLUMN IF NOT EXISTS head_size VARCHAR(50)`,
    // ── Product images (up to 6 per product) ─────────────────────────────────
    `CREATE TABLE IF NOT EXISTS product_images (
       id         SERIAL PRIMARY KEY,
       product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
       filename   VARCHAR(255) NOT NULL,
       sort_order INTEGER NOT NULL DEFAULT 0,
       club_id    INTEGER NOT NULL DEFAULT 1 REFERENCES clubs(id),
       created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
     )`,
    `CREATE INDEX IF NOT EXISTS idx_product_images_product ON product_images(product_id)`,
    `CREATE TABLE IF NOT EXISTS coach_leave_requests (
       id             SERIAL PRIMARY KEY,
       coach_user_id  INTEGER NOT NULL REFERENCES users(id),
       date_from      DATE NOT NULL,
       date_to        DATE NOT NULL,
       reason         TEXT,
       status         VARCHAR(20) NOT NULL DEFAULT 'pending',
       resolved_by    INTEGER REFERENCES users(id),
       resolved_at    TIMESTAMPTZ,
       club_id        INTEGER NOT NULL DEFAULT 1 REFERENCES clubs(id),
       created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
     )`,
    `CREATE TABLE IF NOT EXISTS club_articles (
       id          SERIAL PRIMARY KEY,
       type        VARCHAR(20) NOT NULL CHECK (type IN ('competition','news','achievement')),
       title       TEXT NOT NULL,
       subtitle    TEXT,
       body        TEXT,
       image_data  TEXT,
       image_type  VARCHAR(50),
       is_pinned   BOOLEAN NOT NULL DEFAULT FALSE,
       published_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
       created_by  INTEGER REFERENCES users(id),
       club_id     INTEGER NOT NULL DEFAULT 1 REFERENCES clubs(id),
       created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
     )`,
    `CREATE INDEX IF NOT EXISTS idx_club_articles_club_type ON club_articles(club_id, type)`,
    `CREATE TABLE IF NOT EXISTS password_reset_tokens (
       id         SERIAL PRIMARY KEY,
       user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
       token      VARCHAR(64) NOT NULL UNIQUE,
       expires_at TIMESTAMPTZ NOT NULL,
       used_at    TIMESTAMPTZ,
       created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
     )`,
    `ALTER TABLE social_play_sessions ADD COLUMN IF NOT EXISTS price_cents INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE social_play_participants ADD COLUMN IF NOT EXISTS payment_intent_id TEXT`,
    // ── Coach leave: per-session selection + coverage requests ────────────────
    `ALTER TABLE coach_leave_requests ADD COLUMN IF NOT EXISTS session_ids JSONB DEFAULT '[]'`,
    `CREATE TABLE IF NOT EXISTS coach_coverage_requests (
       id            SERIAL PRIMARY KEY,
       leave_req_id  INTEGER NOT NULL REFERENCES coach_leave_requests(id) ON DELETE CASCADE,
       session_id    INTEGER NOT NULL REFERENCES coaching_sessions(id),
       sub_coach_id  INTEGER NOT NULL REFERENCES coaches(id),
       status        VARCHAR(20) NOT NULL DEFAULT 'pending',
       club_id       INTEGER NOT NULL DEFAULT 1 REFERENCES clubs(id),
       created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
     )`,
    `ALTER TABLE session_leave_requests ADD COLUMN IF NOT EXISTS available_slots JSONB`,
    // Stock tracking for shop products (NULL = unlimited)
    `ALTER TABLE products ADD COLUMN IF NOT EXISTS stock INTEGER`,
    // Shop orders
    `CREATE TABLE IF NOT EXISTS shop_orders (
       id                 SERIAL PRIMARY KEY,
       user_id            INTEGER REFERENCES users(id) ON DELETE SET NULL,
       club_id            INTEGER NOT NULL DEFAULT 1 REFERENCES clubs(id),
       payment_intent_id  VARCHAR(255),
       status             VARCHAR(30) NOT NULL DEFAULT 'pending',
       delivery_type      VARCHAR(20) NOT NULL DEFAULT 'collect',
       address            JSONB,
       total_cents        INTEGER NOT NULL DEFAULT 0,
       created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
     )`,
    `CREATE TABLE IF NOT EXISTS shop_order_items (
       id          SERIAL PRIMARY KEY,
       order_id    INTEGER NOT NULL REFERENCES shop_orders(id) ON DELETE CASCADE,
       product_id  INTEGER REFERENCES products(id) ON DELETE SET NULL,
       name        VARCHAR(255) NOT NULL,
       qty         INTEGER NOT NULL DEFAULT 1,
       price_cents INTEGER NOT NULL DEFAULT 0
     )`,
    `CREATE INDEX IF NOT EXISTS idx_shop_orders_club ON shop_orders(club_id)`,
    `ALTER TABLE bookings ADD COLUMN IF NOT EXISTS payment_mode VARCHAR(10) DEFAULT 'hold'`,
    `ALTER TABLE social_play_participants ADD COLUMN IF NOT EXISTS payment_mode VARCHAR(10) DEFAULT 'immediate'`,
    // ── Cash transactions ────────────────────────────────────────────────────
    `CREATE TABLE IF NOT EXISTS cash_transactions (
       id          SERIAL PRIMARY KEY,
       club_id     INTEGER NOT NULL DEFAULT 1 REFERENCES clubs(id),
       amount      DECIMAL(8,2) NOT NULL,
       category    VARCHAR(30)  NOT NULL DEFAULT 'other',
       description TEXT,
       member_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
       recorded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
       created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
     )`,
    `CREATE INDEX IF NOT EXISTS idx_cash_transactions_club ON cash_transactions(club_id, created_at DESC)`,
    `ALTER TABLE club_articles ADD COLUMN IF NOT EXISTS gallery_images JSONB DEFAULT '[]'::jsonb`,
    `ALTER TABLE users ALTER COLUMN club_id DROP NOT NULL`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS platform_owner BOOLEAN NOT NULL DEFAULT FALSE`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT FALSE`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verification_token VARCHAR(64)`,
    `UPDATE users SET email_verified = TRUE WHERE platform_owner = FALSE`,
    `ALTER TABLE clubs ADD COLUMN IF NOT EXISTS billing_status VARCHAR(20) NOT NULL DEFAULT 'free'`,
    `ALTER TABLE clubs ADD COLUMN IF NOT EXISTS billing_exempt BOOLEAN NOT NULL DEFAULT FALSE`,
    `ALTER TABLE clubs ADD COLUMN IF NOT EXISTS stripe_customer_id VARCHAR(255)`,
    `ALTER TABLE clubs ADD COLUMN IF NOT EXISTS stripe_subscription_id VARCHAR(255)`,
    `UPDATE clubs SET billing_exempt = TRUE WHERE subdomain = 'epping'`,
  ]
  for (const sql of patches) {
    try { await pool.query(sql) } catch (e) { console.error('Migration warning:', e.message) }
  }
}

// ── Scheduled jobs ────────────────────────────────────────────────────────────

// Every 5 minutes: auto no-show for expired bookings with no check-in
cron.schedule('*/5 * * * *', async () => {
  const pool = require('./db')
  try {
    // Find confirmed bookings where end_time has passed, no check-in, hold not yet resolved
    const { rows } = await pool.query(`
      SELECT DISTINCT b.booking_group_id, b.user_id, b.club_id,
             MIN(b.payment_intent_id) AS payment_intent_id,
             u.id AS user_id, u.email,
             MIN(b.start_time)::text AS start_time,
             MAX(b.end_time)::text   AS end_time
      FROM bookings b
      JOIN users u ON u.id = b.user_id
      WHERE b.date = CURRENT_DATE
        AND b.status = 'confirmed'
        AND b.end_time::time < CURRENT_TIME
        AND b.payment_intent_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM check_ins ci
          WHERE ci.type = 'booking'
            AND ci.reference_id = b.booking_group_id::text
            AND ci.user_id = b.user_id
        )
      GROUP BY b.booking_group_id, b.user_id, b.club_id, u.id, u.email
    `)

    for (const row of rows) {
      try {
        // Mark as no-show in check_ins
        await pool.query(
          `INSERT INTO check_ins (user_id, type, reference_id, date, no_show, club_id)
           VALUES ($1,'booking',$2,CURRENT_DATE,true,$3) ON CONFLICT DO NOTHING`,
          [row.user_id, row.booking_group_id, row.club_id]
        )

        // Capture the payment hold
        if (process.env.STRIPE_SECRET_KEY) {
          const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY)
          const intent = await stripe.paymentIntents.retrieve(row.payment_intent_id).catch(() => null)
          if (intent?.status === 'requires_capture')
            await stripe.paymentIntents.capture(row.payment_intent_id).catch(() => {})
        }

        // Notify admin
        const { rows: [admin] } = await pool.query(
          `SELECT id FROM users WHERE role='admin' AND club_id=$1 LIMIT 1`, [row.club_id]
        )
        if (admin) {
          const msg = `⚠️ No-show: ${row.email} — booking ${row.start_time?.slice(0,5)}–${row.end_time?.slice(0,5)}. Hold captured.`
          await pool.query(
            `INSERT INTO messages (sender_id, recipient_id, body, club_id) VALUES ($1,$2,$3,$4)`,
            [row.user_id, admin.id, msg, row.club_id]
          ).catch(() => {})
          // Notify member
          await pool.query(
            `INSERT INTO messages (sender_id, recipient_id, body, club_id) VALUES ($1,$2,$3,$4)`,
            [admin.id, row.user_id, `⚠️ You were marked as a no-show for your ${row.start_time?.slice(0,5)}–${row.end_time?.slice(0,5)} booking. Your card hold has been captured.`, row.club_id]
          ).catch(() => {})
        }
      } catch (e) {
        console.error('[cron] no-show processing error:', e.message)
      }
    }
  } catch (e) {
    console.error('[cron] auto no-show failed:', e.message)
  }
})

// Daily at 23:58: auto-close open venue check-ins (forgot to check out)
cron.schedule('58 23 * * *', async () => {
  const pool = require('./db')
  try {
    const { rowCount } = await pool.query(`
      UPDATE venue_checkins
      SET checked_out_at = (date + TIME '23:59:00')::timestamptz
      WHERE date = CURRENT_DATE AND checked_out_at IS NULL
    `)
    if (rowCount > 0)
      console.log(`[cron] Auto-closed ${rowCount} open venue check-in(s) at midnight`)
  } catch (e) {
    console.error('[cron] midnight checkout failed:', e.message)
  }
})

// ── Start ─────────────────────────────────────────────────────────────────────
runMigrations().then(() =>
  app.listen(PORT, '0.0.0.0', () => console.log(`Server running on http://localhost:${PORT}`))
)
