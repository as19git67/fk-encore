import { apiFetch } from './client'
import type { Role } from './users'

export interface Permission {
  id: number
  key: string
  description: string
}

export interface RoleWithPermissions extends Role {
  permissions: Permission[]
}

export interface ListRolesResponse {
  roles: RoleWithPermissions[]
}

export interface ListPermissionsResponse {
  permissions: Permission[]
}

export interface RolePermissionsResponse {
  roleId: number
  permissions: Permission[]
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

export function listPermissions() {
  return apiFetch<ListPermissionsResponse>('/permissions')
}

export function assignPermission(roleId: number, permissionId: number) {
  return apiFetch<RolePermissionsResponse>(`/roles/${roleId}/permissions`, {
    method: 'POST',
    body: JSON.stringify({ roleId, permissionId }),
  })
}

export function revokePermission(roleId: number, permissionId: number) {
  return apiFetch<DeleteResponse>(`/roles/${roleId}/permissions/${permissionId}`, {
    method: 'DELETE',
  })
}

