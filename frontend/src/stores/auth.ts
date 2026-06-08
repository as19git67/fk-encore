import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { UserWithRoles } from '../api/users'
import * as usersApi from '../api/users'
import { startAuthentication } from '@simplewebauthn/browser'
import { passkeyAuthOptions, passkeyAuthVerify } from '../api/passkeys'
import { realtimeBus, type RealtimeChannel } from '../composables/useRealtime'

const REALTIME_CHANNELS: RealtimeChannel[] = ['documents', 'photos', 'albums', 'feed', 'scan-queue']

function connectRealtime() {
  realtimeBus.connect({
    channels: REALTIME_CHANNELS,
    getToken: () => localStorage.getItem('auth_token'),
  })
}

export const useAuthStore = defineStore('auth', () => {
  const user = ref<UserWithRoles | null>(null)
  const token = ref<string | null>(null)

  const isAuthenticated = computed(() => !!token.value)

  function loadFromStorage() {
    const storedToken = localStorage.getItem('auth_token')
    const storedUser = localStorage.getItem('auth_user')
    if (storedToken && storedUser) {
      token.value = storedToken
      try {
        user.value = JSON.parse(storedUser)
      } catch {
        user.value = null
      }
      if (token.value) connectRealtime()
    }
  }

  // Cross-tab sync: pick up token changes made by another tab
  // (refresh rotation, login, or logout) so this tab never works
  // with a stale token.
  if (typeof window !== 'undefined') {
    window.addEventListener('storage', (e) => {
      if (e.key === 'auth_token') {
        if (!e.newValue) {
          // Another tab logged out
          token.value = null
          user.value = null
          realtimeBus.disconnect()
          window.location.href = `${import.meta.env.BASE_URL}login`
        } else if (e.newValue !== token.value) {
          // Another tab refreshed the token
          token.value = e.newValue
          const storedUser = localStorage.getItem('auth_user')
          if (storedUser) {
            try { user.value = JSON.parse(storedUser) } catch { /* keep existing */ }
          }
          connectRealtime()
        }
      }
    })
  }

  function setSession(responseToken: string, responseRefreshToken: string, responseUser: UserWithRoles) {
    token.value = responseToken
    user.value = responseUser
    localStorage.setItem('auth_token', responseToken)
    localStorage.setItem('refresh_token', responseRefreshToken)
    localStorage.setItem('auth_user', JSON.stringify(responseUser))
    connectRealtime()
  }

  async function login(email: string, password: string) {
    const response = await usersApi.login(email, password)
    setSession(response.token, response.refreshToken, response.user)
  }

  async function loginWithPasskey() {
    const { challengeId, options } = await passkeyAuthOptions()
    const credential = await startAuthentication({ optionsJSON: options })
    const response = await passkeyAuthVerify(challengeId, credential)
    setSession(response.token, response.refreshToken, response.user)
  }

  async function register(email: string, name: string, password: string) {
    await usersApi.register(email, name, password)
    // Auto-login after registration
    await login(email, password)
  }

  async function logout() {
    try {
      const refreshToken = localStorage.getItem('refresh_token')
      await usersApi.logout(refreshToken ?? undefined)
    } catch {
      // Ignore errors on logout
    }
    token.value = null
    user.value = null
    localStorage.removeItem('auth_token')
    localStorage.removeItem('refresh_token')
    localStorage.removeItem('auth_user')
    // Don't strand the next user on the previous user's last view.
    localStorage.removeItem('app_last_route')
    realtimeBus.disconnect()
  }

  function hasPermission(permission: string): boolean {
    return user.value?.permissions?.includes(permission) ?? false
  }

  return { user, token, isAuthenticated, hasPermission, loadFromStorage, login, loginWithPasskey, register, logout }
})
