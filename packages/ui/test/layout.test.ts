import { describe, expect, it } from 'vitest'
import {
	type Layout,
	MAX_PANES,
	closeTab,
	focusTab,
	openBeside,
	openTab,
	placeTab,
	replaceActive,
	restoreLayout,
	singleLayout,
	storeLayout,
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

	it('places a dropped conversation in that pane, where it was dropped, moving it from another', () => {
		let layout = openBeside(openTab(singleLayout('a'), 'b'), 'c')
		const [, right] = layout.panes
		layout = placeTab(layout, right?.id ?? '', 'x')
		expect(shape(layout)[1]).toEqual({ tabs: ['c', 'x'], active: 'x' })
		layout = placeTab(layout, right?.id ?? '', 'b', 'c')
		expect(shape(layout)).toEqual([
			{ tabs: ['a'], active: 'a' },
			{ tabs: ['b', 'c', 'x'], active: 'b' },
		])
		expect(layout.focused).toBe(1)
		// Moving the last tab out of a pane closes it, and the target is still found by its id.
		layout = placeTab(layout, right?.id ?? '', 'a')
		expect(layout.panes.map((pane) => pane.id)).toEqual([right?.id])
		expect(layout.focused).toBe(0)
	})

	it('reorders within a pane', () => {
		const layout = openTab(openTab(singleLayout('a'), 'b'), 'c')
		const pane = layout.panes[0]?.id ?? ''
		expect(shape(placeTab(layout, pane, 'c', 'a'))).toEqual([
			{ tabs: ['c', 'a', 'b'], active: 'c' },
		])
	})

	it('opens the kept tabs again, without what was deleted or never saved, and with fresh pane ids', () => {
		const before = openTab(openBeside(singleLayout('a'), 'b'), 'gone')
		const kept = JSON.parse(JSON.stringify(storeLayout(before)))
		const after = restoreLayout(kept, (id) => id !== 'gone')
		expect(after && shape(after)).toEqual([
			{ tabs: ['a'], active: 'a' },
			{ tabs: ['b'], active: 'b' },
		])
		expect(after?.focused).toBe(1)
		const ids = [...before.panes, ...(after?.panes ?? [])].map((pane) => pane.id)
		expect(new Set(ids).size).toBe(ids.length)
	})

	it('drops a pane left empty, a tab kept twice, and panes over the limit', () => {
		const kept = {
			panes: [
				{ tabs: ['gone'], active: 'gone' },
				{ tabs: ['a', 'a', 'b'], active: 'gone' },
				...Array.from({ length: MAX_PANES }, (_, index) => ({
					tabs: [`p${index}`],
					active: `p${index}`,
				})),
			],
			focused: 0,
		}
		const after = restoreLayout(kept, (id) => id !== 'gone')
		expect(after?.panes).toHaveLength(MAX_PANES)
		expect(after && shape(after)[0]).toEqual({ tabs: ['a', 'b'], active: 'a' })
		expect(after?.focused).toBe(0)
	})

	it('opens nothing from a missing or broken file', () => {
		const keep = () => true
		expect(restoreLayout(undefined, keep)).toBeNull()
		expect(restoreLayout({ panes: 'no' }, keep)).toBeNull()
		expect(restoreLayout({ panes: [null, { tabs: [1, null] }], focused: 0 }, keep)).toBeNull()
		expect(
			restoreLayout({ panes: [{ tabs: ['gone'], active: 'gone' }], focused: 0 }, () => false),
		).toBeNull()
	})
})
