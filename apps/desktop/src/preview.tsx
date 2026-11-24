import { NgomateApp } from '@ngomate/ui'
import { SAMPLE_CONVERSATION, createFakeHost, fakeModels } from '@ngomate/ui/preview'
import '@ngomate/ui/default-theme.css'
import '@ngomate/ui/styles.css'
import { StrictMode } from 'react'
import type { Root } from 'react-dom/client'
import { logo, tasks } from './shared.js'

/**
 * The app in a plain browser, on a made-up host: a scripted model, a sample conversation and two
 * teams, all in memory and gone on reload. Nothing is read from or written to this computer.
 */
export function start(root: Root) {
	document.title = 'NGOmate preview'
	const host = {
		...createFakeHost({
			conversations: [SAMPLE_CONVERSATION],
			teams: ['Riverside Water Group', 'Coalition for Clean Rivers'],
			models: fakeModels(),
		}),
		tasks,
		logo,
	}
	root.render(
		<StrictMode>
			<NgomateApp host={host} />
		</StrictMode>,
	)
}
