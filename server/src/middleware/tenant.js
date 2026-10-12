const pool = require('../db')

// ── Single-club resolver ──────────────────────────────────────────────────────
// This server runs one club only: Epping Table Tennis. The club row is looked
// up once by its subdomain (CLUB_SUBDOMAIN, default 'epping') and attached to
// every request as req.club, so routes keep using req.club.id as before.
// The club row is cached for 5 minutes; bustClubCache() clears it after an
// admin edits the club's name, settings or logo.

const CLUB_SUBDOMAIN = process.env.CLUB_SUBDOMAIN || 'epping'
const CACHE_TTL_MS   = 5 * 60 * 1000

let cached = null   // { club, cachedAt }

async function getClub() {
  if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) return cached.club
  const { rows } = await pool.query(
    'SELECT * FROM clubs WHERE subdomain = $1 AND is_active = TRUE',
    [CLUB_SUBDOMAIN]
  )
  const club = rows[0] || null
  if (club) cached = { club, cachedAt: Date.now() }
  return club
}

function bustClubCache() {
  cached = null
}

async function tenantMiddleware(req, res, next) {
  try {
    const club = await getClub()
    if (!club) {
      console.error(`[tenant] Club '${CLUB_SUBDOMAIN}' not found or inactive.`)
      return res.status(503).json({ message: 'Club is not configured.' })
    }
    req.club = club
    next()
  } catch (err) {
    console.error('[tenant] error:', err.message)
    res.status(500).json({ message: 'Server error resolving club.' })
  }
}

module.exports = { tenantMiddleware, bustClubCache }
