export function getAlbumCheckState(albumId: number, photoIds: number[], photoAlbumMap: Record<number, number[]>) {
  if (photoIds.length === 0) return false
  
  let count = 0
  photoIds.forEach(pid => {
    if (photoAlbumMap[pid]?.includes(albumId)) {
      count++
    }
  })
  
  if (count === 0) return false
  if (count === photoIds.length) return true
  return null // indeterminate
}

export function getNewPendingAction(
  checked: boolean, 
  originalState: boolean | null
): 'add' | 'remove' | 'delete_pending' {
  if (checked) {
    if (originalState === true) {
      return 'delete_pending';
    } else {
      return 'add';
    }
  } else {
    if (originalState === false) {
      return 'delete_pending';
    } else {
      return 'remove';
    }
  }
}
