import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '@/context/AuthContext'
import { applyClubSubdomain } from '@/api/api'
import api from '@/api/api'

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const DAY_LABELS = { Mon: 'Monday', Tue: 'Tuesday', Wed: 'Wednesday', Thu: 'Thursday', Fri: 'Friday', Sat: 'Saturday', Sun: 'Sunday' }

const defaultSchedule = () => Object.fromEntries(
  DAYS.map(d => [d, { open: d !== 'Sun', from: '09:00', to: '22:00' }])
)

function slugify(str) {
  return str.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30)
}

export default function OnboardingPage() {
  const navigate = useNavigate()
  const [saving, setSaving] = useState(false)
  const [error, setError]   = useState('')
  const [name, setName]         = useState('')
  const [subdomain, setSubdomain] = useState('')
  const [courts, setCourts]     = useState(4)
  const [schedule, setSchedule] = useState(defaultSchedule())

  const handleNameChange = (v) => {
    setName(v)
    setSubdomain(s => (!s || s === slugify(name)) ? slugify(v) : s)
  }

  const toggleDay = (d) =>
    setSchedule(s => ({ ...s, [d]: { ...s[d], open: !s[d].open } }))

  const setTime = (d, field, v) =>
    setSchedule(s => ({ ...s, [d]: { ...s[d], [field]: v } }))

  const submit = async () => {
    if (!name || !subdomain) return
    setSaving(true)
    setError('')
    try {
      const fd = new FormData()
      fd.append('name',     name)
      fd.append('subdomain', subdomain)
      fd.append('courts',   courts)
      fd.append('schedule', JSON.stringify(schedule))
      const { data } = await api.post('/clubs/register', fd)
      applyClubSubdomain(data.club.subdomain)
      navigate('/admin', { replace: true })
    } catch (e) {
      setError(e?.response?.data?.message || 'Something went wrong. Please try again.')
      setSaving(false)
    }
  }

  const canSubmit = name.trim() && subdomain.trim() && courts >= 1

  return (
    <div className="min-h-screen bg-[#fafafa] flex flex-col" style={{ fontFamily: '"DM Sans", sans-serif' }}>

      {/* Header */}
      <div className="bg-white border-b border-gray-100 px-6 py-4">
        <span className="font-bold text-lg tracking-tight" style={{ fontFamily: '"Kanit", sans-serif' }}>Flinther</span>
      </div>

      <div className="flex-1 flex items-start justify-center px-6 py-12">
        <div className="w-full max-w-lg space-y-8">

          <div>
            <h1 className="text-3xl font-black text-gray-900 mb-1" style={{ fontFamily: '"Kanit", sans-serif' }}>
              Set up your club
            </h1>
            <p className="text-gray-400 text-sm">Takes less than a minute.</p>
          </div>

          {/* Club name */}
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">Club name</label>
              <input
                className="w-full border border-gray-200 rounded-xl px-4 py-3 text-sm focus:outline-none focus:border-gray-400 bg-white"
                placeholder="Apex Table Tennis"
                value={name}
                onChange={e => handleNameChange(e.target.value)}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">Club URL</label>
              <div className="flex items-center border border-gray-200 rounded-xl bg-white overflow-hidden focus-within:border-gray-400">
                <span className="px-4 py-3 text-sm text-gray-400 bg-gray-50 border-r border-gray-200 shrink-0">flinther.com/</span>
                <input
                  className="flex-1 px-4 py-3 text-sm focus:outline-none bg-white"
                  placeholder="apex"
                  value={subdomain}
                  onChange={e => setSubdomain(slugify(e.target.value))}
                />
              </div>
            </div>
          </div>

          {/* Courts */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-3">Number of tables</label>
            <div className="flex items-center gap-4">
              <button
                onClick={() => setCourts(c => Math.max(1, c - 1))}
                className="w-10 h-10 rounded-xl border border-gray-200 text-xl hover:bg-gray-50 transition-colors"
              >−</button>
              <span className="text-2xl font-black w-8 text-center" style={{ fontFamily: '"Kanit", sans-serif' }}>{courts}</span>
              <button
                onClick={() => setCourts(c => c + 1)}
                className="w-10 h-10 rounded-xl border border-gray-200 text-xl hover:bg-gray-50 transition-colors"
              >+</button>
            </div>
          </div>

          {/* Schedule */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-3">Opening hours</label>
            <div className="space-y-2">
              {DAYS.map(d => (
                <div key={d} className="flex items-center gap-3">
                  {/* Toggle */}
                  <button
                    onClick={() => toggleDay(d)}
                    className={`w-16 text-xs font-medium py-1.5 rounded-lg transition-colors shrink-0 ${
                      schedule[d].open
                        ? 'bg-gray-900 text-white'
                        : 'bg-gray-100 text-gray-400'
                    }`}
                  >
                    {d}
                  </button>

                  {schedule[d].open ? (
                    <div className="flex items-center gap-2">
                      <input
                        type="time"
                        value={schedule[d].from}
                        onChange={e => setTime(d, 'from', e.target.value)}
                        className="border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:border-gray-400 bg-white"
                      />
                      <span className="text-gray-400 text-sm">–</span>
                      <input
                        type="time"
                        value={schedule[d].to}
                        onChange={e => setTime(d, 'to', e.target.value)}
                        className="border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:border-gray-400 bg-white"
                      />
                    </div>
                  ) : (
                    <span className="text-sm text-gray-300">Closed</span>
                  )}
                </div>
              ))}
            </div>
          </div>

          {error && (
            <p className="text-sm text-red-600 bg-red-50 border border-red-100 px-4 py-3 rounded-xl">{error}</p>
          )}

          <button
            onClick={submit}
            disabled={!canSubmit || saving}
            className="w-full bg-gray-900 text-white py-3.5 rounded-xl font-semibold text-sm hover:bg-black transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {saving ? 'Setting up…' : 'Create club →'}
          </button>

        </div>
      </div>
    </div>
  )
}
