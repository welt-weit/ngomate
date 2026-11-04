import { describe, expect, it, vi } from 'vitest'
import { type TaskProfile, fitHistory, runTask } from '../src/agent.js'
import type { ToolSource } from '../src/mcp.js'
import type { ModelClient, ModelReply, ToolDefinition } from '../src/model.js'

const profile: TaskProfile = {
	id: 'test',
	instructions: 'Do the task.',
	readTools: ['search'],
	writeTools: ['create'],
}

function source(
	callTool = vi.fn(async () => ({ text: 'result', isError: false })),
	extra: ToolDefinition[] = [],
) {
	const tools: ToolSource = {
		listTools: async () => [
			...['search', 'create'].map((name) => ({ name, description: name, inputSchema: {} })),
			...extra,
		],
		callTool,
		close: async () => {},
	}
	return { tools, callTool }
}

const call = (name: string, args: unknown): ModelReply => ({
	content: null,
	toolCalls: [{ id: `c-${name}-${JSON.stringify(args)}`, name, arguments: JSON.stringify(args) }],
	promptTokens: 1,
	completionTokens: 1,
})
const say = (content: string): ModelReply => ({
	content,
	toolCalls: [],
	promptTokens: 1,
	completionTokens: 1,
})

function scripted(...replies: ModelReply[]) {
	const chat = vi.fn(async () => {
		const next = replies.shift()
		if (!next) throw new Error('script ran out')
		return next
	})
	return { model: { chat } as ModelClient, chat }
}

const failing = () => vi.fn(async () => ({ text: 'no such element', isError: true }))

describe('stopping a run', () => {
	it('stops after three failures in a row and still reports where it got to', async () => {
		const { model, chat } = scripted(
			call('search', { q: 1 }),
			call('search', { q: 2 }),
			call('search', { q: 3 }),
			say('I could not read the page.'),
		)
		const run = await runTask({ model, tools: source(failing()).tools, profile, input: 'go' })
		expect(run.status).toBe('stuck')
		expect(run.answer).toBe('I could not read the page.')
		const last = chat.mock.calls.at(-1) as unknown as [{ tools: unknown[] }]
		expect(last[0].tools).toEqual([])
	})

	it('does not count a refusal by the person as a failure', async () => {
		const { model } = scripted(
			call('create', { a: 1 }),
			call('create', { a: 2 }),
			call('create', { a: 3 }),
			say('Understood.'),
		)
		const run = await runTask({
			model,
			tools: source().tools,
			profile,
			input: 'go',
			confirmWrite: async () => false,
		})
		expect(run.status).toBe('completed')
	})

	it('refuses the same call twice without running it again', async () => {
		const { model } = scripted(call('search', { q: 1 }), call('search', { q: 1 }), say('done'))
		const { tools, callTool } = source()
		const run = await runTask({ model, tools, profile, input: 'go' })
		expect(callTool).toHaveBeenCalledTimes(1)
		expect(run.calls[1]?.outcome).toBe('repeated_call')
	})

	it('stops at the call limit, so a service billing per call cannot run away', async () => {
		const { model } = scripted(
			call('search', { q: 1 }),
			call('search', { q: 2 }),
			say('as far as I got'),
		)
		const { tools, callTool } = source()
		const run = await runTask({ model, tools, profile, input: 'go', maxToolCalls: 2 })
		expect(run.status).toBe('call_limit')
		expect(callTool).toHaveBeenCalledTimes(2)
	})

	it('answers every call in a turn even when the run stops partway', async () => {
		const both: ModelReply = {
			...say(''),
			content: null,
			toolCalls: [
				{ id: 'a', name: 'search', arguments: '{"q":1}' },
				{ id: 'b', name: 'search', arguments: '{"q":2}' },
			],
		}
		const { model, chat } = scripted(both, say('stopped'))
		const { tools } = source()
		await runTask({ model, tools, profile, input: 'go', maxToolCalls: 1 })
		const last = chat.mock.calls.at(-1) as unknown as [
			{ messages: { role: string; toolCallId?: string }[] },
		]
		expect(
			last[0].messages.filter((message) => message.role === 'tool').map((m) => m.toolCallId),
		).toEqual(['a', 'b'])
	})

	it('reports a cancelled run without another model turn', async () => {
		const controller = new AbortController()
		const { model, chat } = scripted(call('search', { q: 1 }), say('never'))
		const { tools } = source(
			vi.fn(async () => {
				controller.abort()
				return { text: 'result', isError: false }
			}),
		)
		const run = await runTask({ model, tools, profile, input: 'go', signal: controller.signal })
		expect(run.status).toBe('cancelled')
		expect(chat).toHaveBeenCalledTimes(1)
	})
})

describe('what a tool or answer may claim', () => {
	it('refuses a write with a link no tool returned, before asking', async () => {
		const { model } = scripted(call('create', { url: 'https://made-up.example/call' }), say('ok'))
		const confirmWrite = vi.fn(async () => true)
		const run = await runTask({ model, tools: source().tools, profile, input: 'go', confirmWrite })
		expect(confirmWrite).not.toHaveBeenCalled()
		expect(run.calls[0]?.outcome).toBe('unsourced_link')
	})

	it('flags a link and a date in the answer that nothing supplied', async () => {
		const { model } = scripted(
			call('search', {}),
			say(
				'See https://real.example/a. and https://made-up.example/b, closing 2027-05-01, opened 2027-01-02.',
			),
		)
		const { tools } = source(
			vi.fn(async () => ({ text: 'https://real.example/a opened 2 January 2027', isError: false })),
		)
		const run = await runTask({ model, tools, profile, input: 'go' })
		expect(run.unsourcedLinks).toEqual(['https://made-up.example/b'])
		expect(run.unsourcedDates).toEqual(['2027-05-01'])
	})

	it("does not treat the model's own earlier words as a source", async () => {
		const { model } = scripted(say('Closes 2027-05-01.'))
		const run = await runTask({
			model,
			tools: source().tools,
			profile,
			input: 'and the date?',
			history: [
				{ role: 'user', content: 'when?' },
				{ role: 'assistant', content: 'Closes 2027-05-01.' },
			],
		})
		expect(run.unsourcedDates).toEqual(['2027-05-01'])
	})

	it('cuts a long tool result and tells the model', async () => {
		const { model, chat } = scripted(call('search', {}), say('ok'))
		const { tools } = source(vi.fn(async () => ({ text: 'x'.repeat(500), isError: false })))
		await runTask({ model, tools, profile, input: 'go', maxToolResultChars: 100 })
		const last = chat.mock.calls.at(-1) as unknown as [
			{ messages: { role: string; content: string }[] },
		]
		const result = last[0].messages.find((message) => message.role === 'tool')
		expect(result?.content.length).toBeLessThan(200)
		expect(result?.content).toContain('only the first 100 of 500')
	})
})

describe('open chat', () => {
	const marked: ToolDefinition[] = [
		{ name: 'read_it', description: '', inputSchema: {}, annotations: { readOnly: true } },
		{ name: 'unmarked', description: '', inputSchema: {} },
	]
	const open: TaskProfile = {
		id: 'chat',
		instructions: 'Help.',
		readTools: [],
		writeTools: [],
		allTools: true,
	}

	it('treats only a tool marked read-only as a read', async () => {
		const { model } = scripted(call('read_it', {}), call('unmarked', {}), say('ok'))
		const { tools, callTool } = source(undefined, marked)
		const confirmWrite = vi.fn(async () => false)
		await runTask({ model, tools, profile: open, input: 'go', confirmWrite })
		expect(confirmWrite).toHaveBeenCalledTimes(1)
		expect(confirmWrite).toHaveBeenCalledWith({ tool: 'unmarked', args: {} })
		expect(callTool).toHaveBeenCalledTimes(1)
	})

	it('continues a conversation from the last run', async () => {
		const first = await runTask({
			model: scripted(say('Hello.')).model,
			tools: source().tools,
			profile: open,
			input: 'hi',
		})
		const { model, chat } = scripted(say('Again.'))
		const second = await runTask({
			model,
			tools: source().tools,
			profile: open,
			input: 'more',
			history: first.messages,
		})
		const request = chat.mock.calls[0] as unknown as [
			{ messages: { role: string; content: string }[] },
		]
		expect(request[0].messages.map((message) => message.content).slice(1, 4)).toEqual([
			'hi',
			'Hello.',
			'more',
		])
		expect(second.messages).toHaveLength(4)
	})
})

describe('a long chain of tool calls', () => {
	it('gives up the oldest results to stay within what the model can hold', async () => {
		const { model, chat } = scripted(
			call('search', { q: 1 }),
			call('search', { q: 2 }),
			say('done'),
		)
		const { tools } = source(vi.fn(async () => ({ text: 'r'.repeat(500), isError: false })))
		await runTask({ model, tools, profile, input: 'go', maxInputChars: 800 })
		const last = chat.mock.calls.at(-1) as unknown as [
			{ messages: { role: string; content: string }[] },
		]
		const results = last[0].messages.filter((message) => message.role === 'tool')
		expect(results[0]?.content).toContain('Removed to make room')
		expect(results[1]?.content).toBe('r'.repeat(500))
	})

	it('lets the model read a removed result again', async () => {
		const { model } = scripted(
			call('search', { q: 1 }),
			call('search', { q: 2 }),
			call('search', { q: 1 }),
			say('done'),
		)
		const { tools, callTool } = source(
			vi.fn(async () => ({ text: 'r'.repeat(500), isError: false })),
		)
		const run = await runTask({ model, tools, profile, input: 'go', maxInputChars: 800 })
		expect(callTool).toHaveBeenCalledTimes(3)
		expect(run.calls.every((record) => record.outcome === 'ok')).toBe(true)
	})
})

describe('fitHistory', () => {
	const history = [
		{ role: 'user' as const, content: 'x'.repeat(100) },
		{
			role: 'assistant' as const,
			content: null,
			toolCalls: [{ id: 'a', name: 'search', arguments: '{}' }],
		},
		{ role: 'tool' as const, content: 'y'.repeat(100), toolCallId: 'a' },
		{ role: 'assistant' as const, content: 'done' },
		{ role: 'user' as const, content: 'more' },
		{ role: 'assistant' as const, content: 'ok' },
	]

	it('keeps everything that fits', () => {
		expect(fitHistory(history, 1000)).toEqual(history)
	})

	it('never starts on a tool result whose call was dropped', () => {
		expect(fitHistory(history, 150)).toEqual(history.slice(4))
	})

	it('returns nothing rather than half a turn', () => {
		expect(fitHistory(history, 1)).toEqual([])
	})
})
