import { apiFetch } from './client'
import type { LoginResponse } from './users'

export interface PasskeyInfo {
  credential_id: string
  name: string
  device_type: string
  backed_up: boolean
  created_at: string
}

export interface ListPasskeysResponse {
  passkeys: PasskeyInfo[]
}

export interface ChallengeResponse {
  challengeId: string
  options: any
}

export interface DeleteResponse {
  success: boolean
  message: string
}

export function passkeyRegisterOptions() {
  return apiFetch<ChallengeResponse>('/auth/passkey/register/options', {
    method: 'POST',
  })
}

export function passkeyRegisterVerify(challengeId: string, credential: any, name?: string) {
  return apiFetch<PasskeyInfo>('/auth/passkey/register/verify', {
    method: 'POST',
    body: JSON.stringify({ challengeId, credential, name }),
  })
}

export function passkeyAuthOptions() {
  return apiFetch<ChallengeResponse>('/auth/passkey/login/options', {
    method: 'POST',
  })
}

export function passkeyAuthVerify(challengeId: string, credential: any) {
  return apiFetch<LoginResponse>('/auth/passkey/login/verify', {
    method: 'POST',
    body: JSON.stringify({ challengeId, credential }),
  })
}

export function listPasskeys() {
  return apiFetch<ListPasskeysResponse>('/auth/passkeys')
}

export function deletePasskey(credentialId: string) {
  return apiFetch<DeleteResponse>(`/auth/passkeys/${encodeURIComponent(credentialId)}`, {
    method: 'DELETE',
  })
}

