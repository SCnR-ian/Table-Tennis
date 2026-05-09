import { createContext, useContext, useState, useEffect, useCallback } from 'react'
import { authAPI } from '@/api/api'

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------
const AuthContext = createContext(null)

// ---------------------------------------------------------------------------
// Helper – safely parse JSON from localStorage
// ---------------------------------------------------------------------------
const parseJSON = (str) => {
  try { return JSON.parse(str) } catch { return null }
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------
export function AuthProvider({ children }) {
  const [user, setUser]       = useState(() => parseJSON(localStorage.getItem('user')))
  const [token, setToken]     = useState(() => localStorage.getItem('token'))
  const [loading, setLoading] = useState(false)
  const [error, setError]     = useState(null)

  // On mount: if we have a token, verify it's still valid
  useEffect(() => {
    if (!token) return

    let cancelled = false
    ;(async () => {
      try {
        const { data } = await authAPI.me()
        if (!cancelled) persistUser(data.user, token)
      } catch {
        if (!cancelled) clearAuth()
      }
    })()

    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ---- internal helpers --------------------------------------------------
  const persistUser = (userData, jwt) => {
    localStorage.setItem('token', jwt)
    localStorage.setItem('user', JSON.stringify(userData))
    setToken(jwt)
    setUser(userData)
  }

  const clearAuth = () => {
    localStorage.removeItem('token')
    localStorage.removeItem('user')
    setToken(null)
    setUser(null)
  }

  // ---- public API --------------------------------------------------------
  const login = useCallback(async (credentials) => {
    setLoading(true)
    setError(null)
    try {
      const { data } = await authAPI.login(credentials)
      persistUser(data.user, data.token)
      return { success: true, user: data.user }
    } catch (err) {
      const message = err.response?.data?.message || 'Login failed. Please try again.'
      setError(message)
      return { success: false, message }
    } finally {
      setLoading(false)
    }
  }, [])

  const register = useCallback(async (userData) => {
    setLoading(true)
    setError(null)
    try {
      const { data } = await authAPI.register(userData)
      persistUser(data.user, data.token)
      return { success: true, user: data.user }
    } catch (err) {
      const message = err.response?.data?.message || 'Registration failed. Please try again.'
      setError(message)
      return { success: false, message }
    } finally {
      setLoading(false)
    }
  }, [])

  const logout = useCallback(async () => {
    try { await authAPI.logout() } catch { /* ignore */ }
    clearAuth()
  }, [])

  // Called by OAuthCallbackPage after the backend redirects with ?token=&user=
  const loginWithOAuth = useCallback((userData, jwt) => {
    persistUser(userData, jwt)
  }, [])

  const clearError = useCallback(() => setError(null), [])

  const updateUser = useCallback((partial) => {
    setUser(prev => {
      const updated = { ...prev, ...partial }
      localStorage.setItem('user', JSON.stringify(updated))
      return updated
    })
  }, [])

  // ---- derived state -----------------------------------------------------
  const isAuthenticated = Boolean(token && user)
  const isAdmin         = user?.role === 'admin'

  return (
    <AuthContext.Provider value={{
      user,
      token,
      loading,
      error,
      isAuthenticated,
      isAdmin,
      login,
      register,
      logout,
      loginWithOAuth,
      clearError,
      updateUser,
    }}>
      {children}
    </AuthContext.Provider>
  )
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------
export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within <AuthProvider>')
  return ctx
}
