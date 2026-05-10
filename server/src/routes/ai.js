const router  = require('express').Router()
const pool    = require('../db')
const { requireAuth, requireAdmin } = require('../middleware/auth')
const Anthropic = require('@anthropic-ai/sdk')
const { checkOpenHours, maxConcurrentCourts } = require('../utils/scheduleCheck')

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtDate(d) {
  if (!d) return ''
  return new Date(d.slice ? d.slice(0,10)+'T12:00:00' : d)
    .toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })
}
function fmtTime(t) {
  if (!t) return ''
  const str = typeof t === 'string' ? t : String(t)
  const [h, m] = str.substring(0, 5).split(':').map(Number)
  return `${h % 12 || 12}:${String(m).padStart(2,'0')} ${h >= 12 ? 'PM' : 'AM'}`
}
function todaySydney() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' })
}

// ── Tool definitions ──────────────────────────────────────────────────────────

const TOOLS = [
  // ── Members ──
  {
    name: 'list_members',
    description: 'List club members. Can filter by name or role.',
    input_schema: {
      type: 'object',
      properties: {
        search: { type: 'string', description: 'Filter by name (optional)' },
        role:   { type: 'string', description: 'Filter by role: member, coach, admin (optional)' },
      },
    },
  },
  {
    name: 'create_member',
    description: 'Create a new member account in the club.',
    input_schema: {
      type: 'object',
      properties: {
        name:     { type: 'string' },
        email:    { type: 'string' },
        password: { type: 'string', description: 'Initial password for the account' },
        phone:    { type: 'string', description: 'Optional phone number' },
      },
      required: ['name', 'email', 'password'],
    },
  },
  {
    name: 'update_member',
    description: 'Update a member\'s name or email.',
    input_schema: {
      type: 'object',
      properties: {
        user_id: { type: 'number' },
        name:    { type: 'string', description: 'New name (optional)' },
        email:   { type: 'string', description: 'New email (optional)' },
      },
      required: ['user_id'],
    },
  },
  {
    name: 'delete_member',
    description: 'Permanently delete a member account.',
    input_schema: {
      type: 'object',
      properties: {
        user_id: { type: 'number' },
      },
      required: ['user_id'],
    },
  },
  // ── Coaching ──
  {
    name: 'get_member_balance',
    description: 'Get a student\'s coaching hour/dollar balance.',
    input_schema: {
      type: 'object',
      properties: {
        user_id: { type: 'number', description: 'User ID of the student' },
      },
      required: ['user_id'],
    },
  },
  {
    name: 'add_balance',
    description: 'Add coaching balance (dollars) to a student account.',
    input_schema: {
      type: 'object',
      properties: {
        user_id: { type: 'number' },
        amount:  { type: 'number', description: 'Dollar amount to add (positive)' },
        note:    { type: 'string', description: 'Reason or note' },
      },
      required: ['user_id', 'amount'],
    },
  },
  {
    name: 'add_balance_all',
    description: 'Add coaching balance (dollars) to ALL members in one operation. Use this instead of calling add_balance repeatedly when the admin wants to top up everyone.',
    input_schema: {
      type: 'object',
      properties: {
        amount: { type: 'number', description: 'Dollar amount to add to every member' },
        note:   { type: 'string', description: 'Reason or note' },
      },
      required: ['amount'],
    },
  },
  {
    name: 'list_coaches',
    description: 'List all coaches in the club.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'list_sessions',
    description: 'List coaching sessions for a date range or specific student/coach.',
    input_schema: {
      type: 'object',
      properties: {
        date_from:     { type: 'string', description: 'YYYY-MM-DD' },
        date_to:       { type: 'string', description: 'YYYY-MM-DD' },
        student_id:    { type: 'number' },
        coach_id:      { type: 'number', description: 'coaches table ID (from list_coaches coach_id field)' },
        coach_user_id: { type: 'number', description: 'user ID of the coach (alternative to coach_id)' },
        status:        { type: 'string', description: 'confirmed, cancelled, completed (optional, omit for all)' },
      },
    },
  },
  {
    name: 'create_session',
    description: 'Create a new coaching session for a student with a coach.',
    input_schema: {
      type: 'object',
      properties: {
        coach_id:      { type: 'number', description: 'coaches table ID (from list_coaches coach_id field)' },
        coach_user_id: { type: 'number', description: 'user ID of the coach — used if coach has no coach profile yet' },
        student_id:    { type: 'number' },
        date:          { type: 'string', description: 'YYYY-MM-DD' },
        start_time:    { type: 'string', description: 'HH:MM (24h)' },
        end_time:      { type: 'string', description: 'HH:MM (24h)' },
      },
      required: ['student_id', 'date', 'start_time', 'end_time'],
    },
  },
  {
    name: 'reschedule_session',
    description: 'Reschedule a coaching session to a new time on the same or different date. For group sessions listed as [10,11], pass any one of the IDs — the system will automatically reschedule all group members together.',
    input_schema: {
      type: 'object',
      properties: {
        session_id: { type: 'number', description: 'Session ID. For group sessions shown as [10,11], use the first ID (10).' },
        date:       { type: 'string', description: 'YYYY-MM-DD — omit to keep same date' },
        start_time: { type: 'string', description: 'HH:MM (24h) new start time' },
        end_time:   { type: 'string', description: 'HH:MM (24h) new end time' },
      },
      required: ['session_id', 'start_time', 'end_time'],
    },
  },
  {
    name: 'cancel_session',
    description: 'Cancel a coaching session by session ID.',
    input_schema: {
      type: 'object',
      properties: {
        session_id: { type: 'number' },
      },
      required: ['session_id'],
    },
  },
  // ── Leave requests ──
  {
    name: 'list_leave_requests',
    description: 'List coaching session leave requests. Filter by status.',
    input_schema: {
      type: 'object',
      properties: {
        status: { type: 'string', description: 'pending, approved, rejected, rescheduled (default: pending)' },
      },
    },
  },
  {
    name: 'approve_leave_request',
    description: 'Approve a student leave request. Sends slot options to the student.',
    input_schema: {
      type: 'object',
      properties: {
        request_id: { type: 'number' },
      },
      required: ['request_id'],
    },
  },
  {
    name: 'reject_leave_request',
    description: 'Reject a student leave request.',
    input_schema: {
      type: 'object',
      properties: {
        request_id: { type: 'number' },
      },
      required: ['request_id'],
    },
  },
  // ── Bookings ──
  {
    name: 'check_court_availability',
    description: 'Check how many courts are free at a given date and time range. Returns courts used, courts free, and a breakdown of what is occupying each court.',
    input_schema: {
      type: 'object',
      properties: {
        date:       { type: 'string', description: 'YYYY-MM-DD' },
        start_time: { type: 'string', description: 'HH:MM (24h)' },
        end_time:   { type: 'string', description: 'HH:MM (24h)' },
      },
      required: ['date', 'start_time', 'end_time'],
    },
  },
  {
    name: 'list_bookings',
    description: 'List confirmed court bookings. Filter by date or member name.',
    input_schema: {
      type: 'object',
      properties: {
        date:   { type: 'string', description: 'YYYY-MM-DD (optional, defaults to today)' },
        search: { type: 'string', description: 'Filter by member name (optional)' },
      },
    },
  },
  {
    name: 'cancel_booking',
    description: 'Cancel a court booking group by booking_group_id.',
    input_schema: {
      type: 'object',
      properties: {
        booking_group_id: { type: 'string', description: 'The booking group UUID' },
      },
      required: ['booking_group_id'],
    },
  },
  {
    name: 'reschedule_booking',
    description: 'Reschedule a court booking (from the bookings table) to a new date and/or time. The booking_group_id comes from list_bookings.',
    input_schema: {
      type: 'object',
      properties: {
        booking_group_id: { type: 'string', description: 'The booking group UUID from list_bookings' },
        date:             { type: 'string', description: 'New date YYYY-MM-DD — omit to keep same date' },
        start_time:       { type: 'string', description: 'New start time HH:MM (24h)' },
        end_time:         { type: 'string', description: 'New end time HH:MM (24h) — omit to keep same duration' },
      },
      required: ['booking_group_id', 'start_time'],
    },
  },
  // ── Social Play ──
  {
    name: 'update_social_session',
    description: 'Update a single social play session (title, time, courts, max players).',
    input_schema: {
      type: 'object',
      properties: {
        session_id:  { type: 'number' },
        start_time:  { type: 'string', description: 'HH:MM (24h)' },
        end_time:    { type: 'string', description: 'HH:MM (24h)' },
        title:       { type: 'string' },
        num_courts:  { type: 'number' },
        max_players: { type: 'number' },
      },
      required: ['session_id'],
    },
  },
  {
    name: 'bulk_update_social_sessions',
    description: 'Update time for all upcoming social play sessions on a specific weekday. Use this when the admin wants to change the regular time for e.g. all Tuesday sessions.',
    input_schema: {
      type: 'object',
      properties: {
        weekday:    { type: 'string', description: 'Day of week: Monday, Tuesday, Wednesday, Thursday, Friday, Saturday, Sunday' },
        start_time: { type: 'string', description: 'New start time HH:MM (24h)' },
        end_time:   { type: 'string', description: 'New end time HH:MM (24h)' },
        title:      { type: 'string', description: 'New title (optional)' },
        num_courts: { type: 'number', description: 'New number of courts (optional)' },
      },
      required: ['weekday', 'start_time', 'end_time'],
    },
  },
  {
    name: 'list_social_sessions',
    description: 'List social play sessions. Defaults to upcoming sessions.',
    input_schema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'YYYY-MM-DD — specific date (optional)' },
        include_past: { type: 'boolean', description: 'Include past sessions (default false)' },
      },
    },
  },
  {
    name: 'create_social_session',
    description: 'Create a social play session.',
    input_schema: {
      type: 'object',
      properties: {
        title:       { type: 'string', description: 'Session title (default: "Social Play")' },
        date:        { type: 'string', description: 'YYYY-MM-DD' },
        start_time:  { type: 'string', description: 'HH:MM (24h)' },
        end_time:    { type: 'string', description: 'HH:MM (24h)' },
        num_courts:  { type: 'number', description: 'Number of courts (default 2)' },
        max_players: { type: 'number', description: 'Max players (default 12)' },
        description: { type: 'string' },
      },
      required: ['date', 'start_time', 'end_time'],
    },
  },
  {
    name: 'cancel_social_session',
    description: 'Cancel a social play session by ID.',
    input_schema: {
      type: 'object',
      properties: {
        session_id: { type: 'number' },
      },
      required: ['session_id'],
    },
  },
  {
    name: 'add_member_to_social',
    description: 'Add a member to a social play session.',
    input_schema: {
      type: 'object',
      properties: {
        session_id: { type: 'number' },
        user_id:    { type: 'number' },
      },
      required: ['session_id', 'user_id'],
    },
  },
  {
    name: 'remove_member_from_social',
    description: 'Remove a member from a social play session.',
    input_schema: {
      type: 'object',
      properties: {
        session_id: { type: 'number' },
        user_id:    { type: 'number' },
      },
      required: ['session_id', 'user_id'],
    },
  },
  // ── Tournaments ──
  {
    name: 'list_tournaments',
    description: 'List all tournaments.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'create_tournament',
    description: 'Create a new tournament.',
    input_schema: {
      type: 'object',
      properties: {
        name:             { type: 'string' },
        date:             { type: 'string', description: 'YYYY-MM-DD' },
        format:           { type: 'string', description: 'Singles, Doubles, Teams (default: Singles)' },
        status:           { type: 'string', description: 'upcoming, ongoing, completed (default: upcoming)' },
        max_participants: { type: 'number', description: 'Max entrants (default 32)' },
        prize:            { type: 'string', description: 'Prize description (optional)' },
      },
      required: ['name', 'date'],
    },
  },
  {
    name: 'update_tournament',
    description: 'Update tournament details.',
    input_schema: {
      type: 'object',
      properties: {
        tournament_id:    { type: 'number' },
        name:             { type: 'string' },
        date:             { type: 'string', description: 'YYYY-MM-DD' },
        format:           { type: 'string' },
        status:           { type: 'string', description: 'upcoming, ongoing, completed' },
        max_participants: { type: 'number' },
        prize:            { type: 'string' },
      },
      required: ['tournament_id'],
    },
  },
  {
    name: 'delete_tournament',
    description: 'Delete a tournament by ID.',
    input_schema: {
      type: 'object',
      properties: {
        tournament_id: { type: 'number' },
      },
      required: ['tournament_id'],
    },
  },
  // ── Venue / Check-ins ──
  {
    name: 'get_venue_checkins',
    description: 'Get venue check-ins for a specific date (defaults to today).',
    input_schema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'YYYY-MM-DD (optional, defaults to today)' },
      },
    },
  },
  // ── Announcements ──
  {
    name: 'list_announcements',
    description: 'List recent club announcements.',
    input_schema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Number of announcements to return (default 10)' },
      },
    },
  },
  {
    name: 'send_announcement',
    description: 'Send an announcement to all club members.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        body:  { type: 'string' },
      },
      required: ['title', 'body'],
    },
  },
  // ── Group sessions ──
  {
    name: 'list_group_sessions',
    description: 'List group coaching sessions with their students.',
    input_schema: {
      type: 'object',
      properties: {
        date:         { type: 'string', description: 'YYYY-MM-DD — specific date (optional)' },
        include_past: { type: 'boolean', description: 'Include past sessions (default false)' },
      },
    },
  },
  {
    name: 'merge_into_group',
    description: 'Merge multiple individual 1-on-1 coaching sessions into one group session. Sessions must have the same coach, date, and time.',
    input_schema: {
      type: 'object',
      properties: {
        session_ids: {
          type: 'array',
          items: { type: 'number' },
          description: 'IDs of the individual sessions to merge into a group (2–5)',
        },
      },
      required: ['session_ids'],
    },
  },
  {
    name: 'split_from_group',
    description: 'Remove a student from a group session, converting their session to 1-on-1.',
    input_schema: {
      type: 'object',
      properties: {
        session_id: { type: 'number', description: 'The session row ID to split out from the group' },
      },
      required: ['session_id'],
    },
  },
  {
    name: 'add_to_group',
    description: 'Move a student from their individual 1-on-1 session into an existing group session at the same time. Cancels the individual session.',
    input_schema: {
      type: 'object',
      properties: {
        individual_session_id: { type: 'number', description: "Session ID of the student's current 1-on-1 session" },
        group_id:              { type: 'string', description: 'The group_id UUID of the target group session' },
      },
      required: ['individual_session_id', 'group_id'],
    },
  },
  // ── Bulk operations ──
  {
    name: 'cancel_sessions_on_date',
    description: 'Cancel ALL coaching sessions on a specific date (e.g. public holiday, venue closure).',
    input_schema: {
      type: 'object',
      properties: {
        date:     { type: 'string', description: 'YYYY-MM-DD' },
        coach_id: { type: 'number', description: 'Limit to a specific coach (optional)' },
      },
      required: ['date'],
    },
  },
  {
    name: 'cancel_sessions_in_range',
    description: 'Cancel ALL coaching sessions within a date range (e.g. school holidays).',
    input_schema: {
      type: 'object',
      properties: {
        date_from: { type: 'string', description: 'YYYY-MM-DD start date (inclusive)' },
        date_to:   { type: 'string', description: 'YYYY-MM-DD end date (inclusive)' },
        coach_id:  { type: 'number', description: 'Limit to a specific coach (optional)' },
      },
      required: ['date_from', 'date_to'],
    },
  },
  {
    name: 'cancel_social_sessions_on_date',
    description: 'Cancel ALL social play sessions on a specific date.',
    input_schema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'YYYY-MM-DD' },
      },
      required: ['date'],
    },
  },
  {
    name: 'cancel_social_sessions_in_range',
    description: 'Cancel ALL social play sessions within a date range.',
    input_schema: {
      type: 'object',
      properties: {
        date_from: { type: 'string', description: 'YYYY-MM-DD start date (inclusive)' },
        date_to:   { type: 'string', description: 'YYYY-MM-DD end date (inclusive)' },
      },
      required: ['date_from', 'date_to'],
    },
  },
  {
    name: 'process_coach_leave',
    description: 'Process coach leave: cancels sessions on the given date(s) and sends each affected student a message with makeup slot options to pick from. Students select their slot via the chat.',
    input_schema: {
      type: 'object',
      properties: {
        coach_user_id: { type: 'number', description: 'User ID of the coach taking leave' },
        date_from:     { type: 'string', description: 'YYYY-MM-DD leave start date' },
        date_to:       { type: 'string', description: 'YYYY-MM-DD leave end date (optional, defaults to date_from for a single day)' },
        reason:        { type: 'string', description: 'Reason shown to students (optional)' },
      },
      required: ['coach_user_id', 'date_from'],
    },
  },
  {
    name: 'cancel_coach_sessions',
    description: 'Cancel all upcoming sessions for a specific coach. Optionally limit to a date or date range.',
    input_schema: {
      type: 'object',
      properties: {
        coach_user_id: { type: 'number', description: 'User ID of the coach' },
        date_from:     { type: 'string', description: 'YYYY-MM-DD — only cancel from this date (optional)' },
        date_to:       { type: 'string', description: 'YYYY-MM-DD — only cancel up to this date (optional)' },
      },
      required: ['coach_user_id'],
    },
  },
  {
    name: 'add_balance_to_coach_students',
    description: 'Add coaching balance to all students of a specific coach.',
    input_schema: {
      type: 'object',
      properties: {
        coach_user_id: { type: 'number', description: 'User ID of the coach' },
        amount:        { type: 'number', description: 'Dollar amount to add' },
        note:          { type: 'string', description: 'Reason or note (optional)' },
      },
      required: ['coach_user_id', 'amount'],
    },
  },
  {
    name: 'message_all_members',
    description: 'Send a private message to every club member individually.',
    input_schema: {
      type: 'object',
      properties: {
        body: { type: 'string', description: 'Message text to send to every member' },
      },
      required: ['body'],
    },
  },
  {
    name: 'notify_low_balance',
    description: 'Send a private message to all members whose coaching balance is below a threshold.',
    input_schema: {
      type: 'object',
      properties: {
        threshold: { type: 'number', description: 'Members with balance below this amount will be notified' },
        message:   { type: 'string', description: 'Custom message to send (optional — a default reminder is used if omitted)' },
      },
      required: ['threshold'],
    },
  },
  // ── Reports ──
  {
    name: 'get_dashboard_stats',
    description: 'Get overall club statistics: member count, booking count, tournament count.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_payment_report',
    description: 'Get coaching payment report for a period.',
    input_schema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'YYYY-MM-DD' },
        to:   { type: 'string', description: 'YYYY-MM-DD' },
      },
      required: ['from', 'to'],
    },
  },
]

// ── Tool executor ─────────────────────────────────────────────────────────────

async function executeTool(name, input, clubId, adminId) {
  const bcrypt = require('bcryptjs')

  switch (name) {

    // ── Members ──────────────────────────────────────────────────────────────

    case 'list_members': {
      let q = `SELECT id, name, email, role FROM users WHERE club_id=$1 AND is_walkin IS NOT TRUE`
      const params = [clubId]
      if (input.search) { q += ` AND name ILIKE $${params.length+1}`; params.push(`%${input.search}%`) }
      if (input.role)   { q += ` AND role=$${params.length+1}`;       params.push(input.role) }
      q += ' ORDER BY name LIMIT 50'
      const { rows } = await pool.query(q, params)
      return rows.length ? rows.map(r => `${r.id}: ${r.name} (${r.role}) — ${r.email}`).join('\n')
                         : 'No members found.'
    }

    case 'create_member': {
      const hash = await bcrypt.hash(input.password, 12)
      try {
        const { rows } = await pool.query(
          `INSERT INTO users (name, email, password_hash, phone, club_id)
           VALUES ($1,$2,$3,$4,$5) RETURNING id, name, email`,
          [input.name.trim(), input.email.toLowerCase().trim(), hash, input.phone?.trim() || null, clubId]
        )
        return `✅ Member created: ${rows[0].name} (ID ${rows[0].id}) — ${rows[0].email}`
      } catch (err) {
        if (err.code === '23505') return '❌ An account with that email already exists.'
        throw err
      }
    }

    case 'update_member': {
      const updates = [], values = []
      if (input.name?.trim())  { updates.push(`name=$${values.length+1}`);  values.push(input.name.trim()) }
      if (input.email?.trim()) { updates.push(`email=$${values.length+1}`); values.push(input.email.toLowerCase().trim()) }
      if (!updates.length) return '❌ Nothing to update — provide name or email.'
      values.push(input.user_id, clubId)
      try {
        const { rows } = await pool.query(
          `UPDATE users SET ${updates.join(', ')} WHERE id=$${values.length-1} AND club_id=$${values.length} RETURNING name, email`,
          values
        )
        return rows.length ? `✅ Updated: ${rows[0].name} — ${rows[0].email}` : '❌ Member not found.'
      } catch (err) {
        if (err.code === '23505') return '❌ That email is already in use.'
        throw err
      }
    }

    case 'delete_member': {
      if (String(input.user_id) === String(adminId)) return '❌ Cannot delete your own account.'
      const { rows: u } = await pool.query(`SELECT name FROM users WHERE id=$1 AND club_id=$2`, [input.user_id, clubId])
      if (!u.length) return '❌ Member not found.'
      try {
        await pool.query(`DELETE FROM users WHERE id=$1 AND club_id=$2`, [input.user_id, clubId])
        return `✅ Deleted member: ${u[0].name}`
      } catch (err) {
        if (err.code === '23503') return '❌ Cannot delete: member has linked records (bookings, sessions, etc.).'
        throw err
      }
    }

    // ── Coaching ─────────────────────────────────────────────────────────────

    case 'get_member_balance': {
      const { rows } = await pool.query(
        `SELECT COALESCE(SUM(delta),0) AS balance FROM coaching_hour_ledger WHERE user_id=$1 AND club_id=$2`,
        [input.user_id, clubId]
      )
      const { rows: u } = await pool.query(`SELECT name FROM users WHERE id=$1`, [input.user_id])
      const uname = u[0]?.name ?? `User ${input.user_id}`
      return `${uname}'s coaching balance: $${Number(rows[0].balance).toFixed(2)}`
    }

    case 'add_balance': {
      const { rows: u } = await pool.query(`SELECT name FROM users WHERE id=$1`, [input.user_id])
      const uname = u[0]?.name ?? `User ${input.user_id}`
      await pool.query(
        `INSERT INTO coaching_hour_ledger (user_id, delta, note, created_by, club_id) VALUES ($1,$2,$3,$4,$5)`,
        [input.user_id, input.amount, input.note ?? 'Added by admin', adminId, clubId]
      )
      return `✅ Added $${input.amount} to ${uname}'s balance.`
    }

    case 'add_balance_all': {
      const { rows: members } = await pool.query(
        `SELECT id FROM users WHERE club_id=$1 AND is_walkin IS NOT TRUE AND role='member'`,
        [clubId]
      )
      if (!members.length) return '❌ No members found.'
      const note = input.note ?? 'Bulk top-up by admin'
      await Promise.all(members.map(m =>
        pool.query(
          `INSERT INTO coaching_hour_ledger (user_id, delta, note, created_by, club_id) VALUES ($1,$2,$3,$4,$5)`,
          [m.id, input.amount, note, adminId, clubId]
        )
      ))
      return `✅ Added $${input.amount} to all ${members.length} members' balances.`
    }

    case 'list_coaches': {
      // Merge coaches table (has bio/availability) with users who have role='coach'
      const { rows } = await pool.query(
        `SELECT
           co.id        AS coach_id,
           COALESCE(co.name, u.name) AS name,
           u.id         AS user_id,
           u.email
         FROM users u
         LEFT JOIN coaches co ON co.user_id = u.id AND co.club_id = $1
         WHERE u.role = 'coach' AND u.club_id = $1 AND u.is_walkin IS NOT TRUE
         ORDER BY COALESCE(co.name, u.name)`,
        [clubId]
      )
      return rows.length
        ? rows.map(r => `${r.name} — user ID ${r.user_id}${r.coach_id ? `, coach ID ${r.coach_id}` : ' (no coach profile yet)'} — ${r.email}`).join('\n')
        : 'No coaches found.'
    }

    case 'list_sessions': {
      // Resolve coach_user_id → coach_id if needed
      let resolvedCoachId = input.coach_id
      if (!resolvedCoachId && input.coach_user_id) {
        const { rows: cr } = await pool.query(
          `SELECT id FROM coaches WHERE user_id=$1 AND club_id=$2`, [input.coach_user_id, clubId]
        )
        resolvedCoachId = cr[0]?.id ?? null
      }
      let q = `SELECT cs.id, cs.date, cs.start_time, cs.end_time, cs.status, cs.group_id,
                      u.name AS student_name, co.name AS coach_name
               FROM coaching_sessions cs
               JOIN users u ON u.id=cs.student_id
               JOIN coaches co ON co.id=cs.coach_id
               WHERE cs.club_id=$1`
      const params = [clubId]
      if (input.date_from)   { q += ` AND cs.date >= $${params.length+1}`; params.push(input.date_from) }
      if (input.date_to)     { q += ` AND cs.date <= $${params.length+1}`; params.push(input.date_to) }
      if (input.student_id)  { q += ` AND cs.student_id=$${params.length+1}`; params.push(input.student_id) }
      if (resolvedCoachId)   { q += ` AND cs.coach_id=$${params.length+1}`; params.push(resolvedCoachId) }
      if (input.status)      { q += ` AND cs.status=$${params.length+1}`; params.push(input.status) }
      else                   { /* no status filter — return all statuses */ }
      q += ' ORDER BY cs.date, cs.start_time LIMIT 50'
      const { rows } = await pool.query(q, params)
      if (!rows.length) return 'No sessions found.'
      // Group sessions by group_id so group lessons appear as one entry
      const grouped = []
      const seen = new Map()
      for (const r of rows) {
        if (r.group_id) {
          const key = r.group_id
          if (seen.has(key)) {
            seen.get(key).students.push(r.student_name)
            seen.get(key).ids.push(r.id)
          } else {
            const entry = { ids: [r.id], date: r.date, start_time: r.start_time, end_time: r.end_time, status: r.status, coach_name: r.coach_name, students: [r.student_name], group_id: key }
            seen.set(key, entry)
            grouped.push(entry)
          }
        } else {
          grouped.push({ ids: [r.id], date: r.date, start_time: r.start_time, end_time: r.end_time, status: r.status, coach_name: r.coach_name, students: [r.student_name], group_id: null })
        }
      }
      return grouped.map(r => {
        const idStr = r.ids.length > 1 ? `[${r.ids.join(',')}]` : `[${r.ids[0]}]`
        const studentStr = r.students.length > 1 ? `${r.students.join(' & ')} (group)` : r.students[0]
        return `${idStr} ${fmtDate(r.date)} ${fmtTime(r.start_time)}–${fmtTime(r.end_time)} | ${studentStr} w/ Coach ${r.coach_name} (${r.status})`
      }).join('\n')
    }

    case 'create_session': {
      // Resolve coach: prefer coach_id, else look up by coach_user_id, else auto-create coach profile
      let coachId = input.coach_id
      let coachName = null
      if (!coachId && input.coach_user_id) {
        const { rows: cr } = await pool.query(
          `SELECT id, name FROM coaches WHERE user_id=$1 AND club_id=$2`, [input.coach_user_id, clubId]
        )
        if (cr[0]) {
          coachId = cr[0].id
          coachName = cr[0].name
        } else {
          const { rows: ur } = await pool.query(`SELECT name FROM users WHERE id=$1`, [input.coach_user_id])
          if (!ur[0]) return '❌ Coach user not found.'
          const { rows: newCoach } = await pool.query(
            `INSERT INTO coaches (user_id, name, club_id) VALUES ($1,$2,$3) RETURNING id, name`,
            [input.coach_user_id, ur[0].name, clubId]
          )
          coachId = newCoach[0].id
          coachName = newCoach[0].name
        }
      }
      if (!coachId) return '❌ Provide coach_id or coach_user_id.'
      // Open hours check
      const schedErr = await checkOpenHours(input.date, input.start_time, input.end_time, clubId)
      if (schedErr) return `❌ ${schedErr}`
      // Coach conflict check
      const { rows: coachBusy } = await pool.query(
        `SELECT u.name AS student_name, cs.start_time, cs.end_time FROM coaching_sessions cs
         JOIN users u ON u.id = cs.student_id
         WHERE cs.coach_id=$1 AND cs.date=$2 AND cs.status='confirmed' AND cs.club_id=$3
           AND cs.start_time < $5::time AND cs.end_time > $4::time LIMIT 1`,
        [coachId, input.date, clubId, input.start_time, input.end_time]
      )
      if (coachBusy.length) {
        if (!coachName) { const { rows: c } = await pool.query(`SELECT name FROM coaches WHERE id=$1`, [coachId]); coachName = c[0]?.name }
        return `❌ Conflict: ${coachName} already has a session with ${coachBusy[0].student_name} at ${fmtTime(coachBusy[0].start_time)}–${fmtTime(coachBusy[0].end_time)} on ${fmtDate(input.date)}.`
      }
      // Coach booking + social conflict
      const { rows: [coachRow] } = await pool.query(`SELECT user_id FROM coaches WHERE id=$1 AND club_id=$2`, [coachId, clubId])
      const coachUserId = coachRow?.user_id
      if (coachUserId) {
        const { rows: cBook } = await pool.query(
          `SELECT 1 FROM bookings WHERE user_id=$1 AND date=$2 AND status='confirmed' AND club_id=$3
             AND start_time < $5::time AND end_time > $4::time LIMIT 1`,
          [coachUserId, input.date, clubId, input.start_time, input.end_time]
        )
        if (cBook.length) return `❌ Conflict: Coach ${coachName} has a court booking at that time on ${fmtDate(input.date)}.`
        const { rows: cSocial } = await pool.query(
          `SELECT 1 FROM social_play_sessions sps JOIN social_play_participants spp ON spp.session_id=sps.id
           WHERE spp.user_id=$1 AND sps.date=$2 AND sps.status='open' AND sps.club_id=$3
             AND sps.start_time < $5::time AND sps.end_time > $4::time LIMIT 1`,
          [coachUserId, input.date, clubId, input.start_time, input.end_time]
        )
        if (cSocial.length) return `❌ Conflict: Coach ${coachName} is in a social play session at that time on ${fmtDate(input.date)}.`
      }
      // Student conflict check (coaching + booking + social)
      const { rows: stdBusy } = await pool.query(
        `SELECT 1 FROM coaching_sessions WHERE student_id=$1 AND date=$2 AND status='confirmed' AND club_id=$3
           AND start_time < $5::time AND end_time > $4::time LIMIT 1`,
        [input.student_id, input.date, clubId, input.start_time, input.end_time]
      )
      if (stdBusy.length) return `❌ Student already has another coaching session at that time on ${fmtDate(input.date)}.`
      const { rows: stdBook } = await pool.query(
        `SELECT 1 FROM bookings WHERE user_id=$1 AND date=$2 AND status='confirmed' AND club_id=$3
           AND start_time < $5::time AND end_time > $4::time LIMIT 1`,
        [input.student_id, input.date, clubId, input.start_time, input.end_time]
      )
      if (stdBook.length) return `❌ Student already has a court booking at that time on ${fmtDate(input.date)}.`
      const { rows: stdSocial } = await pool.query(
        `SELECT 1 FROM social_play_sessions sps JOIN social_play_participants spp ON spp.session_id=sps.id
         WHERE spp.user_id=$1 AND sps.date=$2 AND sps.status='open' AND sps.club_id=$3
           AND sps.start_time < $5::time AND sps.end_time > $4::time LIMIT 1`,
        [input.student_id, input.date, clubId, input.start_time, input.end_time]
      )
      if (stdSocial.length) return `❌ Student is signed up for social play at that time on ${fmtDate(input.date)}.`
      // Court availability (peak concurrent per 30-min sub-slot)
      const { maxUsed: csMax, totalCourts: csTotalCourts } = await maxConcurrentCourts(pool, input.date, input.start_time, input.end_time, clubId)
      if (csMax >= csTotalCourts) return `❌ All ${csTotalCourts} courts are fully booked at ${fmtTime(input.start_time)}–${fmtTime(input.end_time)} on ${fmtDate(input.date)}.`
      const { rows: inserted } = await pool.query(
        `INSERT INTO coaching_sessions (coach_id, student_id, date, start_time, end_time, status, club_id)
         VALUES ($1,$2,$3,$4,$5,'confirmed',$6) RETURNING id`,
        [coachId, input.student_id, input.date, input.start_time, input.end_time, clubId]
      )
      const { rows: u } = await pool.query(`SELECT name FROM users WHERE id=$1`, [input.student_id])
      if (!coachName) {
        const { rows: co } = await pool.query(`SELECT name FROM coaches WHERE id=$1`, [coachId])
        coachName = co[0]?.name
      }
      return `✅ Session created (ID ${inserted[0].id}): ${coachName} teaching ${u[0]?.name} on ${fmtDate(input.date)} ${fmtTime(input.start_time)}–${fmtTime(input.end_time)}.`
    }

    case 'reschedule_session': {
      const { rows: s } = await pool.query(
        `SELECT cs.*, co.name AS coach_name, u.name AS student_name
         FROM coaching_sessions cs
         JOIN coaches co ON co.id=cs.coach_id
         JOIN users u ON u.id=cs.student_id
         WHERE cs.id=$1 AND cs.club_id=$2`,
        [input.session_id, clubId]
      )
      if (!s.length) return `❌ Session ${input.session_id} not found.`
      const sess = s[0]
      const origDate = typeof sess.date === 'string' ? sess.date.slice(0,10) : new Date(sess.date).toISOString().slice(0,10)
      const newDate = input.date ?? origDate

      // For group sessions, collect all sibling session IDs so we can exclude them from conflict checks
      let excludeIds = [input.session_id]
      let groupLabel = sess.student_name
      if (sess.group_id) {
        const { rows: siblings } = await pool.query(
          `SELECT id, u.name AS student_name FROM coaching_sessions cs
           JOIN users u ON u.id = cs.student_id
           WHERE cs.group_id=$1 AND cs.date=$2 AND cs.status='confirmed' AND cs.club_id=$3`,
          [sess.group_id, origDate, clubId]
        )
        excludeIds = siblings.map(r => r.id)
        groupLabel = siblings.map(r => r.student_name).join(', ')
      }

      // Open hours check
      const schedErrR = await checkOpenHours(newDate, input.start_time, input.end_time, clubId)
      if (schedErrR) return `❌ ${schedErrR}`
      // Check coach conflict (exclude all sessions being rescheduled)
      const { rows: coachBusy } = await pool.query(
        `SELECT u.name AS student_name, cs.start_time, cs.end_time FROM coaching_sessions cs
         JOIN users u ON u.id = cs.student_id
         WHERE cs.coach_id=$1 AND cs.date=$2 AND cs.status='confirmed' AND cs.club_id=$3
           AND NOT (cs.id = ANY($6::int[]))
           AND cs.start_time < $5::time AND cs.end_time > $4::time LIMIT 1`,
        [sess.coach_id, newDate, clubId, input.start_time, input.end_time, excludeIds]
      )
      if (coachBusy.length) {
        return `❌ Conflict: Coach ${sess.coach_name} already has a session with ${coachBusy[0].student_name} at ${fmtTime(coachBusy[0].start_time)}–${fmtTime(coachBusy[0].end_time)} on ${fmtDate(newDate)}. Please choose a different time.`
      }
      // Coach booking + social conflict
      const { rows: [coachRowR] } = await pool.query(`SELECT user_id FROM coaches WHERE id=$1 AND club_id=$2`, [sess.coach_id, clubId])
      const coachUserIdR = coachRowR?.user_id
      if (coachUserIdR) {
        const { rows: cBookR } = await pool.query(
          `SELECT 1 FROM bookings WHERE user_id=$1 AND date=$2 AND status='confirmed' AND club_id=$3
             AND start_time < $5::time AND end_time > $4::time LIMIT 1`,
          [coachUserIdR, newDate, clubId, input.start_time, input.end_time]
        )
        if (cBookR.length) return `❌ Conflict: Coach ${sess.coach_name} has a court booking at that time on ${fmtDate(newDate)}.`
        const { rows: cSocialR } = await pool.query(
          `SELECT 1 FROM social_play_sessions sps JOIN social_play_participants spp ON spp.session_id=sps.id
           WHERE spp.user_id=$1 AND sps.date=$2 AND sps.status='open' AND sps.club_id=$3
             AND sps.start_time < $5::time AND sps.end_time > $4::time LIMIT 1`,
          [coachUserIdR, newDate, clubId, input.start_time, input.end_time]
        )
        if (cSocialR.length) return `❌ Conflict: Coach ${sess.coach_name} is in a social play session at that time on ${fmtDate(newDate)}.`
      }
      // Student conflict check (coaching + booking + social, exclude the sessions being rescheduled)
      const { rows: stdBusyR } = await pool.query(
        `SELECT 1 FROM coaching_sessions WHERE student_id=$1 AND date=$2 AND status='confirmed' AND club_id=$3
           AND NOT (id = ANY($6::int[])) AND start_time < $5::time AND end_time > $4::time LIMIT 1`,
        [sess.student_id, newDate, clubId, input.start_time, input.end_time, excludeIds]
      )
      if (stdBusyR.length) return `❌ ${sess.student_name} already has another coaching session at that time on ${fmtDate(newDate)}.`
      const { rows: stdBookR } = await pool.query(
        `SELECT 1 FROM bookings WHERE user_id=$1 AND date=$2 AND status='confirmed' AND club_id=$3
           AND start_time < $5::time AND end_time > $4::time LIMIT 1`,
        [sess.student_id, newDate, clubId, input.start_time, input.end_time]
      )
      if (stdBookR.length) return `❌ ${sess.student_name} already has a court booking at that time on ${fmtDate(newDate)}.`
      const { rows: stdSocialR } = await pool.query(
        `SELECT 1 FROM social_play_sessions sps JOIN social_play_participants spp ON spp.session_id=sps.id
         WHERE spp.user_id=$1 AND sps.date=$2 AND sps.status='open' AND sps.club_id=$3
           AND sps.start_time < $5::time AND sps.end_time > $4::time LIMIT 1`,
        [sess.student_id, newDate, clubId, input.start_time, input.end_time]
      )
      if (stdSocialR.length) return `❌ ${sess.student_name} is signed up for social play at that time on ${fmtDate(newDate)}.`
      // Court availability (peak concurrent per 30-min sub-slot, exclude all sessions being moved)
      const { maxUsed: rsMax, totalCourts: rsTotalCourts } = await maxConcurrentCourts(pool, newDate, input.start_time, input.end_time, clubId, excludeIds)
      if (rsMax >= rsTotalCourts) return `❌ All ${rsTotalCourts} courts are fully booked at ${fmtDate(newDate)} ${fmtTime(input.start_time)}–${fmtTime(input.end_time)}.`
      // Update — for group sessions update all members on the same original date
      if (sess.group_id) {
        await pool.query(
          `UPDATE coaching_sessions SET date=$1, start_time=$2, end_time=$3, court_id=NULL
           WHERE group_id=$4 AND date=$5 AND status='confirmed' AND club_id=$6`,
          [newDate, input.start_time, input.end_time, sess.group_id, origDate, clubId]
        )
      } else {
        await pool.query(
          `UPDATE coaching_sessions SET date=$1, start_time=$2, end_time=$3, court_id=NULL WHERE id=$4`,
          [newDate, input.start_time, input.end_time, input.session_id]
        )
      }
      const groupNote = sess.group_id ? ` (group session — all ${excludeIds.length} students updated)` : ''
      return `✅ SUCCESS: Session ${input.session_id} for ${groupLabel} with Coach ${sess.coach_name} has been rescheduled to ${fmtDate(newDate)} ${fmtTime(input.start_time)}–${fmtTime(input.end_time)}${groupNote}. The database has been updated.`
    }

    case 'cancel_session': {
      const { rows } = await pool.query(
        `UPDATE coaching_sessions SET status='cancelled' WHERE id=$1 AND club_id=$2 RETURNING id`,
        [input.session_id, clubId]
      )
      return rows.length ? `✅ Session ${input.session_id} cancelled.` : `❌ Session not found.`
    }

    // ── Leave requests ────────────────────────────────────────────────────────

    case 'list_leave_requests': {
      const status = input.status || 'pending'
      const { rows } = await pool.query(
        `SELECT slr.id, slr.status, slr.reason, slr.created_at, slr.expires_at,
                u.name AS student_name,
                cs.date, cs.start_time, cs.end_time,
                co.name AS coach_name
         FROM session_leave_requests slr
         JOIN users u ON u.id = slr.student_id
         JOIN coaching_sessions cs ON cs.id = slr.session_id
         JOIN coaches co ON co.id = cs.coach_id
         WHERE slr.club_id=$1 AND slr.status=$2
         ORDER BY slr.created_at DESC LIMIT 20`,
        [clubId, status]
      )
      if (!rows.length) return `No ${status} leave requests.`
      return rows.map(r =>
        `[ID ${r.id}] ${r.student_name} — ${fmtDate(r.date)} ${fmtTime(r.start_time)}–${fmtTime(r.end_time)} w/ ${r.coach_name}${r.reason ? `\n  Reason: ${r.reason}` : ''}`
      ).join('\n')
    }

    case 'approve_leave_request': {
      const { rows: [lr] } = await pool.query(
        `SELECT slr.*, u.name AS student_name FROM session_leave_requests slr
         JOIN users u ON u.id = slr.student_id
         WHERE slr.id=$1 AND slr.status='pending' AND slr.club_id=$2`,
        [input.request_id, clubId]
      )
      if (!lr) return '❌ Leave request not found or not pending.'
      await pool.query(
        `UPDATE session_leave_requests
         SET status='approved', expires_at=NOW() + INTERVAL '48 hours', resolved_by=$1
         WHERE id=$2`,
        [adminId, input.request_id]
      )
      return `✅ Approved leave request for ${lr.student_name}. Slot options sent to student (48h window).`
    }

    case 'reject_leave_request': {
      const { rows: [lr] } = await pool.query(
        `SELECT slr.*, u.name AS student_name FROM session_leave_requests slr
         JOIN users u ON u.id = slr.student_id
         WHERE slr.id=$1 AND slr.status='pending' AND slr.club_id=$2`,
        [input.request_id, clubId]
      )
      if (!lr) return '❌ Leave request not found or not pending.'
      await pool.query(
        `UPDATE session_leave_requests
         SET status='rejected', resolved_at=NOW(), resolved_by=$1
         WHERE id=$2`,
        [adminId, input.request_id]
      )
      return `✅ Rejected leave request for ${lr.student_name}.`
    }

    // ── Bookings ──────────────────────────────────────────────────────────────

    case 'check_court_availability': {
      const { date, start_time, end_time } = input
      // Peak concurrent courts across each 30-min sub-slot
      const { maxUsed, totalCourts: aiTotalCourts } = await maxConcurrentCourts(pool, date, start_time, end_time, clubId)
      const used = maxUsed
      const free = Math.max(0, aiTotalCourts - used)
      // Fetch breakdown
      const { rows: coaching } = await pool.query(
        `SELECT COALESCE(group_id::text, id::text) AS key,
                MIN(start_time) AS start_time, MAX(end_time) AS end_time,
                string_agg(DISTINCT u.name, ' & ') AS students,
                co.name AS coach_name
         FROM coaching_sessions cs
         JOIN users u ON u.id = cs.student_id
         JOIN coaches co ON co.id = cs.coach_id
         WHERE cs.date=$1 AND cs.status='confirmed' AND cs.club_id=$4
           AND cs.start_time < $3::time AND cs.end_time > $2::time
         GROUP BY COALESCE(cs.group_id::text, cs.id::text), co.name`,
        [date, start_time, end_time, clubId]
      )
      const { rows: bookings } = await pool.query(
        `SELECT u.name AS user_name, MIN(b.start_time) AS start_time, MAX(b.end_time) AS end_time
         FROM bookings b JOIN users u ON u.id=b.user_id
         WHERE b.date=$1 AND b.status='confirmed' AND b.club_id=$4
           AND b.start_time < $3::time AND b.end_time > $2::time
         GROUP BY b.booking_group_id, u.name`,
        [date, start_time, end_time, clubId]
      )
      const { rows: social } = await pool.query(
        `SELECT title, num_courts, start_time, end_time
         FROM social_play_sessions
         WHERE date=$1 AND status='open' AND club_id=$4
           AND start_time < $3::time AND end_time > $2::time`,
        [date, start_time, end_time, clubId]
      )
      const lines = [
        `${fmtDate(date)} ${fmtTime(start_time)}–${fmtTime(end_time)}: ${used}/${aiTotalCourts} courts used, ${free}/${aiTotalCourts} free.`,
      ]
      if (coaching.length) {
        lines.push('Coaching sessions:')
        coaching.forEach(r => lines.push(`  • ${r.students} w/ Coach ${r.coach_name} (${fmtTime(r.start_time)}–${fmtTime(r.end_time)})`))
      }
      if (bookings.length) {
        lines.push('Court bookings:')
        bookings.forEach(r => lines.push(`  • ${r.user_name} (${fmtTime(r.start_time)}–${fmtTime(r.end_time)})`))
      }
      if (social.length) {
        lines.push('Social play:')
        social.forEach(r => lines.push(`  • ${r.title} — ${r.num_courts} court(s) (${fmtTime(r.start_time)}–${fmtTime(r.end_time)})`))
      }
      return lines.join('\n')
    }

    case 'list_bookings': {
      const date = input.date || todaySydney()
      let q = `SELECT b.booking_group_id, b.court_id, b.date, b.user_id,
                      MIN(b.start_time) AS start_time, MAX(b.end_time) AS end_time,
                      b.status, u.name AS user_name, c.name AS court_name
               FROM bookings b
               JOIN users u ON u.id = b.user_id
               LEFT JOIN courts c ON c.id = b.court_id
               WHERE b.status='confirmed' AND b.club_id=$1 AND b.date=$2`
      const params = [clubId, date]
      if (input.search) { q += ` AND u.name ILIKE $${params.length+1}`; params.push(`%${input.search}%`) }
      q += ' GROUP BY b.booking_group_id, b.court_id, b.date, b.user_id, b.status, u.name, c.name ORDER BY MIN(b.start_time)'
      const { rows } = await pool.query(q, params)
      if (!rows.length) return `No bookings on ${fmtDate(date)}.`
      return rows.map(r =>
        `${r.user_name} — ${r.court_name} ${fmtTime(r.start_time)}–${fmtTime(r.end_time)} [group: ${r.booking_group_id}]`
      ).join('\n')
    }

    case 'cancel_booking': {
      const { rows } = await pool.query(
        `SELECT user_id FROM bookings WHERE booking_group_id=$1 AND status='confirmed' AND club_id=$2 LIMIT 1`,
        [input.booking_group_id, clubId]
      )
      if (!rows.length) return '❌ Booking not found.'
      const { rows: u } = await pool.query(`SELECT name FROM users WHERE id=$1`, [rows[0].user_id])
      await pool.query(
        `UPDATE bookings SET status='cancelled' WHERE booking_group_id=$1 AND club_id=$2`,
        [input.booking_group_id, clubId]
      )
      return `✅ Booking for ${u[0]?.name ?? 'member'} cancelled.`
    }

    case 'reschedule_booking': {
      // Fetch all slots for this booking group
      const { rows: bRows } = await pool.query(
        `SELECT b.*, u.name AS user_name
         FROM bookings b JOIN users u ON u.id=b.user_id
         WHERE b.booking_group_id=$1 AND b.status='confirmed' AND b.club_id=$2
         ORDER BY b.start_time`,
        [input.booking_group_id, clubId]
      )
      if (!bRows.length) return '❌ Booking not found.'
      const bk = bRows[0]
      const origDate = typeof bk.date === 'string' ? bk.date.slice(0,10) : new Date(bk.date).toISOString().slice(0,10)
      const newDate  = input.date ?? origDate

      // Compute new times: keep same duration if end_time not provided
      function toMinsAI(t) { const [h,m] = t.substring(0,5).split(':').map(Number); return h*60+m }
      function minsToTimeAI(mins) { return `${String(Math.floor(mins/60)).padStart(2,'0')}:${String(mins%60).padStart(2,'0')}:00` }
      const origDurMins = toMinsAI(bRows[bRows.length-1].end_time) - toMinsAI(bRows[0].start_time)
      const newStart    = input.start_time
      const newStartMins = toMinsAI(newStart)
      const newEndMins  = input.end_time ? toMinsAI(input.end_time) : newStartMins + origDurMins
      const newEnd      = input.end_time ?? minsToTimeAI(newEndMins)

      if (newEndMins <= newStartMins || (newEndMins - newStartMins) < 30 || (newEndMins - newStartMins) % 30 !== 0)
        return '❌ Invalid duration. Must be at least 30 minutes and a multiple of 30.'

      // Open hours check
      const schedErrBk = await checkOpenHours(newDate, newStart, newEnd, clubId)
      if (schedErrBk) return `❌ ${schedErrBk}`

      // Court availability (exclude the booking being moved)
      const { maxUsed: bkMax, totalCourts: bkTotalCourts } = await maxConcurrentCourts(pool, newDate, newStart, newEnd, clubId)
      if (bkMax >= bkTotalCourts) return `❌ All ${bkTotalCourts} courts are fully booked at ${fmtDate(newDate)} ${fmtTime(newStart)}–${fmtTime(newEnd)}.`

      // Update all slots: cancel old, insert new 30-min slots
      const { randomUUID } = require('crypto')
      const client2 = await pool.connect()
      try {
        await client2.query('BEGIN')
        await client2.query(
          `UPDATE bookings SET status='cancelled' WHERE booking_group_id=$1 AND club_id=$2`,
          [input.booking_group_id, clubId]
        )
        const newGroupId = randomUUID()
        for (let t = newStartMins; t < newEndMins; t += 30) {
          await client2.query(
            `INSERT INTO bookings (user_id, date, start_time, end_time, booking_group_id, payment_intent_id, amount_paid, club_id)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
            [bk.user_id, newDate, minsToTimeAI(t), minsToTimeAI(t+30),
             newGroupId, bk.payment_intent_id, bk.amount_paid, clubId]
          )
        }
        await client2.query('COMMIT')
      } catch(e) {
        await client2.query('ROLLBACK')
        throw e
      } finally { client2.release() }

      return `✅ SUCCESS: Booking for ${bk.user_name} rescheduled to ${fmtDate(newDate)} ${fmtTime(newStart)}–${fmtTime(newEnd)}. The database has been updated.`
    }

    // ── Social Play ───────────────────────────────────────────────────────────

    case 'update_social_session': {
      const updates = [], values = []
      if (input.start_time)  { updates.push(`start_time=$${values.length+1}`);  values.push(input.start_time) }
      if (input.end_time)    { updates.push(`end_time=$${values.length+1}`);    values.push(input.end_time) }
      if (input.title)       { updates.push(`title=$${values.length+1}`);       values.push(input.title) }
      if (input.num_courts)  { updates.push(`num_courts=$${values.length+1}`);  values.push(input.num_courts) }
      if (input.max_players) { updates.push(`max_players=$${values.length+1}`); values.push(input.max_players) }
      if (!updates.length) return '❌ Nothing to update.'
      values.push(input.session_id, clubId)
      const { rows } = await pool.query(
        `UPDATE social_play_sessions SET ${updates.join(', ')} WHERE id=$${values.length-1} AND club_id=$${values.length} RETURNING title, date`,
        values
      )
      return rows.length ? `✅ Updated social session "${rows[0].title}" on ${fmtDate(rows[0].date)}.` : '❌ Session not found.'
    }

    case 'bulk_update_social_sessions': {
      const dayMap = { monday:1, tuesday:2, wednesday:3, thursday:4, friday:5, saturday:6, sunday:0 }
      const dow = dayMap[input.weekday.toLowerCase()]
      if (dow === undefined) return `❌ Invalid weekday: ${input.weekday}`
      const sets = [`start_time=$1`, `end_time=$2`]
      const values = [input.start_time, input.end_time]
      if (input.title)      { sets.push(`title=$${values.length+1}`);      values.push(input.title) }
      if (input.num_courts) { sets.push(`num_courts=$${values.length+1}`); values.push(input.num_courts) }
      values.push(dow, clubId)
      const { rowCount } = await pool.query(
        `UPDATE social_play_sessions
         SET ${sets.join(', ')}
         WHERE EXTRACT(DOW FROM date)=$${values.length-1}
           AND date >= CURRENT_DATE
           AND status = 'open'
           AND club_id=$${values.length}`,
        values
      )
      return rowCount
        ? `✅ Updated ${rowCount} upcoming ${input.weekday} social session${rowCount > 1 ? 's' : ''} to ${fmtTime(input.start_time)}–${fmtTime(input.end_time)}.`
        : `No upcoming ${input.weekday} social sessions found.`
    }

    case 'list_social_sessions': {
      let q = `SELECT s.id, s.title, s.date, s.start_time, s.end_time,
                      s.num_courts, s.max_players, s.status,
                      COUNT(p.user_id)::int AS participant_count
               FROM social_play_sessions s
               LEFT JOIN social_play_participants p ON p.session_id = s.id
               WHERE s.club_id=$1`
      const params = [clubId]
      if (input.date) {
        q += ` AND s.date=$${params.length+1}`; params.push(input.date)
      } else if (!input.include_past) {
        q += ` AND s.date >= CURRENT_DATE`
      }
      q += ' GROUP BY s.id ORDER BY s.date, s.start_time LIMIT 30'
      const { rows } = await pool.query(q, params)
      if (!rows.length) return 'No social play sessions found.'
      return rows.map(r =>
        `[${r.id}] ${fmtDate(r.date)} ${fmtTime(r.start_time)}–${fmtTime(r.end_time)} — ${r.title} | ${r.participant_count}/${r.max_players} players, ${r.num_courts} courts (${r.status})`
      ).join('\n')
    }

    case 'create_social_session': {
      const { rows: inserted } = await pool.query(
        `INSERT INTO social_play_sessions
           (title, description, num_courts, date, start_time, end_time, max_players, created_by, club_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [
          input.title || 'Social Play',
          input.description || null,
          input.num_courts || 2,
          input.date, input.start_time, input.end_time,
          input.max_players || 12,
          adminId, clubId,
        ]
      )
      return `✅ Social session created (ID ${inserted[0].id}): ${input.title || 'Social Play'} on ${fmtDate(input.date)} ${fmtTime(input.start_time)}–${fmtTime(input.end_time)}.`
    }

    case 'cancel_social_session': {
      const { rows } = await pool.query(
        `UPDATE social_play_sessions SET status='cancelled' WHERE id=$1 AND club_id=$2 RETURNING title`,
        [input.session_id, clubId]
      )
      return rows.length ? `✅ Social session "${rows[0].title}" cancelled.` : '❌ Session not found.'
    }

    case 'add_member_to_social': {
      const { rows: u } = await pool.query(`SELECT name FROM users WHERE id=$1`, [input.user_id])
      if (!u.length) return '❌ Member not found.'
      try {
        await pool.query(
          `INSERT INTO social_play_participants (session_id, user_id) VALUES ($1, $2)`,
          [input.session_id, input.user_id]
        )
        return `✅ Added ${u[0].name} to social session ${input.session_id}.`
      } catch (err) {
        if (err.code === '23505') return `❌ ${u[0].name} is already in this session.`
        throw err
      }
    }

    case 'remove_member_from_social': {
      const { rows: u } = await pool.query(`SELECT name FROM users WHERE id=$1`, [input.user_id])
      const { rowCount } = await pool.query(
        `DELETE FROM social_play_participants WHERE session_id=$1 AND user_id=$2`,
        [input.session_id, input.user_id]
      )
      return rowCount ? `✅ Removed ${u[0]?.name ?? 'member'} from social session ${input.session_id}.`
                      : '❌ Participant not found in this session.'
    }

    // ── Tournaments ───────────────────────────────────────────────────────────

    case 'list_tournaments': {
      const { rows } = await pool.query(
        `SELECT t.id, t.name, t.date, t.format, t.status, t.max_participants,
                t.prize, COUNT(tr.id)::int AS registered
         FROM tournaments t
         LEFT JOIN tournament_registrations tr ON tr.tournament_id = t.id
         WHERE t.club_id=$1
         GROUP BY t.id ORDER BY t.date DESC LIMIT 20`,
        [clubId]
      )
      if (!rows.length) return 'No tournaments found.'
      return rows.map(r =>
        `[${r.id}] ${r.name} — ${fmtDate(r.date)} | ${r.format} | ${r.registered}/${r.max_participants} registered (${r.status})${r.prize ? ` | Prize: ${r.prize}` : ''}`
      ).join('\n')
    }

    case 'create_tournament': {
      const { rows } = await pool.query(
        `INSERT INTO tournaments (name, date, prize, status, max_participants, format, club_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [
          input.name, input.date, input.prize || null,
          input.status || 'upcoming',
          input.max_participants || 32,
          input.format || 'Singles',
          clubId,
        ]
      )
      return `✅ Tournament created (ID ${rows[0].id}): ${input.name} on ${fmtDate(input.date)}.`
    }

    case 'update_tournament': {
      const { rows: cur } = await pool.query(
        `SELECT * FROM tournaments WHERE id=$1 AND club_id=$2`, [input.tournament_id, clubId]
      )
      if (!cur.length) return '❌ Tournament not found.'
      const t = cur[0]
      await pool.query(
        `UPDATE tournaments SET name=$1, date=$2, prize=$3, status=$4, max_participants=$5, format=$6 WHERE id=$7`,
        [
          input.name ?? t.name,
          input.date ?? t.date,
          input.prize ?? t.prize,
          input.status ?? t.status,
          input.max_participants ?? t.max_participants,
          input.format ?? t.format,
          input.tournament_id,
        ]
      )
      return `✅ Tournament ${input.tournament_id} updated.`
    }

    case 'delete_tournament': {
      const { rows: cur } = await pool.query(
        `SELECT name FROM tournaments WHERE id=$1 AND club_id=$2`, [input.tournament_id, clubId]
      )
      if (!cur.length) return '❌ Tournament not found.'
      await pool.query(`DELETE FROM tournaments WHERE id=$1`, [input.tournament_id])
      return `✅ Tournament "${cur[0].name}" deleted.`
    }

    // ── Venue / Check-ins ─────────────────────────────────────────────────────

    case 'get_venue_checkins': {
      const date = input.date || todaySydney()
      const { rows } = await pool.query(
        `SELECT u.name, vc.checked_in_at, vc.checked_out_at
         FROM venue_checkins vc JOIN users u ON u.id=vc.user_id
         WHERE vc.date=$1 AND vc.club_id=$2 ORDER BY vc.checked_in_at`,
        [date, clubId]
      )
      if (!rows.length) return `No venue check-ins on ${fmtDate(date)}.`
      return `Check-ins for ${fmtDate(date)}:\n` + rows.map(r =>
        `${r.name}: in ${fmtTime(r.checked_in_at)}${r.checked_out_at ? ' → out ' + fmtTime(r.checked_out_at) : ' (still here)'}`
      ).join('\n')
    }

    // ── Announcements ─────────────────────────────────────────────────────────

    case 'list_announcements': {
      const limit = Math.min(input.limit || 10, 30)
      const { rows } = await pool.query(
        `SELECT id, title, body, created_at FROM announcements WHERE club_id=$1 ORDER BY created_at DESC LIMIT $2`,
        [clubId, limit]
      )
      if (!rows.length) return 'No announcements found.'
      return rows.map(r =>
        `[${r.id}] ${fmtDate(r.created_at)} — ${r.title}\n  ${r.body?.substring(0, 100)}${r.body?.length > 100 ? '…' : ''}`
      ).join('\n')
    }

    case 'send_announcement': {
      await pool.query(
        `INSERT INTO announcements (title, body, club_id) VALUES ($1, $2, $3)`,
        [input.title, input.body, clubId]
      )
      return `✅ Announcement sent: "${input.title}"`
    }

    // ── Group sessions ───────────────────────────────────────────────────────

    case 'list_group_sessions': {
      let q = `SELECT cs.group_id, cs.date, cs.start_time, cs.end_time,
                      co.name AS coach_name,
                      array_agg(u.name ORDER BY u.name) AS students,
                      array_agg(cs.id  ORDER BY u.name) AS session_ids
               FROM coaching_sessions cs
               JOIN coaches co ON co.id = cs.coach_id
               JOIN users   u  ON u.id  = cs.student_id
               WHERE cs.status='confirmed' AND cs.club_id=$1 AND cs.group_id IS NOT NULL`
      const params = [clubId]
      if (input.date) {
        q += ` AND cs.date=$${params.length+1}`; params.push(input.date)
      } else if (!input.include_past) {
        q += ` AND cs.date >= CURRENT_DATE`
      }
      q += ` GROUP BY cs.group_id, cs.date, cs.start_time, cs.end_time, co.name
             ORDER BY cs.date, cs.start_time LIMIT 30`
      const { rows } = await pool.query(q, params)
      if (!rows.length) return 'No group sessions found.'
      return rows.map(r =>
        `[group: ${r.group_id.slice(0,8)}…] ${fmtDate(r.date)} ${fmtTime(r.start_time)}–${fmtTime(r.end_time)} | ${r.coach_name} | Students: ${r.students.join(', ')} | Session IDs: ${r.session_ids.join(', ')}`
      ).join('\n')
    }

    case 'merge_into_group': {
      if (!input.session_ids || input.session_ids.length < 2) return '❌ Need at least 2 session IDs to form a group.'
      if (input.session_ids.length > 5) return '❌ Maximum 5 students per group.'
      // Fetch all sessions
      const { rows: sessions } = await pool.query(
        `SELECT cs.*, u.name AS student_name, co.name AS coach_name
         FROM coaching_sessions cs
         JOIN users u ON u.id = cs.student_id
         JOIN coaches co ON co.id = cs.coach_id
         WHERE cs.id = ANY($1) AND cs.club_id=$2 AND cs.status='confirmed'`,
        [input.session_ids, clubId]
      )
      if (sessions.length !== input.session_ids.length) return '❌ One or more sessions not found or not confirmed.'
      // Validate same coach, date, time
      const coach = sessions[0].coach_id
      const date  = typeof sessions[0].date === 'string' ? sessions[0].date.slice(0,10) : new Date(sessions[0].date).toISOString().slice(0,10)
      const start = sessions[0].start_time.slice(0,5)
      const end   = sessions[0].end_time.slice(0,5)
      for (const s of sessions) {
        const sDate = typeof s.date === 'string' ? s.date.slice(0,10) : new Date(s.date).toISOString().slice(0,10)
        if (s.coach_id !== coach) return `❌ All sessions must have the same coach. ${sessions[0].coach_name} ≠ ${s.coach_name}`
        if (sDate !== date)        return `❌ All sessions must be on the same date.`
        if (s.start_time.slice(0,5) !== start || s.end_time.slice(0,5) !== end)
          return `❌ All sessions must have the same time.`
        if (s.group_id) return `❌ Session ${s.id} (${s.student_name}) is already in a group.`
      }
      const { randomUUID } = require('crypto')
      const groupId = randomUUID()
      await pool.query(
        `UPDATE coaching_sessions SET group_id=$1 WHERE id = ANY($2) AND club_id=$3`,
        [groupId, input.session_ids, clubId]
      )
      return `✅ Merged ${sessions.length} sessions into group [${groupId.slice(0,8)}…]:\n${sessions.map(s => `  • ${s.student_name}`).join('\n')}\nDate: ${fmtDate(date)} ${fmtTime(start)}–${fmtTime(end)} with ${sessions[0].coach_name}`
    }

    case 'split_from_group': {
      const { rows: [s] } = await pool.query(
        `SELECT cs.*, u.name AS student_name, co.name AS coach_name
         FROM coaching_sessions cs
         JOIN users u ON u.id = cs.student_id
         JOIN coaches co ON co.id = cs.coach_id
         WHERE cs.id=$1 AND cs.club_id=$2 AND cs.status='confirmed'`,
        [input.session_id, clubId]
      )
      if (!s) return '❌ Session not found.'
      if (!s.group_id) return `❌ Session ${input.session_id} (${s.student_name}) is already a 1-on-1.`
      await pool.query(`UPDATE coaching_sessions SET group_id=NULL WHERE id=$1`, [input.session_id])
      const date = typeof s.date === 'string' ? s.date.slice(0,10) : new Date(s.date).toISOString().slice(0,10)
      return `✅ ${s.student_name}'s session split out from group — now a 1-on-1 with ${s.coach_name} on ${fmtDate(date)} ${fmtTime(s.start_time)}–${fmtTime(s.end_time)}.`
    }

    case 'add_to_group': {
      // Fetch the individual session
      const { rows: [ind] } = await pool.query(
        `SELECT cs.*, u.name AS student_name
         FROM coaching_sessions cs JOIN users u ON u.id = cs.student_id
         WHERE cs.id=$1 AND cs.club_id=$2 AND cs.status='confirmed'`,
        [input.individual_session_id, clubId]
      )
      if (!ind) return '❌ Individual session not found.'
      if (ind.group_id) return `❌ Session ${input.individual_session_id} is already in a group.`
      // Verify target group exists at same time/date/coach
      const { rows: groupSessions } = await pool.query(
        `SELECT cs.*, u.name AS student_name
         FROM coaching_sessions cs JOIN users u ON u.id = cs.student_id
         WHERE cs.group_id=$1 AND cs.club_id=$2 AND cs.status='confirmed' LIMIT 5`,
        [input.group_id, clubId]
      )
      if (!groupSessions.length) return `❌ Group ${input.group_id} not found.`
      if (groupSessions.length >= 5) return '❌ Group already has 5 students (maximum).'
      const g = groupSessions[0]
      const indDate  = typeof ind.date  === 'string' ? ind.date.slice(0,10)  : new Date(ind.date).toISOString().slice(0,10)
      const grpDate  = typeof g.date === 'string' ? g.date.slice(0,10) : new Date(g.date).toISOString().slice(0,10)
      if (ind.coach_id !== g.coach_id) return `❌ Coach mismatch — individual session has a different coach.`
      if (indDate !== grpDate) return `❌ Date mismatch — sessions are on different dates.`
      if (ind.start_time.slice(0,5) !== g.start_time.slice(0,5)) return `❌ Time mismatch — sessions start at different times.`
      // Move individual session into the group
      await pool.query(
        `UPDATE coaching_sessions SET group_id=$1 WHERE id=$2`,
        [input.group_id, input.individual_session_id]
      )
      const allStudents = [...groupSessions.map(s => s.student_name), ind.student_name]
      return `✅ ${ind.student_name} added to group session.\nGroup now: ${allStudents.join(', ')}`
    }

    // ── Bulk operations ──────────────────────────────────────────────────────

    case 'cancel_sessions_on_date': {
      let q = `UPDATE coaching_sessions SET status='cancelled'
               WHERE date=$1 AND status='confirmed' AND club_id=$2`
      const params = [input.date, clubId]
      if (input.coach_id) { q += ` AND coach_id=$${params.length+1}`; params.push(input.coach_id) }
      q += ' RETURNING id'
      const { rows } = await pool.query(q, params)
      return rows.length
        ? `✅ Cancelled ${rows.length} session${rows.length > 1 ? 's' : ''} on ${fmtDate(input.date)}.`
        : `No confirmed sessions found on ${fmtDate(input.date)}.`
    }

    case 'cancel_sessions_in_range': {
      let q = `UPDATE coaching_sessions SET status='cancelled'
               WHERE date BETWEEN $1 AND $2 AND status='confirmed' AND club_id=$3`
      const params = [input.date_from, input.date_to, clubId]
      if (input.coach_id) { q += ` AND coach_id=$${params.length+1}`; params.push(input.coach_id) }
      q += ' RETURNING id'
      const { rows } = await pool.query(q, params)
      return rows.length
        ? `✅ Cancelled ${rows.length} session${rows.length > 1 ? 's' : ''} from ${fmtDate(input.date_from)} to ${fmtDate(input.date_to)}.`
        : `No confirmed sessions found in that range.`
    }

    case 'cancel_social_sessions_on_date': {
      const { rows } = await pool.query(
        `UPDATE social_play_sessions SET status='cancelled'
         WHERE date=$1 AND status='open' AND club_id=$2 RETURNING id`,
        [input.date, clubId]
      )
      return rows.length
        ? `✅ Cancelled ${rows.length} social session${rows.length > 1 ? 's' : ''} on ${fmtDate(input.date)}.`
        : `No open social sessions found on ${fmtDate(input.date)}.`
    }

    case 'cancel_social_sessions_in_range': {
      const { rows } = await pool.query(
        `UPDATE social_play_sessions SET status='cancelled'
         WHERE date BETWEEN $1 AND $2 AND status='open' AND club_id=$3 RETURNING id`,
        [input.date_from, input.date_to, clubId]
      )
      return rows.length
        ? `✅ Cancelled ${rows.length} social session${rows.length > 1 ? 's' : ''} from ${fmtDate(input.date_from)} to ${fmtDate(input.date_to)}.`
        : `No open social sessions found in that range.`
    }

    case 'process_coach_leave': {
      const axios = require('axios')
      // Call the coaching route directly via internal logic
      const { rows: [coach] } = await pool.query(
        `SELECT co.id, co.name FROM coaches co WHERE co.user_id=$1 AND co.club_id=$2`,
        [input.coach_user_id, clubId]
      )
      if (!coach) return '❌ Coach not found. Use list_coaches to verify the user ID.'

      const dateTo = input.date_to || input.date_from
      const { rows: sessions } = await pool.query(
        `SELECT cs.*, u.name AS student_name
         FROM coaching_sessions cs JOIN users u ON u.id = cs.student_id
         WHERE cs.coach_id=$1 AND cs.status='confirmed' AND cs.club_id=$2
           AND cs.date >= $3 AND cs.date <= $4
         ORDER BY cs.date, cs.start_time`,
        [coach.id, clubId, input.date_from, dateTo]
      )
      if (!sessions.length) return `No confirmed sessions found for ${coach.name} in that period.`

      const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString()
      const processed = []

      for (const session of sessions) {
        const { rows: existing } = await pool.query(
          `SELECT 1 FROM session_leave_requests WHERE session_id=$1 AND status IN ('pending','approved') LIMIT 1`,
          [session.id]
        )
        if (existing.length) continue

        const [sh, sm] = session.start_time.slice(0,5).split(':').map(Number)
        const [eh, em] = session.end_time.slice(0,5).split(':').map(Number)
        const durationMins = (eh * 60 + em) - (sh * 60 + sm)

        // Lazy-load getAvailableSlots from coaching route — replicate its DB logic inline
        const { rows: schedule } = await pool.query(
          `SELECT day, start_time, end_time FROM schedule WHERE is_active=TRUE AND club_id=$1`, [clubId]
        )
        const slots = []
        const today = new Date(); today.setHours(0,0,0,0)
        const dayNames = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat']
        for (let d = 1; d <= 14 && slots.length < 20; d++) {
          const date = new Date(today); date.setDate(today.getDate() + d)
          const isoDate = `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`
          const openWindows = schedule.filter(s => s.day === dayNames[date.getDay()])
          for (const win of openWindows) {
            const [wsh,wsm] = win.start_time.slice(0,5).split(':').map(Number)
            const [weh,wem] = win.end_time.slice(0,5).split(':').map(Number)
            let cursor = wsh*60+wsm
            while (cursor + durationMins <= weh*60+wem && slots.length < 20) {
              const ss = `${String(Math.floor(cursor/60)).padStart(2,'0')}:${String(cursor%60).padStart(2,'0')}:00`
              const se = `${String(Math.floor((cursor+durationMins)/60)).padStart(2,'0')}:${String((cursor+durationMins)%60).padStart(2,'0')}:00`
              const { rows: busy } = await pool.query(
                `SELECT 1 FROM coaching_sessions WHERE coach_id=$1 AND date=$2 AND status='confirmed' AND club_id=$3 AND id!=$4 AND start_time<$6::time AND end_time>$5::time LIMIT 1`,
                [coach.id, isoDate, clubId, session.id, ss, se]
              )
              if (busy.length) { cursor += 30; continue }
              // Check court availability (count-based)
              const { rows: [{ total_used }] } = await pool.query(
                `SELECT
                   (SELECT COUNT(DISTINCT COALESCE(group_id::text, id::text)) FROM coaching_sessions WHERE date=$1 AND status='confirmed' AND club_id=$4
                      AND id!=$5 AND start_time<$3::time AND end_time>$2::time) +
                   (SELECT COUNT(DISTINCT booking_group_id) FROM bookings WHERE date=$1 AND status='confirmed' AND club_id=$4
                      AND start_time<$3::time AND end_time>$2::time) +
                   (SELECT COALESCE(SUM(num_courts),0) FROM social_play_sessions WHERE date=$1 AND status='open' AND club_id=$4
                      AND start_time<$3::time AND end_time>$2::time)
                 AS total_used`,
                [isoDate, ss, se, clubId, session.id]
              )
              if (Number(total_used) < 6) slots.push({ date: isoDate, start_time: ss, end_time: se })
              cursor += 30
            }
          }
        }

        const { rows: [lr] } = await pool.query(
          `INSERT INTO session_leave_requests (session_id, student_id, club_id, reason, status, expires_at, resolved_by)
           VALUES ($1,$2,$3,$4,'approved',$5,$6) RETURNING id`,
          [session.id, session.student_id, clubId, input.reason || `${coach.name} leave`, expiresAt, adminId]
        )
        const timeRange = `${fmtTime(session.start_time)} – ${fmtTime(session.end_time)}`
        const msgBody = `📅 Your session with ${coach.name} on ${fmtDate(session.date)} (${timeRange}) has been cancelled due to coach leave.\n\nPlease choose a makeup time within 48 hours:${slots.length === 0 ? '\n\n(No slots found. Please contact us directly.)' : ''}`
        const { rows: [msg] } = await pool.query(
          `INSERT INTO messages (sender_id, recipient_id, body, metadata) VALUES ($1,$2,$3,$4) RETURNING id`,
          [adminId, session.student_id, msgBody, JSON.stringify({ type: 'slot_options', request_id: lr.id, slots, expires_at: expiresAt })]
        )
        await pool.query('INSERT INTO message_reads (message_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [msg.id, adminId])
        await pool.query(`DELETE FROM message_thread_hidden WHERE (user_id=$1 AND other_user_id=$2) OR (user_id=$2 AND other_user_id=$1)`, [adminId, session.student_id])
        processed.push(session.student_name)
      }

      return processed.length
        ? `✅ Processed ${processed.length} session${processed.length > 1 ? 's' : ''} for ${coach.name} (${input.date_from}${dateTo !== input.date_from ? ' to '+dateTo : ''}).\nStudents notified: ${processed.join(', ')}`
        : `All sessions already have pending leave requests.`
    }

    case 'cancel_coach_sessions': {
      const { rows: cr } = await pool.query(
        `SELECT id, name FROM coaches WHERE user_id=$1 AND club_id=$2`, [input.coach_user_id, clubId]
      )
      if (!cr[0]) return '❌ Coach not found.'
      let q = `UPDATE coaching_sessions SET status='cancelled'
               WHERE coach_id=$1 AND status='confirmed' AND club_id=$2 AND date >= CURRENT_DATE`
      const params = [cr[0].id, clubId]
      if (input.date_from) { q += ` AND date >= $${params.length+1}`; params.push(input.date_from) }
      if (input.date_to)   { q += ` AND date <= $${params.length+1}`; params.push(input.date_to) }
      q += ' RETURNING id'
      const { rows } = await pool.query(q, params)
      return rows.length
        ? `✅ Cancelled ${rows.length} upcoming session${rows.length > 1 ? 's' : ''} for ${cr[0].name}.`
        : `No upcoming confirmed sessions found for ${cr[0].name}.`
    }

    case 'add_balance_to_coach_students': {
      const { rows: cr } = await pool.query(
        `SELECT id, name FROM coaches WHERE user_id=$1 AND club_id=$2`, [input.coach_user_id, clubId]
      )
      if (!cr[0]) return '❌ Coach not found.'
      // Get distinct students with at least one confirmed session with this coach
      const { rows: students } = await pool.query(
        `SELECT DISTINCT student_id AS id FROM coaching_sessions
         WHERE coach_id=$1 AND club_id=$2 AND status='confirmed'`,
        [cr[0].id, clubId]
      )
      if (!students.length) return `❌ No students found for ${cr[0].name}.`
      const note = input.note ?? `Top-up for ${cr[0].name}'s students`
      await Promise.all(students.map(s =>
        pool.query(
          `INSERT INTO coaching_hour_ledger (user_id, delta, note, created_by, club_id) VALUES ($1,$2,$3,$4,$5)`,
          [s.id, input.amount, note, adminId, clubId]
        )
      ))
      return `✅ Added $${input.amount} to ${students.length} students of ${cr[0].name}.`
    }

    case 'message_all_members': {
      const { rows: members } = await pool.query(
        `SELECT id FROM users WHERE club_id=$1 AND is_walkin IS NOT TRUE AND role='member'`,
        [clubId]
      )
      if (!members.length) return '❌ No members found.'
      await Promise.all(members.map(m =>
        pool.query(
          `INSERT INTO messages (sender_id, recipient_id, body) VALUES ($1,$2,$3)`,
          [adminId, m.id, input.body]
        )
      ))
      return `✅ Sent message to ${members.length} members.`
    }

    case 'notify_low_balance': {
      const { rows } = await pool.query(
        `SELECT u.id, u.name, COALESCE(SUM(l.delta), 0) AS balance
         FROM users u
         LEFT JOIN coaching_hour_ledger l ON l.user_id = u.id AND l.club_id = $1
         WHERE u.club_id=$1 AND u.role='member' AND u.is_walkin IS NOT TRUE
         GROUP BY u.id, u.name
         HAVING COALESCE(SUM(l.delta), 0) < $2`,
        [clubId, input.threshold]
      )
      if (!rows.length) return `No members have balance below $${input.threshold}.`
      const msg = input.message ?? `⚠️ Your coaching balance is running low ($${input.threshold} threshold). Please top up to continue booking sessions.`
      await Promise.all(rows.map(r =>
        pool.query(
          `INSERT INTO messages (sender_id, recipient_id, body) VALUES ($1,$2,$3)`,
          [adminId, r.id, msg]
        )
      ))
      return `✅ Notified ${rows.length} member${rows.length > 1 ? 's' : ''} with balance below $${input.threshold}:\n` +
        rows.map(r => `  ${r.name}: $${Number(r.balance).toFixed(2)}`).join('\n')
    }

    // ── Reports ───────────────────────────────────────────────────────────────

    case 'get_dashboard_stats': {
      const [members, bookings, tournaments, sessions, social] = await Promise.all([
        pool.query(`SELECT COUNT(*)::int FROM users WHERE role='member' AND club_id=$1 AND is_walkin IS NOT TRUE`, [clubId]),
        pool.query(`SELECT COUNT(*)::int FROM bookings WHERE status='confirmed' AND club_id=$1`, [clubId]),
        pool.query(`SELECT COUNT(*)::int FROM tournaments WHERE club_id=$1`, [clubId]),
        pool.query(`SELECT COUNT(*)::int FROM coaching_sessions WHERE status='confirmed' AND club_id=$1 AND date >= CURRENT_DATE`, [clubId]),
        pool.query(`SELECT COUNT(*)::int FROM social_play_sessions WHERE status='open' AND club_id=$1 AND date >= CURRENT_DATE`, [clubId]),
      ])
      return [
        `Members: ${members.rows[0].count}`,
        `Total confirmed bookings: ${bookings.rows[0].count}`,
        `Tournaments: ${tournaments.rows[0].count}`,
        `Upcoming coaching sessions: ${sessions.rows[0].count}`,
        `Upcoming social play sessions: ${social.rows[0].count}`,
      ].join('\n')
    }

    case 'get_payment_report': {
      const { rows } = await pool.query(
        `SELECT co.name AS coach_name, COUNT(*) AS sessions,
                SUM(EXTRACT(EPOCH FROM (cs.end_time::time - cs.start_time::time))/3600) AS hours
         FROM coaching_sessions cs
         JOIN coaches co ON co.id=cs.coach_id
         WHERE cs.date BETWEEN $1 AND $2 AND cs.status='confirmed' AND cs.club_id=$3
         GROUP BY co.name ORDER BY co.name`,
        [input.from, input.to, clubId]
      )
      if (!rows.length) return 'No sessions in that period.'
      return rows.map(r => `${r.coach_name}: ${r.sessions} sessions, ${Number(r.hours).toFixed(1)} hrs`).join('\n')
    }

    default:
      return `Unknown tool: ${name}`
  }
}

// ── POST /api/ai/chat ─────────────────────────────────────────────────────────

router.post('/chat', requireAuth, requireAdmin, async (req, res) => {
  const { message, history = [] } = req.body
  if (!message?.trim()) return res.status(400).json({ message: 'No message provided.' })

  const clubId  = req.club?.id ?? req.user?.club_id ?? null
  const adminId = req.user.id
  const today   = todaySydney()

  const systemPrompt = `You are an AI assistant exclusively for a table tennis club management system.
Today's date is ${today}.

Your ONLY job is to help the admin manage this club. You have full access to all club features:
- Members: list, create, update, delete members
- Coaching: list/create/reschedule/cancel sessions, manage coach balances, payment reports
- Leave requests: list, approve, reject student leave requests
- Bookings: list court bookings, reschedule bookings, cancel bookings
- Social play: list/create/cancel social sessions, add/remove participants
- Tournaments: list/create/update/delete tournaments
- Venue: view check-in records for any date
- Announcements: list and send announcements
- Stats: dashboard overview

## How to handle requests
- ALWAYS call the appropriate tool first. NEVER answer from memory or assumptions.
- If the admin mentions a name (e.g. "Alex Bai"), call list_members to find their ID — never ask the admin for IDs.
- If the admin says "today's session" or "move to 7", call list_sessions to find the session first, then act on it.
- When looking for a session to reschedule or cancel, ALWAYS call list_sessions with date_from set to today's date so you only see upcoming sessions. Never pick a session from a past date.
- If list_sessions returns multiple upcoming sessions for the same student, list them all and ask the admin which one to change — never guess.
- When list_sessions returns a session labelled "(group)" with multiple students (e.g. "Lucy Sun & Mr Sun (group)"), always present them as ONE entry — never split them into separate rows.
- If a time like "7" or "7pm" is given without AM/PM context, assume PM (19:00) for coaching sessions.
- If the session duration is not specified, keep the same duration as the original session. Do NOT ask the admin to confirm the end time — calculate it yourself and execute immediately.
- Only ask the admin a clarifying question if you genuinely cannot determine the intent after using all relevant tools. Time changes where only the start time is given are NOT ambiguous — use the original duration.

## Confirmation and follow-up turns
- When the admin says "yes", "ok", "correct", "確認", "好", "是" or similar to confirm a pending action you described, you MUST call the relevant tool immediately to execute that action. NEVER generate a success or completion message without first calling the tool and receiving a ✅ result.
- If you described what you are about to do and are waiting for confirmation, treat a "yes" response as the signal to call the tool — not as permission to skip the tool call and fabricate the result.

## Error handling and result reporting
- When a tool returns an ❌ error message, always relay the FULL error text to the admin — never summarize, shorten, or replace it with generic phrases like "could not reschedule". The exact error tells the admin what to fix.
- When a tool returns a ✅ message, you MUST report success to the admin. NEVER say "could not", "failed", or imply failure after a tool returns ✅. If the tool succeeded, the action succeeded — trust the tool result, not your own assumptions.

## CRITICAL — Data integrity
- NEVER fabricate, guess, or invent data. Every name, number, date, and time you mention MUST come directly from a tool result in THIS response — not from earlier conversation turns.
- If a tool returns empty results, say so plainly. Do NOT fill in with example names or hypothetical data.
- If you are unsure whether you have called a tool, call it again rather than guessing.
- When reporting dates and times, copy them EXACTLY as returned by the tool. Do NOT translate or paraphrase day names (e.g. if the tool says "Sat" do not change it).

## Restrictions
- ONLY answer questions or perform actions directly related to managing this club.
- If the admin asks anything unrelated (general knowledge, coding, recipes, weather, personal advice, etc.), respond with exactly: "I can only help with club management tasks."
- Never make exceptions to this rule.

Always respond in the same language the admin uses (English or Traditional Chinese). Keep responses concise.`

  // Keep only the last 10 turns (5 exchanges) to reduce token usage and prevent context contamination
  const recentHistory = history.slice(-10)
  const messages = [
    ...recentHistory.map(h => ({ role: h.role, content: h.content })),
    { role: 'user', content: message },
  ]

  try {
    let response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      temperature: 0,
      system: systemPrompt,
      tools: TOOLS,
      messages,
    })

    console.log(`[ai] stop_reason=${response.stop_reason}`)

    // Agentic loop: keep running tools until stop_reason is 'end_turn'
    while (response.stop_reason === 'tool_use') {
      const assistantMsg = { role: 'assistant', content: response.content }
      const toolResults  = []

      for (const block of response.content) {
        if (block.type !== 'tool_use') continue
        console.log(`[ai] tool_call: ${block.name}`, JSON.stringify(block.input))
        let result
        try {
          result = await executeTool(block.name, block.input, clubId, adminId)
        } catch (toolErr) {
          result = `❌ Tool error: ${toolErr.message}`
          console.error(`[ai] tool_error (${block.name}):`, toolErr.message)
        }
        console.log(`[ai] tool_result (preview): ${String(result).substring(0, 120)}`)
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: result })
      }

      messages.push(assistantMsg)
      messages.push({ role: 'user', content: toolResults })

      response = await client.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 4096,
        temperature: 0,
        system: systemPrompt,
        tools: TOOLS,
        messages,
      })
      console.log(`[ai] stop_reason=${response.stop_reason}`)
    }

    const text = response.content.find(b => b.type === 'text')?.text ?? ''
    res.json({ reply: text })
  } catch (err) {
    console.error('[ai/chat]', err.status ?? '', err.message)
    if (err.status === 429)
      return res.status(429).json({ message: 'Too many requests — please wait a moment and try again.' })
    res.status(500).json({ message: 'AI error: ' + err.message })
  }
})

module.exports = router
