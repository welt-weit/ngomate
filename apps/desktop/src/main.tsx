import { parseTaskFile } from '@ngomate/core'
import { createTauriHost } from '@ngomate/tauri'
import { NgomateApp } from '@ngomate/ui'
import '@ngomate/ui/styles.css'
import { openUrl } from '@tauri-apps/plugin-opener'
import { StrictMode, useMemo } from 'react'
import { createRoot } from 'react-dom/client'

const taskFiles = import.meta.glob<string>('./tasks/*.md', {
	query: '?raw',
	import: 'default',
	eager: true,
})
const tasks = Object.values(taskFiles).map(parseTaskFile)

// A link in an answer opens in the person's browser, never in this window.
document.addEventListener('click', (event) => {
	const link = (event.target as Element).closest?.('a[href]') as HTMLAnchorElement | null
	if (!link) return
	event.preventDefault()
	if (/^https?:/i.test(link.href)) openUrl(link.href)
})

function App() {
	const host = useMemo(() => createTauriHost({ appName: 'NGOmate', tasks }), [])
	return <NgomateApp host={host} />
}

createRoot(document.getElementById('root') as HTMLElement).render(
	<StrictMode>
		<App />
	</StrictMode>,
)
