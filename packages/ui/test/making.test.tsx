// @vitest-environment jsdom
import {
	type JobFile,
	type ModelReply,
	parseSchedule,
	parseTaskFile,
	serializeTaskFile,
} from '@ngomate/core'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { NgomateApp } from '../src/NgomateApp.js'
import {
	NEW_TASK,
	applyDraftCall,
	draftFromTask,
	emptyDraft,
	jobFromDraft,
	keepFormSettings,
	missingFromDraft,
	parseDraft,
	taskFromDraft,
} from '../src/drafts.js'
import { createFakeHost } from '../src/preview-host.js'

afterEach(cleanup)

/** Opens a list item's "⋯" menu and picks one of its actions. */
async function choose(scope: HTMLElement, item: string | RegExp, action: string | RegExp) {
	await userEvent.click(
		await within(scope).findByRole('button', {
			name:
				typeof item === 'string'
					? `Actions for ${item}`
					: new RegExp(`^Actions for ${item.source}`),
		}),
	)
	await userEvent.click(await screen.findByRole('button', { name: action }))
}

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

const CONTEXT = {
	tasks: [{ id: 'draft-proposal-section', title: 'Draft a proposal section', ask: 'Your notes' }],
	teamNotes: false,
	teamJobs: false,
}

const OWN_TASK = {
	id: 'funder-check',
	title: 'Funder page check',
	description: 'Says what changed on a funder page.',
	ask: 'The funder and its web page',
	tools: 'none' as const,
	instructions: 'Compare the page with what the person gives you and list what changed.',
}

describe('a draft made in words', () => {
	it('takes what passes, and leaves out what does not, never guessed', () => {
		const { draft, problems } = applyDraftCall(
			emptyDraft('job'),
			{
				title: 'Funding this week',
				task: 'no-such-task',
				schedule: 'every monday',
				note: 'a/b',
				inputs: 'A made-up water group.',
			},
			CONTEXT,
		)
		expect(draft.job).toEqual({ title: 'Funding this week', inputs: 'A made-up water group.' })
		expect(problems).toHaveLength(3)
		expect(missingFromDraft(draft)).toEqual(['which task it runs', 'when it runs'])
	})

	it('reads a schedule in its own words, and a new task drafted beside the job', () => {
		const { draft } = applyDraftCall(
			emptyDraft('job'),
			{
				task: NEW_TASK,
				schedule: 'weekly MON 9:00',
				new_task: { title: 'Funder page check', instructions: 'List what changed.' },
			},
			CONTEXT,
		)
		expect(draft.job.schedule).toBe('weekly mon 09:00')
		expect(draft.task).toEqual({ title: 'Funder page check', instructions: 'List what changed.' })
		expect(missingFromDraft(draft)).toContain('the new task: what it asks for')
	})

	it('makes a job file that reads back as it was drafted', () => {
		const job = jobFromDraft(
			{ title: 'Funding', inputs: 'Water.', schedule: 'daily 08:00', note: 'Funding {date}' },
			{ taskId: 'mine:funder-check', taken: [], zone: 'UTC', teamId: null, fromTeamTask: false },
		)
		expect(job).toMatchObject({
			id: 'funding',
			task: 'mine:funder-check',
			destination: { kind: 'note', name: 'Funding {date}' },
		})
		expect(job.zone).toBeUndefined()
	})

	it('makes a task file that the task reader takes back unchanged', () => {
		const task = taskFromDraft({ ...OWN_TASK, tools: 'all' }, 'funder-check')
		expect(parseTaskFile(serializeTaskFile(task))).toEqual(task)
		expect(task.needs).toBe('addon')
	})
})

describe('your own tasks', () => {
	it('keep what was said in words when you switch to the form', async () => {
		const host = createFakeHost({})
		render(<NgomateApp host={host} />)
		const work = await screen.findByRole('complementary', { name: 'Your work' })
		await userEvent.click(within(work).getByRole('button', { name: 'Tasks' }))
		await userEvent.click(within(work).getByRole('button', { name: 'New task…' }))
		await userEvent.type(
			await screen.findByLabelText('Tell me what you want'),
			'Check a funder page',
		)
		await userEvent.click(screen.getByRole('button', { name: 'Fill it in myself' }))
		expect((screen.getByLabelText('What it is for') as HTMLTextAreaElement).value).toBe(
			'Check a funder page',
		)
	})

	it('are made in the form, listed as yours, and run like any task', async () => {
		const host = createFakeHost({})
		render(<NgomateApp host={host} />)
		const work = await screen.findByRole('complementary', { name: 'Your work' })
		await userEvent.click(within(work).getByRole('button', { name: 'Tasks' }))
		await userEvent.click(within(work).getByRole('button', { name: 'New task…' }))
		await userEvent.click(await screen.findByRole('button', { name: 'Fill it in myself' }))
		await userEvent.type(screen.getByLabelText('Name'), OWN_TASK.title)
		await userEvent.click(screen.getByRole('button', { name: 'Make the task' }))
		expect(await screen.findByText('Say in a line what the task is for.')).toBeTruthy()
		await userEvent.type(screen.getByLabelText('What it is for'), OWN_TASK.description)
		await userEvent.type(screen.getByLabelText(/asks you for/), OWN_TASK.ask)
		await userEvent.type(
			screen.getByLabelText('What the assistant should do'),
			OWN_TASK.instructions,
		)
		await userEvent.click(screen.getByRole('button', { name: 'Make the task' }))

		await within(work).findByRole('button', { name: OWN_TASK.title })
		const [stored] = (await host.ownTasks?.list()) ?? []
		expect(stored?.id).toBe('funder-page-check')
		expect(stored?.text).toMatch(/^---\nid: funder-page-check\ntitle: Funder page check\n/)
	})

	it('cannot be deleted while a job runs it', async () => {
		const host = createFakeHost({
			ownTasks: { 'funder-check': serializeTaskFile(OWN_TASK) },
			jobs: {
				watch: {
					text: '---\nid: watch\ntitle: Watch\ntask: mine:funder-check\nschedule: daily 08:00\ndestination: note Watch\n---\nA made-up fund.\n',
				},
			},
		})
		render(<NgomateApp host={host} />)
		const work = await screen.findByRole('complementary', { name: 'Your work' })
		await userEvent.click(within(work).getByRole('button', { name: 'Tasks' }))
		await choose(work, OWN_TASK.title, 'Delete')
		expect(await screen.findByText(/Watch runs this task/)).toBeTruthy()
		expect(screen.queryByRole('button', { name: 'Delete it' })).toBeNull()
	})
})

describe('making a job in words', () => {
	it('drafts it in a chat with a card above, and saves it only when the person says so', async () => {
		const host = createFakeHost({
			replies: [
				call('draft_job', {
					title: 'Proposal draft',
					task: 'draft-proposal-section',
					inputs: 'Made-up notes on a well.',
					schedule: 'weekly mon 09:00',
					note: 'Draft {date}',
				}),
				say('Every Monday it drafts a section into a note. Save it with Make it.'),
			],
		})
		render(<NgomateApp host={host} />)
		const work = await screen.findByRole('complementary', { name: 'Your work' })
		await userEvent.click(within(work).getByRole('button', { name: 'Jobs' }))
		await userEvent.click(within(work).getByRole('button', { name: 'New job…' }))
		await userEvent.type(
			await screen.findByLabelText('Tell me what you want'),
			'Every Monday, draft a proposal section from my well notes.',
		)
		await userEvent.click(screen.getByRole('button', { name: 'Start' }))

		const card = await screen.findByRole('region', { name: 'Job being made in this chat' })
		await within(card).findByText(/^Every Monday at 09:00, runs Draft a proposal section/)
		await screen.findByText(/Save it with Make it/)
		// Listed with the jobs while it is not saved, and nothing is made yet.
		expect(await within(work).findByText('· draft')).toBeTruthy()
		expect(await host.jobs?.list()).toEqual([])

		await waitFor(() =>
			expect(within(card).getByRole('button', { name: 'Make it' })).toHaveProperty(
				'disabled',
				false,
			),
		)
		await userEvent.click(within(card).getByRole('button', { name: 'Make it' }))
		const saved = await screen.findByRole('region', { name: 'Job made in this chat' })
		expect(within(saved).getByText(/Saved as Proposal draft/)).toBeTruthy()
		const [stored] = (await host.jobs?.list()) ?? []
		expect(stored?.text).toMatch(/task: draft-proposal-section\nschedule: weekly mon 09:00/)
		await waitFor(() => expect(within(work).queryByText('· draft')).toBeNull())
		expect(within(work).getByRole('region', { name: 'Proposal draft' })).toBeTruthy()
	})

	it('starts from an answer in a normal chat', async () => {
		const host = createFakeHost({
			replies: [
				say('Here is what changed on the made-up fund page.'),
				call('draft_task', { ...OWN_TASK, id: undefined }),
				say('It is ready to save.'),
			],
		})
		render(<NgomateApp host={host} />)
		await userEvent.type(
			await screen.findByLabelText('Message'),
			'What changed on this page?{Enter}',
		)
		await screen.findByText('Here is what changed on the made-up fund page.')
		await userEvent.click(screen.getByRole('button', { name: 'Make a task or job from this' }))
		await userEvent.click(screen.getByRole('button', { name: 'As a task you run again' }))
		const card = await screen.findByRole('region', { name: 'Task being made in this chat' })
		await within(card).findByText(/^Funder page check: Says what changed/)
		// Saved only once the answer is written: while it is, the draft may still change.
		await screen.findByText('It is ready to save.')
		await waitFor(() =>
			expect(within(card).getByRole('button', { name: 'Make it' })).toHaveProperty(
				'disabled',
				false,
			),
		)
		await userEvent.click(within(card).getByRole('button', { name: 'Make it' }))
		await screen.findByRole('region', { name: 'Task made in this chat' })
		const [stored] = (await host.ownTasks?.list()) ?? []
		expect(stored?.text).toMatch(/title: Funder page check/)
	})
})

describe('changing a job', () => {
	it('in the chat keeps a folder or tool to write to, and sending on its own, set in the form', () => {
		const job = (overrides: Partial<JobFile>): JobFile => ({
			id: 'funding',
			title: 'Funding',
			task: 'find-opportunities',
			schedule: parseSchedule('weekly mon 09:00'),
			destination: { kind: 'note', name: 'Funding' },
			inputs: 'Water.',
			...overrides,
		})
		const drafted = job({ destination: { kind: 'note', name: 'Funding' } })
		const toFile = job({
			destination: { kind: 'file', name: 'Funding', folder: '/Reports' },
			send: { tool: 'send_email', to: { to: 'team@example.org' } },
		})
		expect(keepFormSettings(drafted, toFile, 'Funding {date}')).toEqual({
			...drafted,
			destination: { kind: 'file', name: 'Funding {date}', folder: '/Reports' },
			send: { tool: 'send_email', to: { to: 'team@example.org' } },
		})
		const toTool = job({
			destination: { kind: 'tool', name: 'save_page', field: 'body', args: {} },
		})
		expect(keepFormSettings(drafted, toTool).destination).toEqual(toTool.destination)
		expect(keepFormSettings(drafted, undefined)).toEqual(drafted)
	})

	it('keeps its runs, and moves its next date to the new schedule', async () => {
		const run = {
			dueAt: '2026-11-23T08:00:00.000Z',
			ranAt: '2026-11-23T08:00:00.000Z',
			outcome: 'done' as const,
			seen: true,
			note: 'Funding',
		}
		const host = createFakeHost({
			jobs: {
				funding: {
					text: '---\nid: funding\ntitle: Funding\ntask: draft-proposal-section\nschedule: daily 08:00\ndestination: note Funding\n---\nWater.\n',
					state: { nextDue: '2026-11-26T08:00:00.000Z', runs: [run] },
				},
			},
		})
		render(<NgomateApp host={host} />)
		const work = await screen.findByRole('complementary', { name: 'Your work' })
		await userEvent.click(within(work).getByRole('button', { name: 'Jobs' }))
		const section = await within(work).findByRole('region', { name: 'Funding' })
		await choose(section, 'Funding', 'Edit')
		await userEvent.selectOptions(await screen.findByLabelText('How often'), 'month')
		await userEvent.click(screen.getByRole('button', { name: 'Save the changes' }))

		await within(section).findByText(/^On day 1 of every month at 08:00\. Next: /)
		const [stored] = (await host.jobs?.list()) ?? []
		expect(stored?.text).toMatch(/schedule: monthly 1 08:00/)
		expect(stored?.state?.runs).toEqual([run])
		expect(stored?.state?.nextDue).not.toBe('2026-11-26T08:00:00.000Z')
	})
})

describe('what a small model sends', () => {
	it('is read with full day names, and said back when it is in the wrong place', () => {
		const { draft, problems } = applyDraftCall(
			emptyDraft('job'),
			{
				schedule: 'Weekly Monday 9:00',
				instructions: 'Check the page.',
				new_task: '{"title":"Page check"}',
			},
			CONTEXT,
		)
		expect(draft.job.schedule).toBe('weekly mon 09:00')
		expect(draft.task.title).toBe('Page check')
		// Only a weekday is shortened: "monthly" is not a Monday.
		for (const [given, read] of [
			['Monthly 15 9:00', 'monthly 15 09:00'],
			['monthly 1 09:00', 'monthly 1 09:00'],
			['weekly Sunday 18:30', 'weekly sun 18:30'],
		])
			expect(
				applyDraftCall(emptyDraft('job'), { schedule: given }, CONTEXT).draft.job.schedule,
			).toBe(read)
		expect(problems).toEqual(['instructions belongs inside new_task.'])
	})

	it('keeps the tools a task names when it is changed', () => {
		const named = { ...OWN_TASK, tools: ['search', 'fetch'] }
		const draft = draftFromTask(named, { key: 'mine:funder-check' })
		expect(draft.task.tools).toEqual(['search', 'fetch'])
		expect(taskFromDraft(draft.task, 'funder-check')).toEqual({ ...named })
	})

	it('reads a stored draft it does not know as an ordinary chat', () => {
		expect(parseDraft({ kind: 'report' })).toBeUndefined()
		expect(parseDraft(null)).toBeUndefined()
		expect(parseDraft({ kind: 'job', job: { schedule: 5, title: 'Rota' } })).toEqual({
			kind: 'job',
			task: {},
			job: { title: 'Rota' },
		})
	})
})

describe('a draft in a chat', () => {
	const MAKING = {
		id: 'making',
		title: 'Volunteer rota',
		updatedAt: new Date().toISOString(),
		messages: [
			{ role: 'user' as const, content: 'Every Friday, the volunteer rota.' },
			{ role: 'assistant' as const, content: 'Which notes should it use?' },
		],
		notices: {},
		draft: { kind: 'job' as const, task: {}, job: { title: 'Rota', schedule: 'weekly fri 15:00' } },
	}

	it('is listed while it is being made, and gone once discarded', async () => {
		const host = createFakeHost({
			conversations: [MAKING],
			settings: { drafts: { making: 'job' } },
		})
		render(<NgomateApp host={host} />)
		const work = await screen.findByRole('complementary', { name: 'Your work' })
		await userEvent.click(within(work).getByRole('button', { name: 'Jobs' }))
		await userEvent.click(await within(work).findByRole('button', { name: /Volunteer rota/ }))
		const card = await screen.findByRole('region', { name: 'Job being made in this chat' })
		expect(within(card).getByText(/Still to say: which task it runs/)).toBeTruthy()
		await userEvent.click(within(card).getByRole('button', { name: 'Discard' }))
		await waitFor(() =>
			expect(screen.queryByRole('region', { name: 'Job being made in this chat' })).toBeNull(),
		)
		await waitFor(() => expect(within(work).queryByText('Being made')).toBeNull())
		expect((await host.readConversation('making'))?.draft).toBeUndefined()
	})
})

describe('deleting a task of your own', () => {
	it('removes its file when no job runs it', async () => {
		const host = createFakeHost({ ownTasks: { 'funder-check': serializeTaskFile(OWN_TASK) } })
		render(<NgomateApp host={host} />)
		const work = await screen.findByRole('complementary', { name: 'Your work' })
		await userEvent.click(within(work).getByRole('button', { name: 'Tasks' }))
		await choose(work, OWN_TASK.title, 'Delete')
		await userEvent.click(await screen.findByRole('button', { name: 'Delete it' }))
		await waitFor(async () => expect(await host.ownTasks?.list()).toEqual([]))
	})
})

describe('what the checks found under an answer', () => {
	it('is not drawn when they found nothing', async () => {
		const { noticeSaysSomething } = await import('../src/Chat.js')
		const nothing = { unsourcedDates: [], unsourcedLinks: [], checkFigures: false, stopped: null }
		expect(noticeSaysSomething(nothing)).toBe(false)
		expect(noticeSaysSomething({ ...nothing, unsourcedDates: ['2031-05-05'] })).toBe(true)
	})
})

describe('the shared frame of lists and dialogs', () => {
	it('keeps a row’s actions shown while its menu is open, so the pointer can reach it', async () => {
		const host = createFakeHost({ ownTasks: { 'funder-check': serializeTaskFile(OWN_TASK) } })
		render(<NgomateApp host={host} />)
		const work = await screen.findByRole('complementary', { name: 'Your work' })
		await userEvent.click(within(work).getByRole('button', { name: 'Tasks' }))
		const opener = await within(work).findByRole('button', {
			name: `Actions for ${OWN_TASK.title}`,
		})
		const strip = opener.closest('.ngm-side-actions') as HTMLElement
		expect(strip.hasAttribute('data-open')).toBe(false)
		await userEvent.click(opener)
		expect(strip.hasAttribute('data-open')).toBe(true)
		// The assistant's route comes first in the menu.
		const items = within(strip)
			.getAllByRole('button')
			.filter((each) => each !== opener)
		expect(items[0]?.textContent).toBe('Change in chat')
		await userEvent.keyboard('{Escape}')
		expect(strip.hasAttribute('data-open')).toBe(false)
	})

	it('puts Cancel first and the main button last, and the cursor in the first field', async () => {
		const host = createFakeHost({})
		render(<NgomateApp host={host} />)
		const work = await screen.findByRole('complementary', { name: 'Your work' })
		await userEvent.click(within(work).getByRole('button', { name: 'Tasks' }))
		await userEvent.click(within(work).getByRole('button', { name: 'New task…' }))
		const field = await screen.findByLabelText('Tell me what you want')
		expect(document.activeElement).toBe(field)
		const dialog = field.closest('dialog') as HTMLElement
		const buttons = [...dialog.querySelectorAll('.ngm-dialog-actions > .ngm-button')]
		expect(buttons.map((each) => each.textContent)).toEqual(['Cancel', 'Start'])
		expect(
			within(dialog)
				.getByRole('button', { name: 'Fill it in myself' })
				.closest('.ngm-dialog-alternative'),
		).toBeTruthy()
	})
})

describe('voice input', () => {
	it('asks once to fetch the voice model, then writes what was said into the message', async () => {
		const host = createFakeHost({ voice: { heard: 'Find new funding for water projects.' } })
		render(<NgomateApp host={host} />)
		const mic = await screen.findByRole('button', { name: 'Speak' })
		await userEvent.click(mic)
		// Nothing is fetched without asking: the size is said first.
		const dialog = await screen.findByRole('dialog', { name: 'Speak instead of typing' })
		expect(within(dialog).getByText(/one-time download of 57 MB/)).toBeTruthy()
		await userEvent.click(within(dialog).getByRole('button', { name: /^Download/ }))
		await waitFor(async () => expect((await host.voice?.info())?.models[0]?.installed).toBe(true))

		await userEvent.click(screen.getByRole('button', { name: 'Speak' }))
		expect(await screen.findByText(/^Listening… 0:0\d/)).toBeTruthy()
		await userEvent.click(screen.getByRole('button', { name: 'Stop and write it down' }))
		await waitFor(() =>
			expect((screen.getByLabelText('Message') as HTMLTextAreaElement).value).toBe(
				'Find new funding for water projects.',
			),
		)
		// Written down, not sent: the person reads it first.
		expect(await host.listConversations()).toEqual([])
	})

	it('is managed under Built-in tools', async () => {
		const host = createFakeHost({ voice: { heard: 'x', installed: ['whisper-base-q5'] } })
		render(<NgomateApp host={host} />)
		await userEvent.click(await screen.findByRole('button', { name: 'Built-in tools' }))
		const card = await screen.findByRole('region', { name: 'Voice' })
		expect(await within(card).findByText('In use')).toBeTruthy()
		expect(within(card).getAllByRole('button', { name: 'Download' })).toHaveLength(2)
	})
})
