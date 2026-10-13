-- usage-stats.sql: read-only usage numbers for the Epping club (no writes).
-- Run:  psql "$DATABASE_URL" -f server/scripts/usage-stats.sql

\pset footer off
\echo '== Epping usage =='
WITH club AS (SELECT id FROM clubs WHERE subdomain = 'epping')
SELECT 'members (active accounts)'           AS metric, count(*)::text AS value FROM users            WHERE club_id = (SELECT id FROM club) AND COALESCE(is_active, TRUE) AND role = 'member'
UNION ALL SELECT 'coaches',                             count(*)::text FROM coaches                    WHERE club_id = (SELECT id FROM club)
UNION ALL SELECT 'court bookings (confirmed, 1 per booking)', count(DISTINCT COALESCE(booking_group_id::text, id::text))::text FROM bookings WHERE club_id = (SELECT id FROM club) AND status = 'confirmed'
UNION ALL SELECT 'coaching sessions held (confirmed/completed)', count(DISTINCT COALESCE(group_id::text, id::text))::text FROM coaching_sessions WHERE club_id = (SELECT id FROM club) AND status IN ('confirmed','completed')
UNION ALL SELECT 'social play sessions',                count(*)::text FROM social_play_sessions        WHERE club_id = (SELECT id FROM club)
UNION ALL SELECT 'social play sign-ups',                count(*)::text FROM social_play_participants p JOIN social_play_sessions s ON s.id = p.session_id WHERE s.club_id = (SELECT id FROM club)
UNION ALL SELECT 'session check-ins',                   count(*)::text FROM check_ins                   WHERE club_id = (SELECT id FROM club) AND NOT no_show
UNION ALL SELECT 'no-shows auto-recorded',              count(*)::text FROM check_ins                   WHERE club_id = (SELECT id FROM club) AND no_show
UNION ALL SELECT 'venue check-ins (QR)',                count(*)::text FROM venue_checkins              WHERE club_id = (SELECT id FROM club)
UNION ALL SELECT 'leave requests handled',              count(*)::text FROM session_leave_requests      WHERE club_id = (SELECT id FROM club) AND status <> 'pending'
UNION ALL SELECT 'bookings paid by card (Stripe)',      count(*)::text FROM bookings                    WHERE club_id = (SELECT id FROM club) AND payment_intent_id IS NOT NULL
UNION ALL SELECT 'first booking date',                  min(date)::text FROM bookings                   WHERE club_id = (SELECT id FROM club)
UNION ALL SELECT 'last booking date',                   max(date)::text FROM bookings                   WHERE club_id = (SELECT id FROM club);

\echo '== Busiest months (court bookings + coaching sessions) =='
WITH club AS (SELECT id FROM clubs WHERE subdomain = 'epping'),
ev AS (
  SELECT date FROM bookings          WHERE club_id = (SELECT id FROM club) AND status = 'confirmed'
  UNION ALL
  SELECT date FROM coaching_sessions WHERE club_id = (SELECT id FROM club) AND status IN ('confirmed','completed')
)
SELECT to_char(date_trunc('month', date), 'YYYY-MM') AS month, count(*) AS events
FROM ev GROUP BY 1 ORDER BY 1;
