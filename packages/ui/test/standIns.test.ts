import type { ChatRequest, ModelClient } from '@ngomate/core'
import { describe, expect, it } from 'vitest'
import {
	addStandIns,
	findIdentifiers,
	putBack,
	putBackArgs,
	standIn,
	withStandIns,
} from '../src/standIns.js'

describe('stand-ins for who a conversation is about', () => {
	it('finds email addresses and phone numbers, not amounts or years, and quickly in long text', () => {
		expect(
			findIdentifiers([
				'Write to ada@example.org or +254 712 345 678 by 2026, about 25,000 euros.',
			]),
		).toEqual([
			{ text: 'ada@example.org', kind: 'email' },
			{ text: '+254 712 345 678', kind: 'phone' },
		])
		expect(findIdentifiers(['Due 01.12.2026, or 05/11/2026 at the latest'])).toEqual([])
		const started = performance.now()
		findIdentifiers(['x'.repeat(200_000), '0 '.repeat(100_000)])
		expect(performance.now() - started).toBeLessThan(500)
	})

	it('numbers each kind on, and swaps longest first so a name inside an address stays whole', () => {
		const table = addStandIns(addStandIns([], [{ text: 'Ada', kind: 'name' }]), [
			{ text: 'ada@example.org', kind: 'email' },
			{ text: 'Bea Mwangi', kind: 'name' },
			{ text: 'Ada', kind: 'name' },
		])
		expect(table).toEqual([
			{ real: 'Ada', stand: '[PERSON_1]' },
			{ real: 'ada@example.org', stand: '[EMAIL_1]' },
			{ real: 'Bea Mwangi', stand: '[PERSON_2]' },
		])
		const text = 'Ada (ada@example.org) and Bea Mwangi'
		expect(standIn(text, table)).toBe('[PERSON_1] ([EMAIL_1]) and [PERSON_2]')
		expect(putBack(standIn(text, table), table)).toBe(text)
		expect(standIn('Adam went to Canada', table)).toBe('Adam went to Canada')
	})

	it('sends only stand-ins, and puts the real ones back as the answer streams', async () => {
		let sent: ChatRequest | undefined
		const client: ModelClient = {
			async chat(request) {
				sent = request
				for (const piece of ['Thank ', '[PER', 'SON_1] for ', 'the [EMAIL_1] note.'])
					request.onText?.(piece)
				return {
					content: 'Thank [PERSON_1] for the [EMAIL_1] note.',
					toolCalls: [{ id: '1', name: 'send', arguments: '{"to":"[EMAIL_1]"}' }],
					promptTokens: null,
					completionTokens: null,
				}
			},
		}
		const table = addStandIns(
			[],
			[
				{ text: 'Ada', kind: 'name' },
				{ text: 'ada@example.org', kind: 'email' },
			],
		)
		let shown = ''
		const reply = await withStandIns(client, table).chat({
			messages: [
				{ role: 'system', content: 'Notes: Ada wrote from ada@example.org.' },
				{ role: 'user', content: 'Thank Ada' },
			],
			tools: [],
			onText: (piece) => {
				shown += piece
			},
		})
		expect(JSON.stringify(sent?.messages)).not.toMatch(/Ada|ada@example/)
		expect(shown).toBe('Thank Ada for the ada@example.org note.')
		expect(reply.content).toBe('Thank Ada for the ada@example.org note.')
		// A connector the model calls gets the stand-in too.
		expect(reply.toolCalls[0]?.arguments).toBe('{"to":"[EMAIL_1]"}')
	})

	it('takes a long number whole, any case of a name, and never swaps a stand-in again', () => {
		const long = 'Call 0049 (0) 30 / 1234 5678 90 today'
		const found = findIdentifiers([long])
		expect(found).toEqual([{ text: '0049 (0) 30 / 1234 5678 90', kind: 'phone' }])
		expect(standIn(long, addStandIns([], found))).toBe('Call [PHONE_1] today')
		const table = addStandIns(
			[],
			[
				{ text: 'Ada Lovelace', kind: 'name' },
				{ text: 'PERSON', kind: 'name' },
			],
		)
		expect(standIn('ADA LOVELACE met a PERSON', table)).toBe('[PERSON_1] met a [PERSON_2]')
		expect(putBack('[PERSON_1]s notes', table)).toBe('Ada Lovelaces notes')
		expect(putBackArgs({ to: ['[PERSON_1]'], note: { by: '[PERSON_1]' }, n: 2 }, table)).toEqual({
			to: ['Ada Lovelace'],
			note: { by: 'Ada Lovelace' },
			n: 2,
		})
	})

	it('still shows what was held back when the answer is stopped', async () => {
		const client: ModelClient = {
			async chat(request) {
				request.onText?.('Thank [PER')
				throw new Error('stopped')
			},
		}
		let shown = ''
		await expect(
			withStandIns(client, addStandIns([], [{ text: 'Ada', kind: 'name' }])).chat({
				messages: [],
				tools: [],
				onText: (piece) => {
					shown += piece
				},
			}),
		).rejects.toThrow('stopped')
		expect(shown).toBe('Thank [PER')
	})
})
