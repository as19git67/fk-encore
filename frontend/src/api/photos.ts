import { apiFetch } from './client'

export interface Photo {
  id: number
  user_id: number
  filename: string
  original_name: string
  mime_type: string
  size: number
  hash?: string
  taken_at?: string
  created_at: string
}

export interface ListPhotosResponse {
  photos: Photo[]
}

export interface DeleteResponse {
  success: boolean
  message: string
}

export function listPhotos() {
  return apiFetch<ListPhotosResponse>('/photos')
}

export async function uploadPhoto(file: File) {
  return apiFetch<Photo>('/photos', {
    method: 'POST',
    body: file,
    headers: {
      'Content-Type': file.type,
      'X-File-Name': file.name
    }
  })
}

export function deletePhoto(id: number) {
  return apiFetch<DeleteResponse>(`/photos/${id}`, {
    method: 'DELETE'
  })
}

export function getPhotoUrl(filename: string) {
  // We need an endpoint to serve the photo. 
  // For now we assume /api/photos/file/:filename exists or will be added.
  return `/api/photos/file/${filename}`
}

export function getPhotosToRefreshMetadata() {
  return apiFetch<{ ids: number[] }>('/photos/refresh-metadata')
}

export function refreshPhotoMetadata(id: number) {
  return apiFetch<{ success: boolean; taken_at?: string }>(`/photos/${id}/refresh-metadata`, {
    method: 'POST'
  })
}
