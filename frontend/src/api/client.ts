const BASE_URL = '/api'

export async function apiFetch<T>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const token = localStorage.getItem('auth_token')

  const headers: Record<string, string> = {
    ...(options.headers as Record<string, string> || {}),
  }

  // Set default content type only if not already specified and body is not binary/form
  if (!headers['Content-Type'] && !(options.body instanceof FormData || options.body instanceof Blob || options.body instanceof File)) {
    headers['Content-Type'] = 'application/json'
  }

  if (token) {
    headers['Authorization'] = `Bearer ${token}`
  }

  const response = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers,
  })

  if (response.status === 401) {
    localStorage.removeItem('auth_token')
    localStorage.removeItem('auth_user')
    window.location.href = '/login'
    throw new Error('Unauthorized')
  }

  if (!response.ok) {
    const body = await response.json().catch(() => ({}))
    throw new Error(body.message || body.code || `Request failed: ${response.status}`)
  }

  return response.json()
}

