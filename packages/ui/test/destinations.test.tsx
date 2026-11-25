// @vitest-environment jsdom
import {
	type JobFile,
	type ModelReply,
	newJobState,
	parseJobFile,
	parseSchedule,
	serializeJobFile,
} from '@ngomate/core'
import { describe, expect, it } from 'vitest'
import { toolOptions } from '../src/JobDialog.js'
import { DEFAULT_SETTINGS } from '../src/host.js'
import { createFakeHost } from '../src/preview-host.js'
import { runJob, sendsOnlyTo } from '../src/runJob.js'
import type { ChatDeps } from '../src/useChat.js'
import { wakeList, wakeTimeOf } from '../src/wakeTimes.js'

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

const TOOLS = [
	{
		name: 'send_email',
		description: 'Send an email',
		inputSchema: {
			type: 'object',
			properties: { to: { type: 'string' }, cc: { type: 'string' }, body: { type: 'string' } },
			required: ['to', 'body'],
		},
	},
	{
		name: 'save_page',
		description: 'Save a wiki page',
		inputSchema: {
			type: 'object',
			properties: { space: { type: 'string' }, content: { type: 'string' } },
		},
	},
]

/** A host with one made-up connector whose tools only record what they were called with. */
function setup(replies: ModelReply[]) {
	const files = new Map<string, string>()
	const host = createFakeHost({ replies, files })
	const called: { name: string; args: Record<string, unknown> }[] = []
	host.connectAddon = async () => ({
		listTools: async () => TOOLS,
		callTool: async (name, args) => {
			called.push({ name, args })
			return { text: 'Done.', isError: false }
		},
		close: async () => {},
	})
	const settings = {
		...DEFAULT_SETTINGS,
		model: { kind: 'server' as const, baseUrl: 'http://fake', model: 'fake' },
		addons: [
			{
				id: 'office',
				name: 'Made-up office',
				connection: { kind: 'http' as const, url: 'https://office.example/mcp' },
				enabled: true,
				allowDestructive: false,
			},
		],
	}
	const chat: ChatDeps = {
		host,
		settings,
		getModel: async () => ({ client: host.createModelClient('http://fake', 'fake') }),
		onSaved: () => {},
	}
	return { host, files, called, deps: { chat, tasks: host.tasks, teamTasks: [] } }
}

const job = (overrides: Partial<JobFile> = {}): JobFile => ({
	id: 'update',
	title: 'Team update',
	task: 'find-opportunities',
	schedule: parseSchedule('weekly mon 09:00'),
	destination: { kind: 'note', name: 'Update' },
	inputs: 'A made-up water group.',
	...overrides,
})

const signal = new AbortController().signal
const due = new Date(2026, 10, 30, 9)
const state = () => ({ ...newJobState(job(), new Date(2026, 10, 24)), nextDue: due.toISOString() })
const SEND = { tool: 'send_email', to: { to: 'team@example.org' } }

describe('sending on its own', () => {
	it('only with the fixed tool, to exactly the fixed recipients, and no one else', () => {
		expect(
			sendsOnlyTo({ tool: 'send_email', args: { to: 'Team@Example.org', body: 'x' } }, SEND),
		).toBe(true)
		expect(sendsOnlyTo({ tool: 'send_email', args: { to: 'other@example.org' } }, SEND)).toBe(false)
		expect(
			sendsOnlyTo(
				{ tool: 'send_email', args: { to: 'team@example.org', cc: 'x@example.org' } },
				SEND,
			),
		).toBe(false)
		expect(sendsOnlyTo({ tool: 'post_message', args: { to: 'team@example.org' } }, SEND)).toBe(
			false,
		)
	})

	it('sends a message to the fixed recipients after the result is saved, when the checks found nothing', async () => {
		const { called, deps } = setup([
			call('send_email', { to: 'team@example.org', body: 'This week: nothing new.' }),
			say('Nothing new this week.'),
		])
		const after = await runJob(deps, job({ send: SEND }), state(), signal, () => due)
		expect(called).toEqual([
			{ name: 'send_email', args: { to: 'team@example.org', body: 'This week: nothing new.' } },
		])
		expect(after.runs[0]?.outcome).toBe('done')
		expect(after.runs[0]?.changes?.[0]).toMatchObject({ decision: 'made', auto: true })
	})

	it('waits for the person when the message names anyone else', async () => {
		const { called, deps } = setup([
			call('send_email', { to: 'team@example.org', cc: 'press@example.org', body: 'Hi' }),
			say('Done.'),
		])
		const after = await runJob(deps, job({ send: SEND }), state(), signal, () => due)
		expect(called).toEqual([])
		expect(after.runs[0]?.outcome).toBe('waiting')
		expect(after.runs[0]?.changes?.[0]?.decision).toBe('waiting')
	})

	it('holds it for the person when the checks found something in that run', async () => {
		const { called, deps } = setup([
			call('send_email', { to: 'team@example.org', body: 'The update is in the notes.' }),
			say('Apply by 2031-05-05.'),
		])
		const after = await runJob(deps, job({ send: SEND }), state(), signal, () => due)
		expect(called).toEqual([])
		expect(after.runs[0]?.changes?.[0]?.held).toMatch(/checks found something/)
		expect(after.runs[0]?.outcome).toBe('waiting')
	})

	it('never sends on its own without the setting, even to the same people', async () => {
		const { called, deps } = setup([
			call('send_email', { to: 'team@example.org', body: 'x' }),
			say('ok'),
		])
		await runJob(deps, job(), state(), signal, () => due)
		expect(called).toEqual([])
	})
})

describe('where a result goes', () => {
	it('to a new file in the chosen folder, never over one there', async () => {
		const { files, deps } = setup([say('First.'), say('Second.')])
		const toFile = job({ destination: { kind: 'file', name: 'Update', folder: '/Reports' } })
		const first = await runJob(deps, toFile, state(), signal, () => due)
		const second = await runJob(deps, toFile, state(), signal, () => due)
		expect(first.runs[0]?.note).toBe('Update.md')
		expect(second.runs[0]?.note).toBe('Update (2).md')
		expect(files.get('/Reports/Update.md')).toMatch(/First\./)
		expect(files.get('/Reports/Update (2).md')).toMatch(/Second\./)
	})

	it('to a connector tool, with what was fixed and the result in its field', async () => {
		const { called, deps } = setup([say('The summary.')])
		const toTool = job({
			destination: { kind: 'tool', name: 'save_page', field: 'content', args: { space: 'Team' } },
		})
		const after = await runJob(deps, toTool, state(), signal, () => due)
		expect(after.runs[0]?.outcome).toBe('done')
		expect(called[0]?.name).toBe('save_page')
		expect(called[0]?.args.space).toBe('Team')
		expect(String(called[0]?.args.content)).toMatch(/Written by NGOmate[\s\S]*The summary\./)
	})

	it('is kept in the job file, and a file without its folder is refused', () => {
		const sends = job({
			destination: { kind: 'tool', name: 'save_page', field: 'content', args: { space: 'Team' } },
			send: SEND,
		})
		expect(parseJobFile(serializeJobFile(sends))).toEqual(sends)
		const toFile = job({ destination: { kind: 'file', name: 'Update {date}', folder: '/Reports' } })
		expect(parseJobFile(serializeJobFile(toFile))).toEqual(toFile)
		expect(() =>
			parseJobFile(serializeJobFile(toFile).replace('folder: /Reports', 'folder: Reports')),
		).toThrow('whole path')
		expect(() => parseJobFile(serializeJobFile(sends).replace(/send-to: .*\n/, ''))).toThrow(
			'recipients, fixed',
		)
	})
})

describe('starting NGOmate for a job', () => {
	it('at the next date on this computer’s clock, kept as daily, weekly or monthly', () => {
		const monday = new Date(2026, 10, 30, 9, 15)
		expect(wakeTimeOf(parseSchedule('daily 09:15'), monday)).toEqual({ hour: 9, minute: 15 })
		expect(wakeTimeOf(parseSchedule('weekly mon 09:15'), monday)).toEqual({
			hour: 9,
			minute: 15,
			weekday: 1,
		})
		expect(wakeTimeOf(parseSchedule('monthly 28 09:15'), new Date(2026, 11, 29, 9, 15))).toEqual({
			hour: 9,
			minute: 15,
			day: 28,
		})
		const time = { hour: 9, minute: 0 }
		expect(wakeList([time, { ...time }])).toEqual([time])
	})
})

describe('a run started before its date', () => {
	it('is named for the day it ran, and keeps the date it was due for', async () => {
		const { deps } = setup([say('Early.')])
		const named = job({ destination: { kind: 'note', name: 'Update {date}' } })
		const early = new Date(2026, 10, 25, 18)
		const after = await runJob(deps, named, state(), signal, () => early)
		expect(after.runs[0]?.note).toBe('Update 2026-11-25')
		expect(after.nextDue).toBe(due.toISOString())
	})
})

describe('the tools a job may write to or send with', () => {
	it('are those that write, delete nothing and have a text field to fill', () => {
		const text = { type: 'object', properties: { body: { type: 'string' } } }
		const options = toolOptions([
			{ ...TOOLS[0], annotations: {} } as never,
			{ name: 'search', description: '', inputSchema: text, annotations: { readOnly: true } },
			{ name: 'wipe', description: '', inputSchema: text, annotations: { destructive: true } },
			{ name: 'ping', description: '', inputSchema: { type: 'object', properties: {} } },
			{ name: 'delete_page', description: '', inputSchema: text },
		])
		expect(options.map((option) => option.name)).toEqual(['send_email'])
	})
})
