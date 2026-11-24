import { describe, expect, it } from 'vitest'
import { byDay } from '../src/WorkPanel.js'

describe('the list of chats', () => {
	it('groups them by day: today, yesterday, the last week, then earlier', () => {
		const now = new Date(2026, 10, 24, 15, 0)
		const at = (days: number, hour = 12) => new Date(2026, 10, 24 - days, hour).toISOString()
		const chats = [
			{ id: 'a', title: 'This morning', updatedAt: at(0, 9) },
			{ id: 'b', title: 'Late yesterday', updatedAt: at(1, 23) },
			{ id: 'c', title: 'Six days ago', updatedAt: at(6) },
			{ id: 'd', title: 'Last month', updatedAt: at(30) },
			{ id: 'e', title: 'No date', updatedAt: 'not a date' },
		]
		expect(
			byDay(chats, now).map((group) => [group.label, group.items.map((item) => item.id)]),
		).toEqual([
			['Today', ['a']],
			['Yesterday', ['b']],
			['Last 7 days', ['c']],
			['Earlier', ['d', 'e']],
		])
	})
})
