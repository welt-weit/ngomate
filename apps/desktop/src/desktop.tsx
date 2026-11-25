import { createTauriHost } from '@ngomate/tauri'
import {
	type AvailableUpdate,
	type MenuCommand,
	type MenuState,
	NgomateApp,
	parseMenuCommand,
} from '@ngomate/ui'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import '@ngomate/ui/default-theme.css'
import '@ngomate/ui/styles.css'
import { getCurrent, onOpenUrl } from '@tauri-apps/plugin-deep-link'
import {
	isPermissionGranted,
	requestPermission,
	sendNotification,
} from '@tauri-apps/plugin-notification'
import { openUrl } from '@tauri-apps/plugin-opener'
import { relaunch } from '@tauri-apps/plugin-process'
import { check } from '@tauri-apps/plugin-updater'
import { StrictMode, useMemo } from 'react'
import type { Root } from 'react-dom/client'
import { logo, tasks } from './shared.js'

/** The app in its Tauri window. Loaded only there: much of this talks to the window at once. */

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

/**
 * A system notification, as when a job finishes. The system asks the person once; if they say no,
 * nothing is shown and the job's result is still in the app.
 */
let notificationsRefused = false
async function notify(title: string, body: string) {
	if (notificationsRefused) return
	try {
		const granted = (await isPermissionGranted()) || (await requestPermission()) === 'granted'
		// Asked once a session: a person who said no is not asked again at every job.
		if (!granted) notificationsRefused = true
		else sendNotification({ title, body })
	} catch {
		// No notifications on this system: the result is in the app either way.
	}
}

/**
 * Invite links, from the start of the app or while it runs. Only `ngomate://join` is passed on, and the
 * interface reads the invite strictly and asks before doing anything with it.
 */
const invites = {
	pending: [] as string[],
	listener: null as ((link: string) => void) | null,
	deliver(urls: string[] | null) {
		for (const url of urls ?? []) {
			if (!url.startsWith('ngomate://join')) continue
			if (invites.listener) invites.listener(url)
			else invites.pending.push(url)
		}
	},
}
getCurrent()
	.then((urls) => invites.deliver(urls))
	.catch(() => {})
onOpenUrl((urls) => invites.deliver(urls)).catch(() => {})

function onInvite(listener: (link: string) => void) {
	invites.listener = listener
	for (const link of invites.pending.splice(0)) listener(link)
	return () => {
		if (invites.listener === listener) invites.listener = null
	}
}

const menu = {
	onCommand(listener: (command: MenuCommand) => void) {
		const stop = listen<string>('menu', (event) => {
			const command = parseMenuCommand(event.payload)
			if (command) listener(command)
		})
		return () => {
			stop.then((unlisten) => unlisten())
		}
	},
	update(state: MenuState) {
		invoke('menu_update', { state }).catch(() => {})
	},
}

function App() {
	const host = useMemo(() => {
		const base = createTauriHost({ appName: 'NGOmate', tasks })
		return {
			...base,
			team: base.team && { ...base.team, onInvite },
			menu,
			logo,
			checkForUpdate,
			notify: (title: string, body: string) => void notify(title, body),
		}
	}, [])
	return <NgomateApp host={host} />
}

export function start(root: Root) {
	root.render(
		<StrictMode>
			<App />
		</StrictMode>,
	)
}
