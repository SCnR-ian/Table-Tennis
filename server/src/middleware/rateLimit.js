const rateLimit = require('express-rate-limit')

// Strict limiter for authentication-sensitive endpoints (register, password
// reset). Slows down credential brute-forcing and reset-email abuse.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20,                  // 20 attempts per IP per window
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many attempts. Please try again later.' },
})

// General API limiter: generous, just a safety net against runaway clients.
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 1000,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many requests. Please slow down.' },
})

module.exports = { authLimiter, apiLimiter }
