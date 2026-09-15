import { describe, it, expect } from 'vitest'
import { queueOverview, visibleQueues } from './queueOverview'

function holder(...keys: string[]) {
  const held = new Set(keys)
  return (key: string) => held.has(key)
}

describe('visibleQueues', () => {
  it('lists every queue for a user holding all permissions', () => {
    const all = queueOverview.flatMap((q) => q.permissions)
    expect(visibleQueues(holder(...all))).toHaveLength(queueOverview.length)
  })

  it('hides a queue when the module permission is missing', () => {
    const visible = visibleQueues(holder('data.manage', 'documents.view'))
    expect(visible.map((q) => q.id)).toEqual(['documents'])
  })

  it('hides every queue without data.manage, however many modules are enabled', () => {
    expect(visibleQueues(holder('photos.view', 'documents.view', 'module.finance'))).toEqual([])
  })

  it('hides everything for a user holding nothing', () => {
    expect(visibleQueues(holder())).toEqual([])
  })

  it('gives every entry a route and at least one permission', () => {
    for (const q of queueOverview) {
      expect(q.routeName).toBeTruthy()
      expect(q.permissions.length).toBeGreaterThan(0)
    }
  })
})
