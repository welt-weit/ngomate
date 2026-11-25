// @vitest-environment jsdom
import {
	type JobFile,
	type JobRun,
	type ModelReply,
	newJobState,
	parseSchedule,
} from '@ngomate/core'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { NgomateApp } from '../src/NgomateApp.js'
import { DEFAULT_SETTINGS, type Settings } from '../src/host.js'
import { createFakeHost } from '../src/preview-host.js'
import { checkLines, forTeamRun, runJob } from '../src/runJob.js'
import type { ChatDeps } from '../src/useChat.js'
import { type ListedJob, droppedRuns } from '../src/useJobs.js'

afterEach(cleanup)

const say = (content: string): ModelReply => ({
	content,
	toolCalls: [],
	promptTokens: 1,
	completionTokens: 1,
})
const call = (name: string, args: unknown): ModelReply => ({
	content: null,
	toolCalls: [{ id: `c-${name}`, name, arguments: JSON.stringify(args) }],
	promptTokens: 1,
	completionTokens: 1,
})

const CONNECTED: Partial<Settings> = {
	addons: [
		{
			id: 'grants',
			name: 'Made-up grants',
			connection: { kind: 'http', url: 'https://grants.example/mcp' },
			enabled: true,
			allowDestructive: false,
		},
	],
}

function setup(replies: ModelReply[], settings: Partial<Settings> = CONNECTED) {
	const host = createFakeHost({ replies })
	const merged = {
		...DEFAULT_SETTINGS,
		model: { kind: 'server' as const, baseUrl: 'http://fake', model: 'fake' },
		...settings,
	}
	const chat: ChatDeps = {
		host,
		settings: merged,
		getModel: async () => {
			if (!merged.model) throw new Error('Choose a model first, under Model.')
			return { client: host.createModelClient('http://fake', 'fake') }
		},
		onSaved: () => {},
	}
	return { host, deps: { chat, tasks: host.tasks, teamTasks: [] } }
}

const job = (overrides: Partial<JobFile> = {}): JobFile => ({
	id: 'funding',
	title: 'Funding this week',
	task: 'find-opportunities',
	schedule: parseSchedule('weekly mon 09:00'),
	destination: { kind: 'note', name: 'Funding {date}' },
	inputs: 'A made-up youth group working on water.',
	...overrides,
})

const signal = new AbortController().signal
// Monday 30 November 2026, 09:00: the job's date.
const due = new Date(2026, 10, 30, 9)
const state = () => ({ ...newJobState(job(), new Date(2026, 10, 24)), nextDue: due.toISOString() })

describe('a job run', () => {
	it('writes the answer to its note, labelled as written by AI, and never makes a change it asks for', async () => {
		const { host, deps } = setup([
			call('search_grants', { query: 'water' }),
			call('add_contact', { name: 'Fictional Water Fund' }),
			say('Fictional Water Fund, deadline 2027-03-01: https://fund.example/water-7'),
		])
		const asks = job({ inputs: 'Search grants for water, and add each funder as a contact.' })
		const after = await runJob(deps, asks, state(), signal, () => due)
		const run = after.runs[0]
		expect(run?.outcome).toBe('waiting')
		expect(run?.changes).toEqual([
			{ tool: 'add_contact', args: { name: 'Fictional Water Fund' }, decision: 'waiting' },
		])
		expect(run?.note).toBe('Funding 2026-11-30')
		const note = (await host.memory.read('Funding 2026-11-30')) ?? ''
		expect(note).toMatch(/Written by NGOmate, an AI assistant, for the job "Funding this week"/)
		expect(note).toMatch(
			/asked to make these changes, which wait for you in the app:\n- add_contact/,
		)
		expect(note).toMatch(/Fictional Water Fund, deadline 2027-03-01/)
		// The run is kept as a conversation, under the job's name.
		const kept = await host.readConversation(run?.conversationId ?? '')
		expect(kept?.id).toMatch(/^job-funding-/)
		expect(kept?.title).toMatch(/^Funding this week, /)
		expect(after.nextDue).toBe(new Date(2026, 11, 7, 9).toISOString())
	})

	it('puts what the checks found at the top', async () => {
		const { host, deps } = setup([say('Apply by 2031-05-05.')])
		const draft = job({
			task: 'draft-proposal-section',
			destination: { kind: 'note', name: 'Draft' },
		})
		const after = await runJob(deps, draft, state(), signal, () => due)
		expect(after.runs[0]?.outcome).toBe('warnings')
		const note = (await host.memory.read('Draft')) ?? ''
		expect(note).toMatch(/Check these first:\n- Dates no tool or material gave: 2031-05-05/)
		expect(note.indexOf('Check these first')).toBeLessThan(note.indexOf('Apply by'))
	})

	it('says it ran late when the computer was off on its date', async () => {
		const { host, deps } = setup([say('Nothing new.')], CONNECTED)
		const back = new Date(2026, 11, 2, 10, 14)
		const draft = job({
			task: 'draft-proposal-section',
			destination: { kind: 'note', name: 'Draft' },
		})
		const after = await runJob(deps, draft, state(), signal, () => back)
		expect(after.runs[0]?.outcome).toBe('done')
		expect(await host.memory.read('Draft')).toMatch(/the computer was off or the app was closed/)
		expect(after.nextDue).toBe(new Date(2026, 11, 7, 9).toISOString())
	})

	it('is tried again shortly when it could not run, without listing a run yet', async () => {
		const { deps } = setup([], { ...CONNECTED, model: null })
		const after = await runJob(deps, job(), state(), signal, () => due)
		expect(after.runs).toHaveLength(0)
		expect(after.tries).toBe(1)
		expect(after.problem).toBe('Choose a model first, under Model.')
		expect(Date.parse(after.nextDue)).toBe(due.getTime() + 15 * 60_000)
	})

	it('is held, not written to another team, when the team it uses is not open', async () => {
		const { host, deps } = setup([say('Never asked.')])
		const mine = job({ team: 'riverside', destination: { kind: 'team-note', name: 'Funding' } })
		const after = await runJob({ ...deps, teamId: 'other' }, mine, state(), signal, () => due)
		expect(after.runs[0]?.outcome).toBe('held')
		expect(after.runs[0]?.reason).toMatch(/uses a team that is not open/)
		expect(await host.listConversations()).toEqual([])
	})

	it("gives a team run only the connectors the team suggests, and nobody's notes", async () => {
		const { deps } = setup([])
		const grants = deps.chat.settings.addons[0] as Settings['addons'][number]
		const mail = {
			...grants,
			id: 'mail',
			connection: { kind: 'http' as const, url: 'https://mail.example/mcp' },
		}
		const chat = { ...deps.chat, settings: { ...deps.chat.settings, addons: [grants, mail] } }
		await chat.host.memory.write('Private', 'Not for the team.')
		const team = forTeamRun(chat, ['https://grants.example/mcp'])
		expect(team.settings.addons.map((addon) => addon.id)).toEqual(['grants'])
		expect(await team.host.memory.list()).toEqual([])
	})

	it('waits for the person when the team changed its task, and runs nothing', async () => {
		const { host, deps } = setup([])
		const teamTask = { ...host.tasks[1], id: 'team-report' } as (typeof host.tasks)[number]
		const withTeam = {
			...deps,
			teamTasks: [{ task: teamTask, version: 'v2', text: 'changed' }],
		}
		const after = await runJob(
			withTeam,
			job({ task: 'team-report' }),
			{ ...state(), taskVersion: 'v1' },
			signal,
			() => due,
		)
		expect(after.runs[0]?.outcome).toBe('held')
		expect(after.runs[0]?.reason).toMatch(/changed the task/)
		expect(await host.listConversations()).toHaveLength(0)
	})
})

describe('what the checks found, for the top of a note', () => {
	it('is nothing when they found nothing', () => {
		expect(checkLines(null)).toEqual([])
		expect(
			checkLines({ unsourcedDates: [], unsourcedLinks: [], checkFigures: true, stopped: null }),
		).toEqual([])
	})
})

describe('the Jobs list', () => {
	it('makes a job, runs it now, writes its note and lists the run until it is opened', async () => {
		const host = createFakeHost({ replies: [say('A short draft from the notes.')] })
		render(<NgomateApp host={host} />)
		const work = await screen.findByRole('complementary', { name: 'Your work' })
		await userEvent.click(within(work).getByRole('button', { name: 'Jobs' }))
		await userEvent.click(within(work).getByRole('button', { name: 'New job…' }))

		await userEvent.selectOptions(screen.getByLabelText('Task'), 'draft-proposal-section')
		await userEvent.type(screen.getByLabelText(/funder's question/), 'Made-up notes on a well.')
		await userEvent.type(screen.getByLabelText('Note'), 'Draft')
		expect(screen.getByText(/Every Monday at 09:00, while this app is open/)).toBeTruthy()
		await userEvent.click(screen.getByRole('button', { name: 'Make the job' }))

		const section = await within(work).findByRole('region', { name: 'Draft a proposal section' })
		expect(within(section).getByText(/^Every Monday at 09:00\. Next: /)).toBeTruthy()
		const [stored] = await (host.jobs?.list() ?? Promise.resolve([]))
		expect(stored?.text).toMatch(/schedule: weekly mon 09:00\ndestination: note Draft/)

		await userEvent.click(
			within(section).getByRole('button', { name: 'Run Draft a proposal section now' }),
		)
		const result = await within(section).findByRole(
			'button',
			{ name: /· Done · new$/ },
			{ timeout: 5000 },
		)
		expect(await host.memory.read('Draft')).toMatch(/A short draft from the notes\./)
		// Its run is listed under the job, not among the chats.
		await userEvent.click(within(work).getByRole('button', { name: 'Chats' }))
		expect(within(work).getByText('Your conversations will be listed here.')).toBeTruthy()
		await userEvent.click(within(work).getByRole('button', { name: 'Jobs' }))

		await userEvent.click(within(work).getByRole('button', { name: result.textContent ?? '' }))
		await waitFor(() => expect(within(work).getByRole('button', { name: /· Done$/ })).toBeTruthy())
		expect(await screen.findByText('A short draft from the notes.')).toBeTruthy()
	})

	it('pauses and resumes a job, and deletes it', async () => {
		const host = createFakeHost({
			jobs: {
				funding: {
					text: '---\nid: funding\ntitle: Funding\ntask: find-opportunities\nschedule: daily 08:00\ndestination: note Funding\n---\nWater.\n',
				},
			},
		})
		render(<NgomateApp host={host} />)
		const work = await screen.findByRole('complementary', { name: 'Your work' })
		await userEvent.click(within(work).getByRole('button', { name: 'Jobs' }))
		const section = await within(work).findByRole('region', { name: 'Funding' })
		await userEvent.click(within(section).getByRole('button', { name: 'Pause Funding' }))
		expect(await within(section).findByText('Paused. Every day at 08:00.')).toBeTruthy()
		await userEvent.click(within(section).getByRole('button', { name: 'Resume Funding' }))
		expect(await within(section).findByText(/^Every day at 08:00\. Next: /)).toBeTruthy()
		await userEvent.click(within(section).getByRole('button', { name: 'Delete Funding' }))
		await waitFor(() => expect(within(work).queryByRole('region', { name: 'Funding' })).toBeNull())
		expect(await host.jobs?.list()).toEqual([])
	})
})

describe('a change a job asked for', () => {
	it('waits under the job, and is made through the connector once allowed', async () => {
		const host = createFakeHost({
			replies: [
				call('add_contact', { name: 'Fictional Water Fund' }),
				say('Added nothing myself.'),
			],
			settings: CONNECTED,
			jobs: {
				contacts: {
					text: '---\nid: contacts\ntitle: Contacts\ntask: find-opportunities\nschedule: daily 08:00\ndestination: note Contacts\n---\nAdd each funder as a contact.\n',
				},
			},
		})
		const called: string[] = []
		const connect = host.connectAddon
		host.connectAddon = async (addon) => {
			const source = await connect(addon)
			return {
				...source,
				callTool: async (name, args) => {
					called.push(`${name} ${JSON.stringify(args)}`)
					return source.callTool(name, args)
				},
			}
		}
		render(<NgomateApp host={host} />)
		const work = await screen.findByRole('complementary', { name: 'Your work' })
		await userEvent.click(within(work).getByRole('button', { name: 'Jobs' }))
		const section = await within(work).findByRole('region', { name: 'Contacts' })
		await userEvent.click(within(section).getByRole('button', { name: 'Run Contacts now' }))
		expect(
			await within(section).findByText(
				'Asked to change: add_contact (name: Fictional Water Fund)',
				{},
				{ timeout: 5000 },
			),
		).toBeTruthy()
		expect(called).toEqual([])
		expect(within(section).getByRole('button', { name: /· Needs you/ })).toBeTruthy()

		await userEvent.click(within(section).getByRole('button', { name: 'Allow add_contact' }))
		await waitFor(() => expect(called).toEqual(['add_contact {"name":"Fictional Water Fund"}']))
		await waitFor(() => expect(within(section).queryByText(/Asked to change/)).toBeNull())
		expect(within(section).getByRole('button', { name: /· Done/ })).toBeTruthy()
	})
})

describe('a team job', () => {
	it('is kept in the team storage, runs on this computer once claimed, and writes a team note', async () => {
		const host = createFakeHost({
			replies: [say('A short draft for the team.')],
			teams: ['Riverside'],
			teamStorage: 'webdav',
			settings: { yourName: 'Amina' },
		})
		render(<NgomateApp host={host} />)
		const work = await screen.findByRole('complementary', { name: 'Your work' })
		await userEvent.click(within(work).getByRole('button', { name: 'Jobs' }))
		await userEvent.click(within(work).getByRole('button', { name: 'New job…' }))
		await userEvent.selectOptions(await screen.findByLabelText('For'), 'team')
		await userEvent.selectOptions(screen.getByLabelText('Task'), 'draft-proposal-section')
		await userEvent.type(screen.getByLabelText(/funder's question/), 'Made-up notes on a well.')
		await userEvent.type(screen.getByLabelText('Team note'), 'Weekly draft')
		expect(screen.queryByLabelText('Write the result to')).toBeNull()
		expect(
			screen.getByText(/on the first team member's computer that has this app open/),
		).toBeTruthy()
		await userEvent.click(screen.getByRole('button', { name: 'Make the job' }))

		const section = await within(work).findByRole('region', {
			name: 'Draft a proposal section (team)',
		})
		expect(within(section).getByText('· team')).toBeTruthy()
		const stored = await host.team?.store.read('jobs', 'draft-a-proposal-section')
		expect(stored?.text).toMatch(/destination: team-note Weekly draft\nzone: /)

		await userEvent.click(
			within(section).getByRole('button', { name: 'Run Draft a proposal section (team) now' }),
		)
		expect(
			await within(section).findByRole('button', { name: /· Done · Amina$/ }, { timeout: 9000 }),
		).toBeTruthy()
		const note = await host.team?.store.read('notes', 'Weekly draft')
		expect(note?.text).toMatch(/A short draft for the team\./)
		const state = JSON.parse(
			(await host.team?.store.read('job-states', 'draft-a-proposal-section'))?.text ?? '{}',
		)
		expect(state.claim).toBeUndefined()
		expect(state.runs[0].by).toBe('Amina')
	}, 15_000)

	it('says another member is running it, and does not run it here', async () => {
		const host = createFakeHost({ teams: ['Riverside'], teamStorage: 'webdav' })
		const store = host.team?.store
		await store?.write(
			'jobs',
			'weekly',
			'---\nid: weekly\ntitle: Weekly\ntask: draft-proposal-section\nschedule: daily 08:00\ndestination: team-note Weekly\n---\nNotes.\n',
			null,
		)
		await store?.write(
			'job-states',
			'weekly',
			JSON.stringify({
				nextDue: new Date(Date.now() - 60_000).toISOString(),
				runs: [],
				claim: { by: 'Jonas', at: new Date().toISOString() },
			}),
			null,
		)
		render(<NgomateApp host={host} />)
		const work = await screen.findByRole('complementary', { name: 'Your work' })
		await userEvent.click(within(work).getByRole('button', { name: 'Jobs' }))
		const section = await within(work).findByRole('region', { name: 'Weekly (team)' })
		expect(within(section).getByText("Running on Jonas's computer…")).toBeTruthy()
		expect(
			(within(section).getByRole('button', { name: 'Run Weekly (team) now' }) as HTMLButtonElement)
				.disabled,
		).toBe(true)
		expect(await host.listConversations()).toHaveLength(0)
	})
})

describe('a team on a synced folder', () => {
	it('makes no team jobs, because a run cannot be claimed across sync apps', async () => {
		const host = createFakeHost({ teams: ['Riverside'], teamStorage: 'folder' })
		render(<NgomateApp host={host} />)
		const work = await screen.findByRole('complementary', { name: 'Your work' })
		await userEvent.click(within(work).getByRole('button', { name: 'Jobs' }))
		await userEvent.click(within(work).getByRole('button', { name: 'New job…' }))
		await screen.findByLabelText('Task')
		expect(screen.queryByLabelText('For')).toBeNull()
		// A job for one person still writes to their own notes unless they choose the team's.
		expect((screen.getByLabelText('Write the result to') as HTMLSelectElement).value).toBe('note')
	})
})

describe('the job form', () => {
	it('says what is missing rather than making a job that cannot run', async () => {
		const host = createFakeHost()
		render(<NgomateApp host={host} />)
		const work = await screen.findByRole('complementary', { name: 'Your work' })
		await userEvent.click(within(work).getByRole('button', { name: 'Jobs' }))
		await userEvent.click(within(work).getByRole('button', { name: 'New job…' }))
		await userEvent.selectOptions(await screen.findByLabelText('Task'), 'draft-proposal-section')
		await userEvent.type(screen.getByLabelText(/funder's question/), '   ')
		await userEvent.click(screen.getByRole('button', { name: 'Make the job' }))
		expect(await screen.findByText(/^Write what the task needs/)).toBeTruthy()
		await userEvent.type(screen.getByLabelText(/funder's question/), 'Made-up notes.')
		await userEvent.type(screen.getByLabelText('Note'), 'Funding: this week')
		await userEvent.click(screen.getByRole('button', { name: 'Make the job' }))
		expect(await screen.findByText(/cannot hold any of/)).toBeTruthy()
		expect(await host.jobs?.list()).toEqual([])
	})
})

describe('the chats list', () => {
	it('leaves out only the runs of jobs that exist, matched by the whole id', async () => {
		const run = (id: string) => ({
			id,
			title: id,
			updatedAt: new Date().toISOString(),
			messages: [],
			notices: {},
		})
		const host = createFakeHost({
			conversations: [run('job-funding-run-abc-def'), run('job-funding-2-run-abc-def')],
			jobs: {
				funding: {
					text: '---\nid: funding\ntitle: Funding\ntask: find-opportunities\nschedule: daily 08:00\ndestination: note Funding\n---\nWater.\n',
				},
			},
		})
		render(<NgomateApp host={host} />)
		const work = await screen.findByRole('complementary', { name: 'Your work' })
		// The run of the deleted job "funding-2" is a chat again; the run of "funding" is under its job.
		expect(await within(work).findByText('job-funding-2-run-abc-def')).toBeTruthy()
		expect(within(work).queryByText('job-funding-run-abc-def')).toBeNull()
	})
})

describe('a team job held elsewhere', () => {
	it("is passed over, so this person's due job still runs", async () => {
		const due = new Date(Date.now() - 60_000).toISOString()
		const host = createFakeHost({
			replies: [say('Own draft.')],
			teams: ['Riverside'],
			teamStorage: 'webdav',
			jobs: {
				mine: {
					text: '---\nid: mine\ntitle: Zulu own\ntask: draft-proposal-section\nschedule: daily 08:00\ndestination: note Own\n---\nNotes.\n',
					state: { nextDue: due, runs: [] },
				},
			},
		})
		const store = host.team?.store
		// Listed first by its title, and held by another member's computer.
		await store?.write(
			'jobs',
			'alpha',
			'---\nid: alpha\ntitle: Alpha\ntask: draft-proposal-section\nschedule: daily 08:00\ndestination: team-note Alpha\n---\nNotes.\n',
			null,
		)
		await store?.write(
			'job-states',
			'alpha',
			JSON.stringify({
				nextDue: due,
				runs: [],
				claim: { by: 'Jonas', at: new Date().toISOString() },
			}),
			null,
		)
		render(<NgomateApp host={host} />)
		await waitFor(async () => expect(await host.memory.read('Own')).toMatch(/Own draft\./), {
			timeout: 5000,
		})
		const state = JSON.parse((await store?.read('job-states', 'alpha'))?.text ?? '{}')
		expect(state.claim.by).toBe('Jonas')
	})
})

describe('the chats of runs a job no longer lists', () => {
	const ran = (day: number, conversationId: string): JobRun => ({
		dueAt: new Date(2026, 10, day).toISOString(),
		ranAt: new Date(2026, 10, day).toISOString(),
		outcome: 'done',
		seen: false,
		conversationId,
	})
	const listed = (runs: JobRun[], team = false): ListedJob => ({
		key: `${team ? 'team' : 'own'}:funding`,
		id: 'funding',
		team,
		job: job(),
		problem: null,
		claimedBy: null,
		state: { ...state(), runs },
	})

	it('are deleted once older than every run still listed', () => {
		const before = [listed([ran(3, 'c'), ran(2, 'b'), ran(1, 'a')])]
		const after = [listed([ran(4, 'd'), ran(3, 'c'), ran(2, 'b')])]
		expect(droppedRuns(before, after, true)).toEqual(['a'])
	})

	it('are kept when the state started again, or the team is another one now', () => {
		expect(droppedRuns([listed([ran(1, 'a')])], [listed([])], true)).toEqual([])
		const before = [listed([ran(1, 'a')], true)]
		expect(droppedRuns(before, [listed([ran(4, 'd')], true)], false)).toEqual([])
		expect(droppedRuns(before, [listed([ran(4, 'd')], true)], true)).toEqual(['a'])
	})
})
