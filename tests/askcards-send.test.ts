import { expect } from 'claude-code/testing'
import { test } from './support'
import { sendCards } from '../hooks/askcards'
import type { CardsIo } from '../hooks/askcards'

const io = (over: Partial<CardsIo>, sent: string[]): CardsIo => ({ paneOpen: async () => false, openIds: async ids => ids, send: t => { sent.push(t) }, ...over })

test('sendCards: pane closed sends the notice for the ids open now', async () => {
  const sent: string[] = []
  await sendCards(io({}, sent), {}, n => `${n} open`, ['q1', 'q2'])
  expect(sent).toHaveLength(1)
  expect(sent[0]).toContain('2 open (q1, q2)')
})

test('sendCards: pane open sends nothing', async () => {
  const sent: string[] = []
  await sendCards(io({ paneOpen: async () => true }, sent), {}, () => 'x', ['q1'])
  expect(sent).toEqual([])
})

test('sendCards: items answered before sending are dropped; all answered sends nothing', async () => {
  const sent: string[] = []
  await sendCards(io({ openIds: async () => ['q2'] }, sent), {}, n => `${n} open`, ['q1', 'q2'])
  expect(sent[0]).toContain('1 open (q2)')
  sent.length = 0
  await sendCards(io({ openIds: async () => [] }, sent), {}, () => 'x', ['q1'])
  expect(sent).toEqual([])
})

test('sendCards: a throwing pane probe counts as closed; ask_cards off sends nothing', async () => {
  const sent: string[] = []
  await sendCards(io({ paneOpen: async () => { throw new Error('x') } }, sent), {}, () => 'x', ['q1'])
  expect(sent).toHaveLength(1)
  await sendCards(io({}, sent), { ask_cards: 'off' }, () => 'x', ['q1'])
  expect(sent).toHaveLength(1)
})
