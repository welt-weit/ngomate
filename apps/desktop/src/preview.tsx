import { nextOccurrence, parseSchedule } from '@ngomate/core'
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

const DAY = 86_400_000
const WEEKLY = parseSchedule('weekly mon 09:00')
const nextMonday = nextOccurrence(WEEKLY, new Date())
/** The Monday nine o'clock this many weeks before the next one. */
const mondaysAgo = (weeks: number) => new Date(nextMonday.getTime() - weeks * 7 * DAY).toISOString()

/**
 * A made-up weekly job with two runs: the newest not yet opened and asking for a change, the one before
 * with something the checks found.
 */
const SAMPLE_JOB = {
	text: [
		'---',
		'id: funding-this-week',
		'title: Funding this week',
		'task: find-opportunities',
		'schedule: weekly mon 09:00',
		'destination: team-note Funding this week',
		'---',
		'A made-up youth group working on clean water in two villages.',
		'',
	].join('\n'),
	state: {
		nextDue: nextMonday.toISOString(),
		runs: [
			{
				dueAt: mondaysAgo(1),
				ranAt: mondaysAgo(1),
				outcome: 'waiting' as const,
				conversationId: 'job-funding-this-week-run-2',
				changes: [
					{
						tool: 'add_contact',
						args: { name: 'Fictional Water Fund' },
						decision: 'waiting' as const,
					},
				],
				note: 'Funding this week',
				seen: false,
			},
			{
				dueAt: mondaysAgo(2),
				ranAt: mondaysAgo(2),
				outcome: 'warnings' as const,
				conversationId: 'job-funding-this-week-run-1',
				note: 'Funding this week',
				seen: true,
			},
		],
	},
}

/** A made-up task of the person's own, as its file. */
const OWN_TASK = [
	'---',
	'id: funder-page-check',
	'title: Funder page check',
	'description: Says what changed on a funder page since last time.',
	'ask: The funder and its web page',
	'tools: none',
	'---',
	'Compare the page the person gives you with what they say it said before, and list what changed.',
	'',
].join('\n')

/** A chat where a job is half made in words, with its card above it. */
const MAKING = {
	id: 'making-volunteers',
	title: 'Volunteer rota reminder',
	updatedAt: new Date(Date.now() - 600_000).toISOString(),
	messages: [
		{
			role: 'user' as const,
			content: 'Every Friday afternoon, draft next week’s volunteer rota from my notes.',
		},
		{
			role: 'assistant' as const,
			content: 'I have drafted the job above. Which notes should it draft the rota from?',
		},
	],
	notices: {},
	draft: {
		kind: 'job' as const,
		task: {},
		job: {
			title: 'Volunteer rota',
			task: 'write-update-or-report',
			schedule: 'weekly fri 15:00',
			note: 'Rota {date}',
		},
	},
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
				earlier('job-funding-this-week-run-2', 'Funding this week', 1),
				earlier('job-funding-this-week-run-1', 'Funding this week', 8),
				MAKING,
			],
			ownTasks: { 'funder-page-check': OWN_TASK },
			settings: { drafts: { [MAKING.id]: 'job' } },
			jobs: { 'funding-this-week': SAMPLE_JOB },
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
