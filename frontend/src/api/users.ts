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
}

export interface ListUsersResponse {
  users: UserWithRoles[]
}

export interface DeleteResponse {
  success: boolean
  message: string
}

export function register(email: string, name: string, password: string) {
  return apiFetch<UserWithRoles>('/users', {
    method: 'POST',
    body: JSON.stringify({ email, name, password }),
  })
}

export function login(email: string, password: string) {
  return apiFetch<LoginResponse>('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  })
}

export function logout() {
  return apiFetch<{ success: boolean; message: string }>('/auth/logout', {
    method: 'POST',
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

