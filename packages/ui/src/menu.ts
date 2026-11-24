import type { MenuCommand } from './host.js'

const PAGES = ['chat', 'model', 'addons', 'memory', 'team'] as const
const PLAIN = [
	'close-tab',
	'attach',
	'add-team',
	'copy-invite',
	'check-updates',
	'toggle-sidebar',
	'toggle-work',
	'find',
] as const

/**
 * A menu item's id, as a host's menu sends it, as a command. Anything unknown is ignored, so a menu
 * can never make the interface do something it does not offer.
 */
export function parseMenuCommand(id: string): MenuCommand | null {
	if (id === 'new-conversation' || id === 'new-beside') {
		return { type: 'new-conversation', beside: id === 'new-beside' }
	}
	const plain = PLAIN.find((name) => name === id)
	if (plain) return { type: plain }
	const page = PAGES.find((name) => id === `show:${name}`)
	if (page) return { type: 'show', page }
	if (id.startsWith('team:') && id.length > 5) return { type: 'switch-team', id: id.slice(5) }
	return null
}
