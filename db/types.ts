// ========== User Types ==========

export interface User {
  id: number;
  email: string;
  name: string;
  created_at: string;
  updated_at: string;
}

export interface UserRow extends User {
  password_hash: string;
}

export interface CreateUserRequest {
  email: string;
  name: string;
  password: string;
}

export interface UpdateUserRequest {
  id: number;
  email?: string;
  name?: string;
  password?: string;
}

export interface UserWithRoles extends User {
  roles: Role[];
}

// ========== Auth Types ==========

export interface LoginRequest {
  email: string;
  password: string;
}

export interface LoginResponse {
  user: UserWithRoles;
  token: string;
}

export interface LogoutResponse {
  success: boolean;
  message: string;
}

// ========== Role Types ==========

export interface Role {
  id: number;
  name: string;
  description: string;
}

export interface CreateRoleRequest {
  name: string;
  description?: string;
}

export interface UpdateRoleRequest {
  id: number;
  name?: string;
  description?: string;
}

export interface RoleWithUsers extends Role {
  users: User[];
}

// ========== User-Role Types ==========

export interface AssignRoleRequest {
  userId: number;
  roleId: number;
}

export interface UserRolesResponse {
  userId: number;
  roles: Role[];
}

// ========== Generic Responses ==========

export interface ListUsersResponse {
  users: User[];
}

export interface ListRolesResponse {
  roles: Role[];
}

export interface DeleteResponse {
  success: boolean;
  message: string;
}
