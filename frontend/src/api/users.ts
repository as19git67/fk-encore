import { apiFetch } from './client'

export interface User {
  id: number
  email: string
  name: string
  created_at: string
  updated_at: string
}

export interface Role {
  id: number
  name: string
  description: string
}

export interface UserWithRoles extends User {
  roles: Role[]
  permissions: string[]
}

export interface LoginResponse {
  user: UserWithRoles
  token: string
  refreshToken: string
}

export interface ListUsersResponse {
  users: UserWithRoles[]
}

export interface DeleteResponse {
  success: boolean
  message: string
}

export interface Invite {
  id: number
  email: string
  invited_by_user_id: number | null
  created_at: string
  expires_at: string
  accepted_at: string | null
}

/**
 * Redeem an invitation. There is no email argument on purpose — the server
 * takes the address from the invite, so a link issued for one person cannot
 * be used to register another.
 */
export function register(invite: string, name: string, password: string) {
  return apiFetch<UserWithRoles>('/users', {
    method: 'POST',
    body: JSON.stringify({ invite, name, password }),
  })
}

/** Resolve an invite token to the address it was issued for. */
export function checkInvite(token: string) {
  return apiFetch<{ email: string }>(
    `/users/invites/check?token=${encodeURIComponent(token)}`,
  )
}

/** Invite somebody to create an account — requires users.create. */
export function createInvite(email: string) {
  return apiFetch<Invite>('/users/invites', {
    method: 'POST',
    body: JSON.stringify({ email }),
  })
}

export function listInvites() {
  return apiFetch<{ invites: Invite[] }>('/users/invites')
}

export function revokeInvite(id: number) {
  return apiFetch<{ success: boolean }>(`/users/invites/${id}`, { method: 'DELETE' })
}

export function login(email: string, password: string) {
  return apiFetch<LoginResponse>('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  })
}

export function logout(refreshToken?: string) {
  return apiFetch<{ success: boolean; message: string }>('/auth/logout', {
    method: 'POST',
    body: JSON.stringify({ refreshToken }),
  })
}

export function listUsers() {
  return apiFetch<ListUsersResponse>('/users')
}

export function getUser(id: number) {
  return apiFetch<UserWithRoles>(`/users/${id}`)
}

export function updateUser(id: number, data: { email?: string; name?: string; password?: string }) {
  return apiFetch<UserWithRoles>(`/users/${id}`, {
    method: 'PUT',
    body: JSON.stringify({ id, ...data }),
  })
}

export function changePassword(currentPassword: string, newPassword: string) {
  return apiFetch<{ success: boolean }>('/auth/password', {
    method: 'POST',
    body: JSON.stringify({ current_password: currentPassword, new_password: newPassword }),
  })
}

export function deleteUser(id: number) {
  return apiFetch<DeleteResponse>(`/users/${id}`, {
    method: 'DELETE',
  })
}

export function requestPasswordReset(email: string) {
  return apiFetch<{ success: boolean; message: string }>('/auth/request-password-reset', {
    method: 'POST',
    body: JSON.stringify({ email }),
  })
}

export function resetPassword(token: string, newPassword: string) {
  return apiFetch<{ success: boolean; message: string }>('/auth/reset-password', {
    method: 'POST',
    body: JSON.stringify({ token, new_password: newPassword }),
  })
}

