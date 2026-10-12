const router    = require('express').Router()
const bcrypt    = require('bcryptjs')
const jwt       = require('jsonwebtoken')
const crypto    = require('crypto')
const rateLimit = require('express-rate-limit')
const passport  = require('../config/passport')
const pool      = require('../db')
const { Resend } = require('resend')
const { authLimiter } = require('../middleware/rateLimit')

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many login attempts. Please try again in 15 minutes.' },
})

const resend = new Resend(process.env.RESEND_API_KEY)
const EMAIL_FROM = process.env.EMAIL_FROM || 'noreply@eppingtabletennis.com.au'
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173'

const sign = (user) =>
  jwt.sign(
    { id: user.id, email: user.email, role: user.role, club_id: user.club_id },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
  )

const safeUser = (u) => ({
  id: u.id, name: u.name, email: u.email,
  role: u.role, phone: u.phone, avatar_url: u.avatar_url,
  club_id: u.club_id,
  name_changed_at: u.name_changed_at ?? null,
})

// POST /api/auth/register
router.post('/register', authLimiter, async (req, res) => {
  const { name, password, phone } = req.body
  const email = req.body.email?.toLowerCase().trim()
  if (!name || !email || !password)
    return res.status(400).json({ message: 'Name, email and password are required.' })
  if (password.length < 8)
    return res.status(400).json({ message: 'Password must be at least 8 characters.' })

  const clubId = req.club.id

  try {
    const hash = await bcrypt.hash(password, 12)

    // Club member signup
    const { rows } = await pool.query(
      'INSERT INTO users (name, email, password_hash, phone, club_id, platform_owner, email_verified) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
      [name, email, hash, phone || null, clubId, false, true]
    )
    res.status(201).json({ token: sign(rows[0]), user: safeUser(rows[0]) })
  } catch (err) {
    if (err.code === '23505')
      return res.status(409).json({ message: 'An account with that email already exists.' })
    console.error(err)
    res.status(500).json({ message: 'Server error.' })
  }
})

// POST /api/auth/login
// `identifier` accepts either an email address or a phone number
router.post('/login', loginLimiter, async (req, res) => {
  const { identifier, password } = req.body
  if (!identifier || !password)
    return res.status(400).json({ message: 'Email/phone and password are required.' })

  try {
    const { rows } = await pool.query(
      'SELECT * FROM users WHERE (email=$1 OR phone=$1) AND club_id=$2',
      [identifier.toLowerCase().trim(), req.club.id]
    )
    const user = rows[0]
    if (!user || !user.password_hash)
      return res.status(401).json({ message: 'Invalid email/phone or password.' })

    if (user.is_active === false)
      return res.status(403).json({ message: 'This account has been deactivated. Please contact the club.' })

    const ok = await bcrypt.compare(password, user.password_hash)
    if (!ok) return res.status(401).json({ message: 'Invalid email/phone or password.' })

    res.json({ token: sign(user), user: safeUser(user) })
  } catch (err) {
    console.error(err)
    res.status(500).json({ message: 'Server error.' })
  }
})

// POST /api/auth/logout  (client just discards token; endpoint for symmetry)
router.post('/logout', (req, res) => {
  req.logout?.(() => {})
  res.json({ message: 'Logged out.' })
})

// GET /api/auth/me
router.get('/me', require('../middleware/auth').requireAuth, async (req, res) => {
  try {
    const clubId = req.club?.id ?? req.user.club_id
    const { rows } = await pool.query(
      'SELECT * FROM users WHERE id=$1 AND club_id=$2',
      [req.user.id, clubId]
    )
    if (!rows[0]) return res.status(404).json({ message: 'User not found.' })
    res.json({ user: safeUser(rows[0]) })
  } catch (err) {
    res.status(500).json({ message: 'Server error.' })
  }
})

// ── Forgot Password ───────────────────────────────────────────────────────────
router.post('/forgot-password', authLimiter, async (req, res) => {
  const { email } = req.body
  if (!email) return res.status(400).json({ message: 'Email is required.' })
  if (!req.club) return res.status(400).json({ message: 'Club not found.' })

  try {
    const { rows } = await pool.query(
      'SELECT id, name FROM users WHERE email = $1 AND club_id = $2',
      [email.toLowerCase().trim(), req.club.id]
    )
    // Always return 200 to prevent email enumeration
    if (rows.length === 0) return res.json({ message: 'If that email exists, a reset link has been sent.' })

    const user = rows[0]
    const token = crypto.randomBytes(32).toString('hex')
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000) // 1 hour

    // Invalidate any existing tokens for this user
    await pool.query('DELETE FROM password_reset_tokens WHERE user_id = $1', [user.id])
    await pool.query(
      'INSERT INTO password_reset_tokens (user_id, token, expires_at) VALUES ($1, $2, $3)',
      [user.id, token, expiresAt]
    )

    const resetUrl = `${FRONTEND_URL}/reset-password?token=${token}`

    await resend.emails.send({
      from: EMAIL_FROM,
      to: email,
      subject: 'Reset your password',
      html: `
        <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;">
          <h2 style="font-size:20px;font-weight:600;margin-bottom:8px;">Reset your password</h2>
          <p style="color:#555;margin-bottom:24px;">Hi ${user.name}, click the button below to reset your password. This link expires in 1 hour.</p>
          <a href="${resetUrl}" style="display:inline-block;background:#000;color:#fff;padding:12px 28px;border-radius:999px;text-decoration:none;font-size:14px;letter-spacing:0.05em;">Reset Password</a>
          <p style="color:#aaa;font-size:12px;margin-top:24px;">If you didn't request this, you can safely ignore this email.</p>
        </div>
      `,
    })

    res.json({ message: 'If that email exists, a reset link has been sent.' })
  } catch (err) {
    console.error('[auth] forgot-password error:', err.message)
    res.status(500).json({ message: 'Server error. Please try again.' })
  }
})

// ── Reset Password ────────────────────────────────────────────────────────────
router.post('/reset-password', authLimiter, async (req, res) => {
  const { token, password } = req.body
  if (!token || !password) return res.status(400).json({ message: 'Token and new password are required.' })
  if (password.length < 8) return res.status(400).json({ message: 'Password must be at least 8 characters.' })

  try {
    const { rows } = await pool.query(
      `SELECT prt.id, prt.user_id, prt.expires_at, prt.used_at
       FROM password_reset_tokens prt
       WHERE prt.token = $1`,
      [token]
    )

    if (rows.length === 0) return res.status(400).json({ message: 'Invalid or expired reset link.' })
    const row = rows[0]

    if (row.used_at) return res.status(400).json({ message: 'This reset link has already been used.' })
    if (new Date(row.expires_at) < new Date()) return res.status(400).json({ message: 'This reset link has expired. Please request a new one.' })

    const hash = await bcrypt.hash(password, 12)
    await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, row.user_id])
    await pool.query('UPDATE password_reset_tokens SET used_at = NOW() WHERE id = $1', [row.id])

    res.json({ message: 'Password updated successfully.' })
  } catch (err) {
    console.error('[auth] reset-password error:', err.message)
    res.status(500).json({ message: 'Server error. Please try again.' })
  }
})

// ── Google OAuth ─────────────────────────────────────────────────────────────
router.get('/google', (req, res, next) => {
  // Store the current club in session so the OAuth callback knows which club
  // to create/link the user against
  req.session.oauthClubId = req.club?.id ?? req.user?.club_id ?? null
  passport.authenticate('google', { scope: ['profile', 'email'] })(req, res, next)
})

router.get('/google/callback',
  passport.authenticate('google', { failureRedirect: `${process.env.FRONTEND_URL}/login?error=oauth_failed`, session: false }),
  (req, res) => {
    if (req.user?.is_active === false)
      return res.redirect(`${process.env.FRONTEND_URL}/login?error=account_deactivated`)
    const token = sign(req.user)
    res.redirect(`${process.env.FRONTEND_URL}/auth/callback?token=${token}`)
  }
)

module.exports = router
