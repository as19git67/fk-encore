import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { UserWithRoles } from '../api/users'
import * as usersApi from '../api/users'
import { startAuthentication } from '@simplewebauthn/browser'
import { passkeyAuthOptions, passkeyAuthVerify } from '../api/passkeys'

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
    }
  }

  function setSession(responseToken: string, responseUser: UserWithRoles) {
    token.value = responseToken
    user.value = responseUser
    localStorage.setItem('auth_token', responseToken)
    localStorage.setItem('auth_user', JSON.stringify(responseUser))
  }

  async function login(email: string, password: string) {
    const response = await usersApi.login(email, password)
    setSession(response.token, response.user)
  }

  async function loginWithPasskey() {
    const { challengeId, options } = await passkeyAuthOptions()
    const credential = await startAuthentication({ optionsJSON: options })
    const response = await passkeyAuthVerify(challengeId, credential)
    setSession(response.token, response.user)
  }

  async function register(email: string, name: string, password: string) {
    await usersApi.register(email, name, password)
    // Auto-login after registration
    await login(email, password)
  }

  async function logout() {
    try {
      await usersApi.logout()
    } catch {
      // Ignore errors on logout
    }
    token.value = null
    user.value = null
    localStorage.removeItem('auth_token')
    localStorage.removeItem('auth_user')
  }

  function hasPermission(permission: string): boolean {
    return user.value?.permissions?.includes(permission) ?? false
  }

  return { user, token, isAuthenticated, hasPermission, loadFromStorage, login, loginWithPasskey, register, logout }
})
