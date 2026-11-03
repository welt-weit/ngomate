import { describe, expect, it, vi } from 'vitest'
import { type TaskProfile, runTask } from '../src/agent.js'
import type { ToolSource } from '../src/mcp.js'
import {
	type ModelClient,
	type ModelReply,
	createOpenAiCompatibleClient,
	stripThinking,
} from '../src/model.js'

const profile: TaskProfile = {
	id: 'test',
	instructions: 'Do the task.',
	readTools: ['search'],
	writeTools: ['create'],
}

function source(callTool = vi.fn(async () => ({ text: 'result', isError: false }))) {
	const tools: ToolSource = {
		listTools: async () =>
			['search', 'create', 'delete_everything'].map((name) => ({
				name,
				description: name,
				inputSchema: {},
			})),
		callTool,
		close: async () => {},
	}
	return { tools, callTool }
}

function reply(
	toolCalls: { name: string; arguments: string }[],
	content: string | null = null,
): ModelReply {
	return {
		content,
		toolCalls: toolCalls.map((call, index) => ({ id: `c${index}`, ...call })),
		promptTokens: 1,
		completionTokens: 1,
	}
}

function scripted(...replies: ModelReply[]) {
	const chat = vi.fn(async () => {
		const next = replies.shift()
		if (!next) throw new Error('script ran out')
		return next
	})
	return { model: { chat } as ModelClient, chat }
}

describe('runTask', () => {
	it('shows the model only the tools the profile names', async () => {
		const { model, chat } = scripted(reply([], 'done'))
		await runTask({ model, tools: source().tools, profile, input: 'go' })
		const request = chat.mock.calls[0] as unknown as [{ tools: { name: string }[] }]
		expect(request[0].tools.map((tool) => tool.name)).toEqual(['search', 'create'])
	})

	it('refuses a tool outside the profile even when the server offers it', async () => {
		const { model } = scripted(
			reply([{ name: 'delete_everything', arguments: '{}' }]),
			reply([], 'ok'),
		)
		const { tools, callTool } = source()
		const run = await runTask({ model, tools, profile, input: 'go' })
		expect(callTool).not.toHaveBeenCalled()
		expect(run.calls[0]?.outcome).toBe('not_allowed')
	})

	it('cannot write when the host passes no confirmation', async () => {
		const { model } = scripted(reply([{ name: 'create', arguments: '{"a":1}' }]), reply([], 'ok'))
		const { tools, callTool } = source()
		const run = await runTask({ model, tools, profile, input: 'go' })
		expect(callTool).not.toHaveBeenCalled()
		expect(run.calls[0]?.outcome).toBe('declined')
	})

	it('writes only after the host approves, and passes the exact arguments to confirm', async () => {
		const { model } = scripted(reply([{ name: 'create', arguments: '{"a":1}' }]), reply([], 'ok'))
		const { tools, callTool } = source()
		const confirmWrite = vi.fn(async () => true)
		await runTask({ model, tools, profile, input: 'go', confirmWrite })
		expect(confirmWrite).toHaveBeenCalledWith({ tool: 'create', args: { a: 1 } })
		expect(callTool).toHaveBeenCalledWith('create', { a: 1 })
	})

	it('refuses a date no tool returned, before asking for confirmation', async () => {
		const { model, chat } = scripted(
			reply([{ name: 'search', arguments: '{}' }]),
			reply([{ name: 'create', arguments: '{"dueAt":"2027-01-15"}' }]),
			reply([], 'ok'),
		)
		const { tools, callTool } = source(
			vi.fn(async () => ({ text: 'Deadline: 2027-03-01', isError: false })),
		)
		const confirmWrite = vi.fn(async () => true)
		const run = await runTask({ model, tools, profile, input: 'go', confirmWrite })
		expect(confirmWrite).not.toHaveBeenCalled()
		expect(callTool).toHaveBeenCalledTimes(1)
		expect(run.calls[1]?.outcome).toBe('unsourced_date')
		const request = chat.mock.calls[2] as unknown as [{ messages: { content: string }[] }]
		expect(request[0].messages.at(-2)?.content).toContain('2027-01-15')
	})

	it('allows a date a read returned, in another format and with a time', async () => {
		const { model } = scripted(
			reply([{ name: 'search', arguments: '{}' }]),
			reply([{ name: 'create', arguments: '{"dueAt":"2027-03-01T00:00:00Z"}' }]),
			reply([], 'ok'),
		)
		const { tools, callTool } = source(
			vi.fn(async () => ({ text: 'Closes 1 March 2027', isError: false })),
		)
		await runTask({ model, tools, profile, input: 'go', confirmWrite: async () => true })
		expect(callTool).toHaveBeenLastCalledWith('create', { dueAt: '2027-03-01T00:00:00Z' })
	})

	it('allows a date from a preload or the request, but not from a failed read', async () => {
		const write = (date: string) => reply([{ name: 'create', arguments: `{"dueAt":"${date}"}` }])
		const preload = [{ tool: 'search', args: {} }]
		const confirmWrite = async () => true

		const fromPreload = source(vi.fn(async () => ({ text: '2027-03-01', isError: false })))
		await runTask({
			model: scripted(write('2027-03-01'), reply([], 'ok')).model,
			tools: fromPreload.tools,
			profile: { ...profile, preload },
			input: 'go',
			confirmWrite,
		})
		expect(fromPreload.callTool).toHaveBeenLastCalledWith('create', { dueAt: '2027-03-01' })

		const fromInput = source()
		await runTask({
			model: scripted(write('2027-04-02'), reply([], 'ok')).model,
			tools: fromInput.tools,
			profile,
			input: 'due on April 2, 2027',
			confirmWrite,
		})
		expect(fromInput.callTool).toHaveBeenCalledWith('create', { dueAt: '2027-04-02' })

		const failedRead = source(vi.fn(async () => ({ text: '2027-03-01', isError: true })))
		const run = await runTask({
			model: scripted(write('2027-03-01'), reply([], 'ok')).model,
			tools: failedRead.tools,
			profile: { ...profile, preload },
			input: 'go',
			confirmWrite,
		})
		expect(run.calls.at(-1)?.outcome).toBe('unsourced_date')
	})

	it('finds a date nested in the arguments or written in words', async () => {
		const { model } = scripted(
			reply([{ name: 'create', arguments: '{"items":[{"note":"finish by 15 Jan 2027"}]}' }]),
			reply([], 'ok'),
		)
		const { tools, callTool } = source()
		await runTask({ model, tools, profile, input: 'go', confirmWrite: async () => true })
		expect(callTool).not.toHaveBeenCalled()
	})

	it('does not ask for confirmation on a read', async () => {
		const { model } = scripted(reply([{ name: 'search', arguments: '{}' }]), reply([], 'ok'))
		const confirmWrite = vi.fn(async () => true)
		await runTask({ model, tools: source().tools, profile, input: 'go', confirmWrite })
		expect(confirmWrite).not.toHaveBeenCalled()
	})

	it('hands bad JSON back to the model instead of calling the tool', async () => {
		const { model, chat } = scripted(
			reply([{ name: 'search', arguments: '{oops' }]),
			reply([], 'ok'),
		)
		const { tools, callTool } = source()
		const run = await runTask({ model, tools, profile, input: 'go' })
		expect(callTool).not.toHaveBeenCalled()
		expect(run.calls[0]?.outcome).toBe('invalid_arguments')
		expect(chat).toHaveBeenCalledTimes(2)
	})

	it('reports a tool failure to the model and carries on', async () => {
		const { model } = scripted(reply([{ name: 'search', arguments: '{}' }]), reply([], 'ok'))
		const { tools } = source(
			vi.fn(async () => {
				throw new Error('network down')
			}),
		)
		const run = await runTask({ model, tools, profile, input: 'go' })
		expect(run.status).toBe('completed')
		expect(run.calls[0]?.outcome).toBe('tool_error')
	})

	it('stops at the turn limit', async () => {
		const looping = reply([{ name: 'search', arguments: '{}' }])
		const { model } = scripted(looping, looping)
		const run = await runTask({ model, tools: source().tools, profile, input: 'go', maxTurns: 2 })
		expect(run.status).toBe('max_turns')
		expect(run.answer).toBeNull()
	})

	it('reports a model failure as a result, not a throw', async () => {
		const model: ModelClient = {
			chat: async () => {
				throw new Error('no model')
			},
		}
		const run = await runTask({ model, tools: source().tools, profile, input: 'go' })
		expect(run.status).toBe('model_error')
		expect(run.error).toBe('no model')
	})

	it('runs preload reads before the first turn and gives the model the result', async () => {
		const { model, chat } = scripted(reply([], 'ok'))
		const { tools, callTool } = source()
		await runTask({
			model,
			tools,
			profile: { ...profile, preload: [{ tool: 'search', args: {} }] },
			input: 'go',
		})
		expect(callTool).toHaveBeenCalledWith('search', {})
		const request = chat.mock.calls[0] as unknown as [{ messages: { content: string }[] }]
		expect(request[0].messages[0]?.content).toContain('Result of search:\nresult')
	})

	it('refuses a preload that is not a read tool of the profile', async () => {
		const { model } = scripted(reply([], 'ok'))
		const { tools, callTool } = source()
		await expect(
			runTask({
				model,
				tools,
				profile: { ...profile, preload: [{ tool: 'create', args: {} }] },
				input: 'go',
			}),
		).rejects.toThrow('not a read tool')
		expect(callTool).not.toHaveBeenCalled()
	})

	it('names profile tools the server does not offer', async () => {
		const { model } = scripted(reply([], 'ok'))
		const run = await runTask({
			model,
			tools: source().tools,
			profile: { ...profile, readTools: ['search', 'gone'] },
			input: 'go',
		})
		expect(run.missingTools).toEqual(['gone'])
	})
})

describe('createOpenAiCompatibleClient', () => {
	const respond = (body: unknown, status = 200) =>
		vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch

	it('accepts arguments returned as an object', async () => {
		const client = createOpenAiCompatibleClient({
			baseUrl: 'http://x/v1',
			model: 'm',
			fetch: respond({
				choices: [
					{ message: { tool_calls: [{ id: 'a', function: { name: 't', arguments: { q: 1 } } }] } },
				],
			}),
		})
		const result = await client.chat({ messages: [], tools: [] })
		expect(result.toolCalls[0]?.arguments).toBe('{"q":1}')
	})

	it('treats a reply that is only thinking as no answer', async () => {
		const client = createOpenAiCompatibleClient({
			baseUrl: 'http://x/v1',
			model: 'm',
			fetch: respond({ choices: [{ message: { content: '<think>hmm</think>' } }] }),
		})
		expect((await client.chat({ messages: [], tools: [] })).content).toBeNull()
	})

	it('throws with the status on a failed request', async () => {
		const client = createOpenAiCompatibleClient({
			baseUrl: 'http://x/v1',
			model: 'm',
			fetch: respond({ error: 'nope' }, 500),
		})
		await expect(client.chat({ messages: [], tools: [] })).rejects.toThrow('500')
	})
})

describe('stripThinking', () => {
	it('removes an unterminated block', () => {
		expect(stripThinking('answer <think>cut off')).toBe('answer')
	})
})
