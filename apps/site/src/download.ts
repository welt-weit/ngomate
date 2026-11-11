import { systemOf } from './system'

// Leads with the download for the visitor's system. Without this script the page leads with the Mac.
const navigatorWithHints = navigator as Navigator & { userAgentData?: { platform?: string } }
const system = systemOf(navigatorWithHints.userAgentData?.platform || navigator.userAgent)
const actions = document.querySelector('.actions')
const first = actions?.querySelector<HTMLAnchorElement>('a.button:not(.secondary)')
const match = actions?.querySelector<HTMLAnchorElement>(`a[data-system="${system}"]`)

if (system && actions && first && match && first !== match) {
	first.classList.add('secondary')
	first.textContent = first.dataset.short ?? first.textContent
	match.classList.remove('secondary')
	match.textContent = `Download for ${match.dataset.short}`
	actions.prepend(match)
}
