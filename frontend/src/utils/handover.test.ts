import { describe, expect, it } from 'vitest'
import { parseHandoverHash } from './handover'

describe('parseHandoverHash', () => {
  it('reads token and redirect from the fragment', () => {
    expect(parseHandoverHash('#token=abcDEF123-_abcDEF123&redirect=%2Ffinanzen%2Fumsaetze%2F9%3Fq%3Dmiete')).toEqual({
      token: 'abcDEF123-_abcDEF123',
      redirect: '/finanzen/umsaetze/9?q=miete',
    })
  })

  it('accepts the fragment without its hash sign', () => {
    expect(parseHandoverHash('token=abcDEF123-_abcDEF123').token).toBe('abcDEF123-_abcDEF123')
  })

  it('rejects what is not a token', () => {
    expect(parseHandoverHash('#token=short').token).toBeNull()
    expect(parseHandoverHash('#token=has%20space%20and%20more%20chars').token).toBeNull()
    expect(parseHandoverHash('#redirect=%2Ffotos').token).toBeNull()
    expect(parseHandoverHash('').token).toBeNull()
  })

  it('trusts only an in-app redirect', () => {
    expect(parseHandoverHash('#redirect=https%3A%2F%2Fevil.test').redirect).toBeNull()
    expect(parseHandoverHash('#redirect=%2F%2Fevil.test').redirect).toBeNull()
    expect(parseHandoverHash('#redirect=%2Flogin').redirect).toBeNull()
    expect(parseHandoverHash('#redirect=%2Fhandover%23token%3Dx').redirect).toBeNull()
    expect(parseHandoverHash('#redirect=%2Ffotos%2Falben%2F3').redirect).toBe('/fotos/alben/3')
    expect(parseHandoverHash('#token=abcDEF123-_abcDEF123').redirect).toBeNull()
  })
})
