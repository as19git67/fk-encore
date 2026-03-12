import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { UserWithRoles } from '../api/users'
import * as usersApi from '../api/users'

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

  async function login(email: string, password: string) {
    const response = await usersApi.login(email, password)
    token.value = response.token
    user.value = response.user
    localStorage.setItem('auth_token', response.token)
    localStorage.setItem('auth_user', JSON.stringify(response.user))
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

  return { user, token, isAuthenticated, loadFromStorage, login, register, logout }
})

