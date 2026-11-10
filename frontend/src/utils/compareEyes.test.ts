import { describe, expect, it } from 'vitest'
import { closedEyesTooltip, closedEyesVerdict, mainFaces, type EyeFace } from './compareEyes'

const face = (over: Partial<EyeFace>): EyeFace => ({
  bbox: { x: 0.4, y: 0.2, width: 0.2, height: 0.25 },
  ignored: false,
  eye_aspect: null,
  eye_aspect_68: null,
  ...over,
})

describe('closedEyesVerdict', () => {
  it('trusts the eyelids over CLIP: open eyes behind glasses get no badge', () => {
    // CLIP scores the open eyes behind glasses far below the laughing partner,
    // the landmarks show them wider open.
    const v = closedEyesVerdict({
      mineFaces: [face({ eye_aspect_68: 0.29, eye_aspect: 0.33 })],
      partnerFaces: [face({ eye_aspect_68: 0.19, eye_aspect: 0.22 })],
      mineClip: 0.38,
      partnerClip: 0.61,
    })
    expect(v.closed).toBe(false)
  })

  it('does not call a laugh with narrowed eyes closed', () => {
    const v = closedEyesVerdict({
      mineFaces: [face({ eye_aspect_68: 0.19 })],
      partnerFaces: [face({ eye_aspect_68: 0.29 })],
      mineClip: 0.61,
      partnerClip: 0.38,
    })
    expect(v.closed).toBe(false)
  })

  it('flags a blink against an open partner', () => {
    const v = closedEyesVerdict({
      mineFaces: [face({ eye_aspect_68: 0.09 })],
      partnerFaces: [face({ eye_aspect_68: 0.28 })],
      mineClip: 0.5,
      partnerClip: 0.5,
    })
    expect(v).toMatchObject({ closed: true, source: 'landmarks' })
    expect(closedEyesTooltip(v)).toContain('32 %')
  })

  it('uses the 106-point ratio when the 68-point one is missing', () => {
    const v = closedEyesVerdict({
      mineFaces: [face({ eye_aspect: 0.1 })],
      partnerFaces: [face({ eye_aspect: 0.3 })],
      mineClip: null,
      partnerClip: null,
    })
    expect(v).toMatchObject({ closed: true, source: 'landmarks' })
  })

  it('compares the same person when both photos know them', () => {
    const background = face({ bbox: { x: 0, y: 0, width: 0.05, height: 0.06 }, eye_aspect_68: 0.08 })
    const v = closedEyesVerdict({
      mineFaces: [background, face({ person_id: 7, bbox: { x: 0.3, y: 0.2, width: 0.04, height: 0.05 }, eye_aspect_68: 0.3 })],
      partnerFaces: [face({ person_id: 7, eye_aspect_68: 0.3 })],
      mineClip: null,
      partnerClip: null,
    })
    expect(v.closed).toBe(false)
  })

  it('ignores faces the user marked as ignored', () => {
    const pair = mainFaces(
      [face({ ignored: true, eye_aspect_68: 0.05 }), face({ bbox: { x: 0, y: 0, width: 0.1, height: 0.1 }, eye_aspect_68: 0.3 })],
      [face({ eye_aspect_68: 0.3 })],
    )
    expect(pair?.[0].eye_aspect_68).toBe(0.3)
  })

  it('falls back to CLIP only when neither photo has landmarks', () => {
    const noEyes = [face({})]
    expect(
      closedEyesVerdict({ mineFaces: noEyes, partnerFaces: noEyes, mineClip: 0.4, partnerClip: 0.6 }),
    ).toMatchObject({ closed: true, source: 'clip' })
    expect(
      closedEyesVerdict({ mineFaces: noEyes, partnerFaces: [face({ eye_aspect_68: 0.3 })], mineClip: 0.4, partnerClip: 0.6 })
        .closed,
    ).toBe(false)
  })

  it('shows nothing while the faces are still loading', () => {
    expect(
      closedEyesVerdict({ mineFaces: undefined, partnerFaces: [], mineClip: 0.3, partnerClip: 0.7 }).closed,
    ).toBe(false)
  })
})
