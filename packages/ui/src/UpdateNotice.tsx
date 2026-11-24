import { useEffect, useState } from 'react'
import type { AvailableUpdate, NgomateHost } from './host.js'
import { usePrimitives } from './primitives.js'

const MAX_NOTES = 600

/**
 * Says when a newer version is ready and installs it only when asked. The check runs once, when the
 * app opens; with no connection, or nothing newer, nothing is shown.
 */
export function UpdateNotice({
	host,
	checkRequest = 0,
}: {
	host: NgomateHost
	/** Counts up each time the person asks to check, as from the menu. Then the answer is shown either way. */
	checkRequest?: number
}) {
	const { Button } = usePrimitives()
	const [update, setUpdate] = useState<AvailableUpdate | null>(null)
	const [state, setState] = useState<'ready' | 'installing' | 'failed' | 'later'>('ready')
	const [progress, setProgress] = useState<number | null>(null)
	const [answer, setAnswer] = useState<string | null>(null)

	useEffect(() => {
		let current = true
		const asked = checkRequest > 0
		setAnswer(null)
		host.checkForUpdate?.().then(
			(found) => {
				if (!current) return
				setUpdate(found)
				if (found) setState('ready')
				else if (asked) setAnswer('You have the newest version.')
			},
			// Offline, or the release cannot be read: said only when the person asked.
			() => {
				if (current && asked) setAnswer('Could not check for a newer version. Are you online?')
			},
		)
		return () => {
			current = false
		}
	}, [host, checkRequest])

	if (answer && (!update || state === 'later')) {
		return (
			<output className="ngm-update">
				<p>{answer}</p>
				<Button variant="quiet" onClick={() => setAnswer(null)}>
					OK
				</Button>
			</output>
		)
	}
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
