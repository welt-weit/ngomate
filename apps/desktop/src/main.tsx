import { parseTaskFile } from '@ngomate/core'
import { createTauriHost } from '@ngomate/tauri'
import { type AvailableUpdate, NgomateApp } from '@ngomate/ui'
import '@ngomate/ui/default-theme.css'
import '@ngomate/ui/styles.css'
import { openUrl } from '@tauri-apps/plugin-opener'
import { relaunch } from '@tauri-apps/plugin-process'
import { check } from '@tauri-apps/plugin-updater'
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

/**
 * The newest published release, when it is newer than this one. A build without the updater set up
 * (no public key in its config) rejects, which the interface takes as "nothing to offer".
 */
async function checkForUpdate(): Promise<AvailableUpdate | null> {
	const update = await check()
	if (!update) return null
	return {
		version: update.version,
		notes: update.body?.trim() || null,
		async install(onProgress) {
			let total = 0
			let received = 0
			await update.downloadAndInstall((event) => {
				if (event.event === 'Started') total = event.data.contentLength ?? 0
				if (event.event === 'Progress') {
					received += event.data.chunkLength
					onProgress(total ? Math.min(received / total, 1) : null)
				}
			})
			await relaunch()
		},
	}
}

function App() {
	const host = useMemo(
		() => ({ ...createTauriHost({ appName: 'NGOmate', tasks }), checkForUpdate }),
		[],
	)
	return <NgomateApp host={host} />
}

createRoot(document.getElementById('root') as HTMLElement).render(
	<StrictMode>
		<App />
	</StrictMode>,
)
