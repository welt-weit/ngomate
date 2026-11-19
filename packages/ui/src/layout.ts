/** Conversations open as tabs, in one or more panes side by side. Each tab is a conversation id. */
/** `id` stays with the pane however others open and close beside it, so its chats are never rebuilt. */
export type Pane = { id: string; tabs: string[]; active: string }
export type Layout = { panes: Pane[]; focused: number }

/** More than this and each pane is too narrow to read. */
export const MAX_PANES = 4

let panesMade = 0
const newPane = (tab: string): Pane => ({ id: `pane-${++panesMade}`, tabs: [tab], active: tab })

export const singleLayout = (id: string): Layout => ({ panes: [newPane(id)], focused: 0 })

const paneOf = (layout: Layout, id: string) =>
	layout.panes.findIndex((pane) => pane.tabs.includes(id))

/** Shows a conversation: where it is already open, or as a new tab in the pane in use. */
export function openTab(layout: Layout, id: string): Layout {
	const at = paneOf(layout, id)
	if (at >= 0) return focusTab(layout, at, id)
	const panes = layout.panes.map((pane, index) =>
		index === layout.focused ? { ...pane, tabs: [...pane.tabs, id], active: id } : pane,
	)
	return { panes, focused: layout.focused }
}

export function focusTab(layout: Layout, paneIndex: number, id: string): Layout {
	const panes = layout.panes.map((pane, index) =>
		index === paneIndex ? { ...pane, active: id } : pane,
	)
	return { panes, focused: paneIndex }
}

/**
 * Opens a conversation in a new pane beside the one in use. One already open is shown where it is:
 * moving it would rebuild its chat and stop an answer being written. At the limit it opens as a tab.
 */
export function openBeside(layout: Layout, id: string): Layout {
	if (layout.panes.length >= MAX_PANES || paneOf(layout, id) >= 0) return openTab(layout, id)
	const after = layout.focused + 1
	const panes = [...layout.panes]
	panes.splice(after, 0, newPane(id))
	return { panes, focused: after }
}

/** Null when nothing is left open, so the caller can start a new conversation. */
export function closeTab(layout: Layout, id: string): Layout | null {
	const panes: Pane[] = []
	let focused = layout.focused
	layout.panes.forEach((pane, index) => {
		const at = pane.tabs.indexOf(id)
		if (at < 0) {
			panes.push(pane)
			return
		}
		const tabs = pane.tabs.filter((tab) => tab !== id)
		if (tabs.length) {
			// The neighbour takes its place, as in a browser.
			const active =
				pane.active === id ? (tabs[Math.min(at, tabs.length - 1)] as string) : pane.active
			panes.push({ ...pane, tabs, active })
		} else if (index < layout.focused || (index === layout.focused && index > 0)) {
			focused--
		}
	})
	if (!panes.length) return null
	return { panes, focused: Math.min(Math.max(focused, 0), panes.length - 1) }
}

/**
 * Shows a conversation in place of the tab in use, for a tab that holds nothing yet: opening one from
 * the list should not leave an empty "New conversation" beside it.
 */
export function replaceActive(layout: Layout, id: string): Layout {
	if (paneOf(layout, id) >= 0) return openTab(layout, id)
	const panes = layout.panes.map((pane, index) =>
		index === layout.focused
			? { ...pane, tabs: pane.tabs.map((tab) => (tab === pane.active ? id : tab)), active: id }
			: pane,
	)
	return { panes, focused: layout.focused }
}

/**
 * Puts a conversation in a given pane, before the tab `before` or at the end: what dropping it on a
 * tab bar does. One open elsewhere moves, and a pane left empty by that closes. The target is named
 * by its id, which stays right when an emptied pane before it goes.
 */
export function placeTab(layout: Layout, paneId: string, id: string, before?: string): Layout {
	if (before === id) return layout
	const from = paneOf(layout, id)
	const target = layout.panes.find((pane) => pane.id === paneId)
	if (!target) return layout
	const moved = from >= 0 && layout.panes[from]?.id !== paneId ? closeTab(layout, id) : layout
	if (!moved) return layout
	const panes = moved.panes.map((pane) => {
		if (pane.id !== paneId) return pane
		const tabs = pane.tabs.filter((tab) => tab !== id)
		const at = before ? tabs.indexOf(before) : -1
		tabs.splice(at < 0 ? tabs.length : at, 0, id)
		return { ...pane, tabs, active: id }
	})
	return { panes, focused: panes.findIndex((pane) => pane.id === paneId) }
}

export const activeId = (layout: Layout): string | undefined => layout.panes[layout.focused]?.active
