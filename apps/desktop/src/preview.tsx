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
/** More made-up conversations, dated back from today, so the lists show their days. */
function earlier(id: string, title: string, daysAgo: number) {
	return {
		id,
		title,
		updatedAt: new Date(Date.now() - daysAgo * 86_400_000).toISOString(),
		messages: [
			{ role: 'user' as const, content: title },
			{ role: 'assistant' as const, content: 'A made-up answer.' },
		],
		notices: {},
	}
}

export function start(root: Root) {
	document.title = 'NGOmate preview'
	const host = {
		...createFakeHost({
			conversations: [
				{ ...SAMPLE_CONVERSATION, updatedAt: new Date().toISOString() },
				earlier('board', 'Board letter for the spring meeting', 0.2),
				earlier('pump', 'Pump repair quote, Kanyama', 1),
				earlier('report', 'Quarterly report to a foundation', 3),
				earlier('volunteers', 'Volunteer rota for the food drive', 5),
				earlier('budget', 'Budget question from the treasurer', 12),
				earlier('calls', 'Open funding calls for school water', 30),
			],
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
