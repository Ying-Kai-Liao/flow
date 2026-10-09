import { describe, expect, test } from 'bun:test'
import { autoRefused, effectiveMode, labelMode, parseMode, takeDecision } from '../hooks/mergemode'

describe('merge mode rules', () => {
  test('parseMode falls back to auto', () => {
    expect(parseMode('confirm')).toBe('confirm')
    expect(parseMode('auto')).toBe('auto')
    expect(parseMode('whatever')).toBe('auto')
    expect(parseMode(undefined)).toBe('auto')
  })
  test('labelMode: both labels mean confirm', () => {
    expect(labelMode([])).toBeUndefined()
    expect(labelMode(['bug'])).toBeUndefined()
    expect(labelMode(['flow:auto'])).toBe('auto')
    expect(labelMode(['flow:auto', 'flow:confirm'])).toBe('confirm')
  })
  test('effectiveMode: label > stored > setting', () => {
    expect(effectiveMode([], undefined, 'auto')).toBe('auto')
    expect(effectiveMode([], undefined, 'confirm')).toBe('confirm')
    expect(effectiveMode([], 'confirm', 'auto')).toBe('confirm')
    expect(effectiveMode(['flow:auto'], 'confirm', 'confirm')).toBe('auto')
    expect(effectiveMode(['flow:confirm'], 'auto', 'auto')).toBe('confirm')
  })
  test('autoRefused only for auto under a confirm setting', () => {
    expect(autoRefused('auto', 'confirm')).toBe(true)
    expect(autoRefused('auto', 'auto')).toBe(false)
    expect(autoRefused('confirm', 'confirm')).toBe(false)
    expect(autoRefused(undefined, 'confirm')).toBe(false)
  })
  test('takeDecision', () => {
    const base = { labels: [], setting: 'auto' as const, head: 'abc' }
    expect(takeDecision(base)).toBe('take')
    expect(takeDecision({ ...base, labels: ['flow:confirm'] })).toBe('hold')
    expect(takeDecision({ ...base, setting: 'confirm' })).toBe('hold')
    expect(takeDecision({ ...base, setting: 'confirm', approvedHead: 'abc' })).toBe('take')
    expect(takeDecision({ ...base, setting: 'confirm', approvedHead: 'old' })).toBe('hold')
    expect(takeDecision({ ...base, stored: 'confirm' })).toBe('hold')
  })
})
