import { describe, expect, it, vi } from 'vitest'
import { runTask } from '../src/agent.js'
import type { ToolSource } from '../src/mcp.js'
import type { ChatRequest, ModelClient, ToolDefinition } from '../src/model.js'
import { chooseTools, compactTool } from '../src/toolChoice.js'

const tool = (name: string, description: string, readOnly = true): ToolDefinition => ({
	name,
	description,
	inputSchema: { type: 'object', properties: {} },
	annotations: { readOnly },
})

const TOOLS = [
	tool('search_grants', 'Search open funding calls by topic'),
	tool('add_contact', 'Add a person to the address book', false),
	tool('get_workspace_summary', 'Summary of one workspace'),
	tool('create_invoice', 'Create an invoice', false),
]

const names = (choice: { tools: ToolDefinition[] }) => choice.tools.map((item) => item.name)

describe('compactTool', () => {
	it('keeps what a call needs and drops schema housekeeping', () => {
		const compact = compactTool({
			name: 'read',
			description: `First sentence here. ${'More words that nobody needs. '.repeat(30)}`,
			inputSchema: {
				$schema: 'http://json-schema.org/draft-07/schema#',
				type: 'object',
				additionalProperties: false,
				required: ['id'],
				properties: {
					id: {
						type: 'string',
						enum: ['a', 'b'],
						description: `An id. ${'Long words again. '.repeat(20)}`,
					},
					// A field can be called title, and must not be mistaken for schema housekeeping.
					title: { type: 'string', title: 'Title' },
				},
			},
		})
		expect(compact.description.length).toBeLessThanOrEqual(200)
		const schema = compact.inputSchema as Record<string, Record<string, Record<string, unknown>>>
		expect(compact.inputSchema).not.toHaveProperty('$schema')
		expect(compact.inputSchema).not.toHaveProperty('additionalProperties')
		expect(compact.inputSchema).toHaveProperty('required', ['id'])
		expect(schema.properties?.id?.enum).toEqual(['a', 'b'])
		expect(String(schema.properties?.id?.description).length).toBeLessThanOrEqual(60)
		expect(schema.properties?.title).toEqual({ type: 'string' })
	})
})

describe('chooseTools', () => {
	it('sends only what the request is about, understanding related words', () => {
		expect(names(chooseTools(TOOLS, 'Find a grant for us', 10_000))).toEqual(['search_grants'])
		expect(names(chooseTools(TOOLS, 'Is there any money for water projects?', 10_000))).toContain(
			'search_grants',
		)
		expect(names(chooseTools(TOOLS, 'Add a contact named Ana', 10_000))).toEqual(['add_contact'])
	})

	it('offers read-only tools when the words match nothing, as another language would', () => {
		const chosen = names(chooseTools(TOOLS, 'Busca fondos para nosotros', 10_000))
		expect(chosen).toEqual(['search_grants', 'get_workspace_summary'])
	})

	it('keeps within the room, and names what was relevant but did not fit', () => {
		const large = tool('search_files', `Search ${'x'.repeat(150)}`)
		const choice = chooseTools([TOOLS[0] as ToolDefinition, large], 'search for this', 200)
		expect(names(choice)).toEqual(['search_grants'])
		expect(choice.didNotFit).toEqual(['search_files'])
	})

	it('stays with a tool the conversation already used, for a follow-up with no matching words', () => {
		expect(names(chooseTools(TOOLS, 'and the second one?', 10_000, ['create_invoice']))).toEqual([
			'create_invoice',
		])
	})

	it('sends at most six, read-only ones first among equals', () => {
		const many = [
			...Array.from({ length: 4 }, (_, i) => tool(`create_grant_${i}`, 'Grant', false)),
			...Array.from({ length: 6 }, (_, i) => tool(`read_grant_${i}`, 'Grant')),
		]
		const chosen = names(chooseTools(many, 'grant', 100_000))
		expect(chosen).toHaveLength(6)
		expect(chosen.every((name) => name.startsWith('read_'))).toBe(true)
	})

	it('keeps the source order, so the same tools make the same prompt', () => {
		const chosen = names(chooseTools(TOOLS, 'workspace funding summary', 10_000))
		expect(chosen).toEqual(['search_grants', 'get_workspace_summary'])
	})
})

describe('runTask with a limit on tool room', () => {
	const source: ToolSource = {
		listTools: async () => TOOLS,
		callTool: vi.fn(),
		close: async () => {},
	}
	const say = { content: 'ok', toolCalls: [], promptTokens: 40, completionTokens: 2, cutOff: true }

	it('offers only the chosen tools, adds up tokens and reports a cut-off answer', async () => {
		const chat = vi.fn(async (_request: ChatRequest) => say)
		const run = await runTask({
			model: { chat } as ModelClient,
			tools: source,
			profile: { id: 'c', instructions: 'Help.', readTools: [], writeTools: [], allTools: true },
			input: 'Find a grant',
			maxToolChars: 10_000,
			maxOutputTokens: 500,
		})
		const request = chat.mock.calls[0]?.[0] as ChatRequest
		expect(request.tools.map((item) => item.name)).toEqual(['search_grants'])
		expect(request.maxOutputTokens).toBe(500)
		expect(run).toMatchObject({ promptTokens: 40, completionTokens: 2, cutOff: true })
	})

	it('sends a task with the request, and keeps only the words of the person', async () => {
		const chat = vi.fn(async (_request: ChatRequest) => ({ ...say, cutOff: false }))
		const run = await runTask({
			model: { chat } as ModelClient,
			tools: source,
			profile: {
				id: 't',
				instructions: 'Find funding.',
				readTools: [],
				writeTools: [],
				instructionsInRequest: true,
			},
			input: 'We are a water NGO.',
		})
		const request = chat.mock.calls[0]?.[0] as ChatRequest
		expect(request.messages[0]?.content).not.toContain('Find funding.')
		expect(request.messages[1]?.content).toBe('Find funding.\n\nWe are a water NGO.')
		expect(run.messages[0]).toEqual({ role: 'user', content: 'We are a water NGO.' })
	})

	it('refuses a tool it did not offer, even if the source has it', async () => {
		const callTool = vi.fn()
		const replies = [
			{
				content: null,
				toolCalls: [{ id: 'a', name: 'create_invoice', arguments: '{}' }],
				promptTokens: 1,
				completionTokens: 1,
			},
			say,
		]
		const run = await runTask({
			model: { chat: async () => replies.shift() } as unknown as ModelClient,
			tools: { ...source, callTool },
			profile: { id: 'c', instructions: 'Help.', readTools: [], writeTools: [], allTools: true },
			input: 'Find a grant',
			maxToolChars: 10_000,
			confirmWrite: async () => true,
		})
		expect(callTool).not.toHaveBeenCalled()
		expect(run.calls[0]?.outcome).toBe('not_allowed')
	})
})
