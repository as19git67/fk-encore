import { apiFetch } from './client'
import type { Role } from './users'

export interface ListRolesResponse {
  roles: Role[]
}

export interface UserRolesResponse {
  userId: number
  roles: Role[]
}

export interface DeleteResponse {
  success: boolean
  message: string
}

export function listRoles() {
  return apiFetch<ListRolesResponse>('/roles')
}

export function createRole(name: string, description: string = '') {
  return apiFetch<Role>('/roles', {
    method: 'POST',
    body: JSON.stringify({ name, description }),
  })
}

export function deleteRole(id: number) {
  return apiFetch<DeleteResponse>(`/roles/${id}`, {
    method: 'DELETE',
  })
}

export function assignRole(userId: number, roleId: number) {
  return apiFetch<UserRolesResponse>(`/users/${userId}/roles`, {
    method: 'POST',
    body: JSON.stringify({ userId, roleId }),
  })
}

export function removeRole(userId: number, roleId: number) {
  return apiFetch<DeleteResponse>(`/users/${userId}/roles/${roleId}`, {
    method: 'DELETE',
  })
}

