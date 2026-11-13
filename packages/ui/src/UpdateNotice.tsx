import { useEffect, useState } from 'react'
import type { AvailableUpdate, NgomateHost } from './host.js'
import { usePrimitives } from './primitives.js'

const MAX_NOTES = 600

/**
 * Says when a newer version is ready and installs it only when asked. The check runs once, when the
 * app opens; with no connection, or nothing newer, nothing is shown.
 */
export function UpdateNotice({ host }: { host: NgomateHost }) {
	const { Button } = usePrimitives()
	const [update, setUpdate] = useState<AvailableUpdate | null>(null)
	const [state, setState] = useState<'ready' | 'installing' | 'failed' | 'later'>('ready')
	const [progress, setProgress] = useState<number | null>(null)

	useEffect(() => {
		let current = true
		host.checkForUpdate?.().then(
			(found) => {
				if (current) setUpdate(found)
			},
			// Offline, or the release cannot be read: there is nothing useful to say.
			() => {},
		)
		return () => {
			current = false
		}
	}, [host])

	if (!update || state === 'later') return null

	const notes =
		update.notes && update.notes.length > MAX_NOTES
			? `${update.notes.slice(0, MAX_NOTES).trimEnd()}…`
			: update.notes

	const install = async () => {
		setState('installing')
		setProgress(null)
		try {
			// The app restarts at the end, so success has nothing left to show.
			await update.install(setProgress)
		} catch {
			setState('failed')
		}
	}

	return (
		<section className="ngm-update" aria-label="Update">
			<strong>
				{host.appName} {update.version} is ready
			</strong>
			{notes && (
				<details>
					<summary>What's new</summary>
					<p className="ngm-update-notes">{notes}</p>
				</details>
			)}
			{state === 'failed' && <p>The update could not be installed. Try again later.</p>}
			<div className="ngm-row">
				<Button variant="primary" disabled={state === 'installing'} onClick={install}>
					{state === 'installing'
						? progress === null
							? 'Installing…'
							: `Installing… ${Math.round(progress * 100)}%`
						: 'Install and restart'}
				</Button>
				{state !== 'installing' && (
					<Button variant="quiet" onClick={() => setState('later')}>
						Later
					</Button>
				)}
			</div>
		</section>
	)
}
