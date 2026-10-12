import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useAuth } from '@/context/AuthContext'
import { useClub } from '@/context/ClubContext'

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000/api'

export default function RegisterPage() {
  const { register, loading, error, clearError } = useAuth()
  const { club } = useClub()
  const navigate = useNavigate()

  const [form, setForm]     = useState({ name: '', email: '', password: '', confirmPassword: '' })
  const [errors, setErrors] = useState({})

  const validate = () => {
    const e = {}
    if (!form.name)    e.name    = 'Full name is required'
    if (!form.email)   e.email   = 'Email is required'
    else if (!/\S+@\S+\.\S+/.test(form.email)) e.email = 'Enter a valid email address'
    if (!form.password) e.password = 'Password is required'
    else if (form.password.length < 8) e.password = 'At least 8 characters'
    if (form.password !== form.confirmPassword) e.confirmPassword = 'Passwords do not match'
    return e
  }

  const handleChange = (e) => {
    setForm(f => ({ ...f, [e.target.name]: e.target.value }))
    clearError()
    setErrors(er => ({ ...er, [e.target.name]: '' }))
  }

  const handleSubmit = async (e) => {
    e.preventDefault()
    const v = validate()
    if (Object.keys(v).length) { setErrors(v); return }
    const { confirmPassword, ...payload } = form
    const result = await register(payload)
    if (result.success) {
      navigate('/dashboard', { replace: true })
    }
  }

  const handleGoogle = () => {
    window.location.href = `${API_URL}/auth/google`
  }

  return (
    <div
      className="min-h-screen bg-white flex flex-col items-center justify-center px-4"
      style={{ fontFamily: '"DM Sans", sans-serif' }}
    >
      <div className="w-full max-w-[360px]">

        {/* Logo */}
        <div className="flex justify-center mb-6">
          <div
            className="w-12 h-12 rounded-xl bg-gray-900 flex items-center justify-center text-white text-xl"
            style={{ fontFamily: '"Kanit", sans-serif' }}
          >
            F
          </div>
        </div>

        {/* Heading */}
        <div className="text-center mb-8">
          <h1 className="text-2xl text-gray-900 mb-1" style={{ fontFamily: '"Kanit", sans-serif' }}>
            {club ? `Join ${club.name}` : 'Create your account'}
          </h1>
          <p className="text-gray-400 text-sm">
            Create an account to start booking.
          </p>
        </div>

        {/* Error */}
        {error && (
          <div className="mb-4 px-4 py-3 bg-red-50 border border-red-100 text-red-600 text-sm rounded-xl">
            {error}
          </div>
        )}

        {/* Form */}
        <form onSubmit={handleSubmit} noValidate className="space-y-3">
          <div>
            <input
              name="name"
              type="text"
              placeholder="Full name"
              value={form.name}
              onChange={handleChange}
              className="w-full border border-gray-200 rounded-xl px-4 py-3 text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:border-gray-400 transition-colors"
            />
            {errors.name && <p className="text-xs text-red-500 mt-1">{errors.name}</p>}
          </div>

          <div>
            <input
              name="email"
              type="email"
              placeholder="Email address"
              autoComplete="email"
              value={form.email}
              onChange={handleChange}
              className="w-full border border-gray-200 rounded-xl px-4 py-3 text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:border-gray-400 transition-colors"
            />
            {errors.email && <p className="text-xs text-red-500 mt-1">{errors.email}</p>}
          </div>

          <div>
            <input
              name="password"
              type="password"
              placeholder="Password (min. 8 characters)"
              autoComplete="new-password"
              value={form.password}
              onChange={handleChange}
              className="w-full border border-gray-200 rounded-xl px-4 py-3 text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:border-gray-400 transition-colors"
            />
            {errors.password && <p className="text-xs text-red-500 mt-1">{errors.password}</p>}
          </div>

          <div>
            <input
              name="confirmPassword"
              type="password"
              placeholder="Confirm password"
              autoComplete="new-password"
              value={form.confirmPassword}
              onChange={handleChange}
              className="w-full border border-gray-200 rounded-xl px-4 py-3 text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:border-gray-400 transition-colors"
            />
            {errors.confirmPassword && <p className="text-xs text-red-500 mt-1">{errors.confirmPassword}</p>}
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full bg-[#4b6bfb] hover:bg-[#3a5af0] text-white rounded-xl py-3 text-sm transition-colors disabled:opacity-50"
          >
            {loading ? 'Creating account…' : 'Continue'}
          </button>
        </form>

        {/* Divider */}
        <div className="flex items-center gap-3 my-5">
          <div className="flex-1 h-px bg-gray-100"/>
          <span className="text-xs text-gray-400">or continue with</span>
          <div className="flex-1 h-px bg-gray-100"/>
        </div>

        {/* Google */}
        <button
          type="button"
          onClick={handleGoogle}
          className="w-full flex flex-col items-center gap-2 border border-gray-200 rounded-xl py-4 hover:border-gray-300 hover:bg-gray-50 transition-colors"
        >
          <svg className="w-6 h-6" viewBox="0 0 24 24">
            <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
            <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
            <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
            <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
          </svg>
          <span className="text-sm text-gray-700">Google</span>
        </button>

        {/* Footer */}
        <p className="text-center text-sm text-gray-400 mt-6">
          Already have an account?{' '}
          <Link to="/login" className="text-gray-900 underline underline-offset-2 hover:text-gray-500 transition-colors">
            Log in
          </Link>
        </p>
        <p className="text-center text-xs text-gray-300 mt-6 leading-relaxed">
          By continuing, you agree to our{' '}
          <a href="#" className="underline hover:text-gray-400">Terms</a>
          {' '}and{' '}
          <a href="#" className="underline hover:text-gray-400">Privacy Policy</a>.
        </p>

      </div>
    </div>
  )
}
