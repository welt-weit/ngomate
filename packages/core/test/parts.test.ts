import { describe, expect, it, vi } from 'vitest'
import { extractLinks, findUnsourcedLinks } from '../src/links.js'
import type { ToolSource } from '../src/mcp.js'
import {
	type MemoryStore,
	buildMemoryContext,
	createMemoryToolSource,
	memoryNoteName,
} from '../src/memory.js'
import { createOpenAiCompatibleClient, createThinkingFilter } from '../src/model.js'
import { combineToolSources, filterToolSource, isDestructiveTool } from '../src/sources.js'
import { parseTaskFile, taskFileToProfile } from '../src/tasks.js'

function fakeSource(
	names: string[],
	callTool = vi.fn(async (name: string) => ({ text: name, isError: false })),
): ToolSource {
	return {
		listTools: async () => names.map((name) => ({ name, description: name, inputSchema: {} })),
		callTool,
		close: async () => {},
	}
}

describe('combineToolSources', () => {
	it('routes each tool to its own source and renames a clash', async () => {
		const a = vi.fn(async () => ({ text: 'a', isError: false }))
		const b = vi.fn(async () => ({ text: 'b', isError: false }))
		const combined = combineToolSources([
			{ id: 'first', source: fakeSource(['search'], a) },
			{ id: 'second', source: fakeSource(['search', 'read'], b) },
		])
		expect((await combined.listTools()).map((tool) => tool.name)).toEqual([
			'search',
			'second__search',
			'read',
		])
		await combined.callTool('second__search', { q: 1 })
		expect(b).toHaveBeenCalledWith('search', { q: 1 })
		await combined.callTool('search', {})
		expect(a).toHaveBeenCalledTimes(1)
	})

	it('keeps working when one source is down, and names it', async () => {
		const onSourceError = vi.fn()
		const down: ToolSource = {
			...fakeSource([]),
			listTools: () => Promise.reject(new Error('offline')),
		}
		const combined = combineToolSources(
			[
				{ id: 'down', source: down },
				{ id: 'up', source: fakeSource(['read']) },
			],
			{ onSourceError },
		)
		expect((await combined.listTools()).map((tool) => tool.name)).toEqual(['read'])
		expect(onSourceError).toHaveBeenCalledWith('down', expect.any(Error))
	})

	it('reaches prompts through the source that offers them', async () => {
		const getPrompt = vi.fn(async () => 'prompt text')
		const combined = combineToolSources([
			{
				id: 'a',
				source: {
					...fakeSource([]),
					listPrompts: async () => [{ name: 'status', description: '', arguments: [] }],
					getPrompt,
				},
			},
			{ id: 'b', source: fakeSource([]) },
		])
		expect((await combined.listPrompts?.())?.map((prompt) => prompt.name)).toEqual(['status'])
		expect(await combined.getPrompt?.('status', { x: '1' })).toBe('prompt text')
		expect(getPrompt).toHaveBeenCalledWith('status', { x: '1' })
	})
})

describe('filterToolSource', () => {
	it('cannot call what it hides', async () => {
		const callTool = vi.fn(async () => ({ text: 'ran', isError: false }))
		const filtered = filterToolSource(
			fakeSource(['read', 'delete_page'], callTool),
			(tool) => !isDestructiveTool(tool),
		)
		expect((await filtered.listTools()).map((tool) => tool.name)).toEqual(['read'])
		expect((await filtered.callTool('delete_page', {})).isError).toBe(true)
		expect(callTool).not.toHaveBeenCalled()
	})

	it('spots destructive tools by mark or by name, not by part of a word', () => {
		const tool = (name: string, destructive?: boolean) => ({
			name,
			description: '',
			inputSchema: {},
			annotations: { destructive },
		})
		expect(isDestructiveTool(tool('delete_wiki_row'))).toBe(true)
		expect(isDestructiveTool(tool('archive_item'))).toBe(true)
		expect(isDestructiveTool(tool('wipe', true))).toBe(true)
		expect(isDestructiveTool(tool('get_undeleted_items'))).toBe(false)
		expect(isDestructiveTool(tool('search_archives'))).toBe(false)
	})
})

function memoryStore(
	initial: Record<string, string> = {},
): MemoryStore & { notes: Map<string, string> } {
	const notes = new Map(Object.entries(initial))
	return {
		notes,
		list: async () =>
			[...notes].map(([name, text], index) => ({
				name,
				updatedAt: `2027-01-0${index + 1}`,
				chars: text.length,
			})),
		read: async (name) => notes.get(name) ?? null,
		write: async (name, text) => void notes.set(name, text),
		remove: async (name) => void notes.delete(name),
	}
}

describe('memory', () => {
	it('makes a safe name out of anything', () => {
		expect(memoryNoteName('../../etc/passwd')).toBe('etc-passwd')
		expect(memoryNoteName('Our Funders.md')).toBe('our-funders')
		expect(memoryNoteName('Förderer 2027')).toBe('förderer-2027')
		expect(memoryNoteName('...')).toBe('')
	})

	it('reads and saves through the tools, with saving not marked read-only', async () => {
		const store = memoryStore({ rules: 'Be brief.' })
		const tools = createMemoryToolSource(store)
		const listed = await tools.listTools()
		expect(listed.find((tool) => tool.name === 'save_memory')?.annotations?.readOnly).toBe(false)
		expect((await tools.callTool('read_memory', { name: 'Rules' })).text).toBe('Be brief.')
		await tools.callTool('save_memory', { name: 'Funders', text: 'Fund A.' })
		expect(store.notes.get('funders')).toBe('Fund A.')
		expect((await tools.callTool('save_memory', { name: '...', text: 'x' })).isError).toBe(true)
	})

	it('reads a note by the name it is listed under, even one it would not have chosen', async () => {
		const store = memoryStore({ 'Our funders (2027)': 'Fund A.' })
		const tools = createMemoryToolSource(store)
		expect((await tools.callTool('read_memory', { name: 'Our funders (2027)' })).text).toBe(
			'Fund A.',
		)
	})

	it('still starts a conversation when one note cannot be read', async () => {
		const store = memoryStore({ broken: 'x', fine: 'Fine note.' })
		const read = store.read
		store.read = (name) => (name === 'broken' ? Promise.reject(new Error('no')) : read(name))
		expect(await buildMemoryContext(store)).toContain('Fine note.')
	})

	it('starts a conversation with what fits, newest first, and names the rest', async () => {
		const store = memoryStore({ old: 'x'.repeat(300), recent: 'Recent note.' })
		const context = await buildMemoryContext(store, 100)
		expect(context).toContain('Recent note.')
		expect(context).not.toContain('xxx')
		expect(context).toContain('Other notes, available through read_memory: old')
		expect(await buildMemoryContext(memoryStore())).toBe('')
	})
})

describe('links', () => {
	it('ignores trailing punctuation, fragments and a final slash', () => {
		expect(extractLinks('See (https://a.example/x), and https://a.example/x/#top.')).toEqual([
			'https://a.example/x',
		])
	})

	it('counts an edited address as not sourced', () => {
		expect(findUnsourcedLinks(extractLinks('https://a.example/'), ['https://a.example/x'])).toEqual(
			['https://a.example'],
		)
	})
})

describe('task files', () => {
	const file = `---
id: draft
title: Draft a section
description: Writes one section.
ask: Paste your notes
tools: search, read
---
Use only the material given.
`
	it('reads the fields and instructions', () => {
		const task = parseTaskFile(file)
		expect(task).toMatchObject({ id: 'draft', ask: 'Paste your notes', tools: ['search', 'read'] })
		expect(task.instructions).toBe('Use only the material given.')
		expect(taskFileToProfile(task)).toMatchObject({
			readTools: ['search', 'read'],
			writeTools: [],
			allTools: false,
		})
	})

	it('reads what a task needs', () => {
		expect(parseTaskFile(file.replace('tools: search, read', 'needs: addon')).needs).toBe('addon')
		expect(parseTaskFile(file).needs).toBeUndefined()
	})

	it('understands none and all', () => {
		expect(taskFileToProfile(parseTaskFile(file.replace('search, read', 'all'))).allTools).toBe(
			true,
		)
		expect(parseTaskFile(file.replace('tools: search, read\n', '')).tools).toBe('none')
	})

	it('refuses a broken file', () => {
		expect(() => parseTaskFile('no header')).toThrow()
		expect(() => parseTaskFile(file.replace('title: Draft a section\n', ''))).toThrow('title')
		expect(() => parseTaskFile(file.replace('Use only the material given.\n', ''))).toThrow(
			'instructions',
		)
	})
})

describe('streaming', () => {
	function stream(...events: string[]): typeof fetch {
		return vi.fn(async () => {
			const body = new ReadableStream({
				start(controller) {
					for (const event of events) controller.enqueue(new TextEncoder().encode(event))
					controller.close()
				},
			})
			return new Response(body)
		}) as unknown as typeof fetch
	}
	const piece = (delta: unknown) => `data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`

	it('passes on text as it comes, without thinking, and returns the whole', async () => {
		const client = createOpenAiCompatibleClient({
			baseUrl: 'http://x/v1',
			model: 'm',
			fetch: stream(
				piece({ content: '<thi' }),
				piece({ content: 'nk>hmm</think>He' }),
				piece({ content: 'llo' }),
				'data: [DONE]\n\n',
			),
		})
		const seen: string[] = []
		const reply = await client.chat({ messages: [], tools: [], onText: (text) => seen.push(text) })
		expect(seen.join('')).toBe('Hello')
		expect(reply.content).toBe('Hello')
	})

	it('stops when the signal fires, without AbortSignal.any', async () => {
		const seen: AbortSignal[] = []
		const client = createOpenAiCompatibleClient({
			baseUrl: 'http://x/v1',
			model: 'm',
			fetch: vi.fn(async (_url: string, init: RequestInit) => {
				seen.push(init.signal as AbortSignal)
				return new Promise<Response>((_, reject) => {
					init.signal?.addEventListener('abort', () => reject(new Error('aborted')))
				})
			}) as unknown as typeof fetch,
		})
		const controller = new AbortController()
		const reply = client.chat({ messages: [], tools: [], signal: controller.signal })
		await vi.waitFor(() => expect(seen).toHaveLength(1))
		controller.abort()
		await expect(reply).rejects.toThrow('aborted')
	})

	it('assembles a tool call sent in pieces', async () => {
		const client = createOpenAiCompatibleClient({
			baseUrl: 'http://x/v1',
			model: 'm',
			fetch: stream(
				piece({
					tool_calls: [{ index: 0, id: 'a', function: { name: 'search', arguments: '{"q"' } }],
				}),
				piece({ tool_calls: [{ index: 0, function: { arguments: ':1}' } }] }),
			),
		})
		const reply = await client.chat({ messages: [], tools: [], onText: () => {} })
		expect(reply.toolCalls).toEqual([{ id: 'a', name: 'search', arguments: '{"q":1}' }])
	})

	it('handles a line split across two pieces of the stream', async () => {
		const whole = piece({ content: 'Hi' })
		const client = createOpenAiCompatibleClient({
			baseUrl: 'http://x/v1',
			model: 'm',
			fetch: stream(whole.slice(0, 10), whole.slice(10)),
		})
		expect((await client.chat({ messages: [], tools: [], onText: () => {} })).content).toBe('Hi')
	})

	it('holds back only what could still be a tag', () => {
		const seen: string[] = []
		const filter = createThinkingFilter((text) => seen.push(text))
		filter('a < b')
		filter(' and <t')
		filter('able>')
		expect(seen.join('')).toBe('a < b and <table>')
	})
})
