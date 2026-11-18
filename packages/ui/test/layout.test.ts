import { describe, expect, it } from 'vitest'
import {
	type Layout,
	MAX_PANES,
	closeTab,
	focusTab,
	openBeside,
	openTab,
	replaceActive,
	singleLayout,
} from '../src/layout.js'

/** What is shown where, without the panes' own ids. */
const shape = (layout: Layout) => layout.panes.map(({ tabs, active }) => ({ tabs, active }))

describe('layout', () => {
	it('opens a conversation as a tab in the pane in use, or goes to it where it is open', () => {
		let layout = openBeside(singleLayout('a'), 'b')
		layout = openTab(focusTab(layout, 0, 'a'), 'c')
		expect(shape(layout)).toEqual([
			{ tabs: ['a', 'c'], active: 'c' },
			{ tabs: ['b'], active: 'b' },
		])
		layout = openTab(layout, 'b')
		expect(layout.focused).toBe(1)
		expect(layout.panes[0]?.tabs).toEqual(['a', 'c'])
	})

	it('shows an open conversation where it is rather than moving it into a new pane', () => {
		let layout = openTab(singleLayout('a'), 'b')
		layout = openBeside(layout, 'a')
		expect(shape(layout)).toEqual([{ tabs: ['a', 'b'], active: 'a' }])
		layout = openBeside(layout, 'c')
		expect(shape(layout)).toEqual([
			{ tabs: ['a', 'b'], active: 'a' },
			{ tabs: ['c'], active: 'c' },
		])
		expect(layout.focused).toBe(1)
	})

	it('keeps each pane its own id when another pane closes, so its chats are not rebuilt', () => {
		const layout = openBeside(openBeside(singleLayout('a'), 'b'), 'c')
		const [, second, third] = layout.panes
		const after = closeTab(layout, 'a')
		expect(after?.panes.map((pane) => pane.id)).toEqual([second?.id, third?.id])
	})

	it('stops adding panes at the limit and opens a tab instead', () => {
		let layout = singleLayout('0')
		for (let n = 1; n < MAX_PANES + 2; n++) layout = openBeside(layout, String(n))
		expect(shape(layout)).toHaveLength(MAX_PANES)
		expect(layout.panes[layout.focused]?.tabs).toHaveLength(3)
	})

	it('closes a tab, shows its neighbour, removes an empty pane, and says when nothing is left', () => {
		let layout = openBeside(openTab(singleLayout('a'), 'b'), 'c')
		layout = closeTab(focusTab(layout, 0, 'a'), 'a') ?? layout
		expect(shape(layout)[0]).toEqual({ tabs: ['b'], active: 'b' })
		layout = closeTab(layout, 'c') ?? layout
		expect(shape(layout)).toEqual([{ tabs: ['b'], active: 'b' }])
		expect(layout.focused).toBe(0)
		expect(closeTab(layout, 'b')).toBeNull()
	})

	it('puts a conversation in place of an empty tab, and goes to it instead when it is already open', () => {
		const layout = replaceActive(openTab(singleLayout('a'), 'empty'), 'b')
		expect(shape(layout)).toEqual([{ tabs: ['a', 'b'], active: 'b' }])
		expect(shape(replaceActive(layout, 'a'))).toEqual([{ tabs: ['a', 'b'], active: 'a' }])
	})
})
