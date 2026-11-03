// @vitest-environment jsdom
import type { ChatRequest, ModelClient, ModelReply, ToolSource } from '@ngomate/core'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NgomateApp } from '../src/NgomateApp.js'
import { recommendedModelId } from '../src/format.js'
import {
	type Conversation,
	DEFAULT_SETTINGS,
	type NgomateHost,
	type Settings,
} from '../src/host.js'

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

function makeHost(
	replies: ModelReply[],
	settings: Partial<Settings> = {},
	overrides: Partial<NgomateHost> = {},
) {
	const conversations = new Map<string, Conversation>()
	const notes = new Map<string, string>()
	const chat = vi.fn(async (request: ChatRequest) => {
		const next = replies.shift()
		if (!next) throw new Error('no more replies')
		if (next.content) request.onText?.(next.content)
		return next
	})
	const client: ModelClient = { chat }
	const host: NgomateHost = {
		appName: 'NGOmate',
		tasks: [
			{
				id: 'draft',
				title: 'Draft a section',
				description: 'Writes a section.',
				ask: 'Paste your notes',
				tools: 'none',
				instructions: 'Use only what is given.',
			},
		],
		memory: {
			list: async () =>
				[...notes].map(([name, text]) => ({ name, updatedAt: null, chars: text.length })),
			read: async (name) => notes.get(name) ?? null,
			write: async (name, text) => void notes.set(name, text),
			remove: async (name) => void notes.delete(name),
		},
		loadSettings: async () => ({
			...DEFAULT_SETTINGS,
			model: { kind: 'server', baseUrl: 'http://x', model: 'm' },
			...settings,
		}),
		saveSettings: async () => {},
		listConversations: async () => [...conversations.values()],
		readConversation: async (id) => conversations.get(id) ?? null,
		writeConversation: async (conversation) =>
			void conversations.set(conversation.id, conversation),
		removeConversation: async (id) => void conversations.delete(id),
		pickDocument: async () => ({ name: 'notes.txt', text: 'Our notes.', truncated: false }),
		saveDocument: async () => true,
		createModelClient: () => client,
		connectAddon: async () => {
			throw new Error('no add-ons here')
		},
		getSecret: async () => null,
		setSecret: async () => {},
		deleteSecret: async () => {},
		...overrides,
	}
	return { host, chat, notes, conversations }
}

afterEach(cleanup)

const typeAndSend = async (text: string) => {
	await userEvent.type(await screen.findByRole('textbox', { name: 'Message' }), text)
	await userEvent.click(screen.getByRole('button', { name: 'Send' }))
}

describe('chat', () => {
	it('sends a message, shows the answer and keeps it for next time', async () => {
		const { host, conversations } = makeHost([say('Hello there.')])
		render(<NgomateApp host={host} />)
		await typeAndSend('Hi')
		expect(await screen.findByText('Hello there.')).toBeTruthy()
		await waitFor(() => expect([...conversations.values()][0]?.title).toBe('Hi'))
		expect([...conversations.values()][0]?.messages.map((message) => message.content)).toEqual([
			'Hi',
			'Hello there.',
		])
	})

	it('asks before saving a note, shows the exact text, and saves nothing when refused', async () => {
		const { host, notes } = makeHost([
			call('save_memory', { name: 'funders', text: 'Fund A prefers short reports.' }),
			say('Not saved.'),
		])
		render(<NgomateApp host={host} />)
		await typeAndSend('Remember this')
		expect(await screen.findByRole('alertdialog')).toBeTruthy()
		expect(screen.getByText('Fund A prefers short reports.')).toBeTruthy()
		expect(notes.size).toBe(0)
		await userEvent.click(screen.getByRole('button', { name: "Don't allow" }))
		expect(await screen.findByText('Not saved.')).toBeTruthy()
		expect(notes.size).toBe(0)
	})

	it('saves a note after the person allows it', async () => {
		const { host, notes } = makeHost([
			call('save_memory', { name: 'funders', text: 'Fund A.' }),
			say('Saved.'),
		])
		render(<NgomateApp host={host} />)
		await typeAndSend('Remember this')
		await userEvent.click(await screen.findByRole('button', { name: 'Allow' }))
		await screen.findByText('Saved.')
		expect(notes.get('funders')).toBe('Fund A.')
	})

	it('shows a warning beside a link nothing supplied', async () => {
		const { host } = makeHost([say('See https://made-up.example/call for details.')])
		render(<NgomateApp host={host} />)
		await typeAndSend('Where?')
		expect(await screen.findByText(/did not come from your material/)).toBeTruthy()
	})

	it('runs a ready-made task with a document, and reminds the person to check figures', async () => {
		const { host, chat } = makeHost([say('A draft with 12 tanks.')])
		render(<NgomateApp host={host} />)
		await userEvent.click(await screen.findByRole('button', { name: 'Draft a section' }))
		await userEvent.click(await screen.findByRole('button', { name: 'Attach document' }))
		await screen.findByText('notes.txt')
		await typeAndSend('Question 2')
		await screen.findByText('A draft with 12 tanks.')
		expect(await screen.findByText(/Check every name and figure/)).toBeTruthy()
		const request = chat.mock.calls[0]?.[0] as ChatRequest
		expect(request.tools).toEqual([])
		expect(request.messages[0]?.content).toContain('Use only what is given.')
		expect(request.messages.at(1)?.content).toContain('Our notes.')
	})

	it('does not ask the model to find funding when nothing is connected', async () => {
		const { host, chat } = makeHost(
			[],
			{},
			{
				tasks: [
					{
						id: 'find',
						title: 'Find funding',
						description: '',
						ask: 'Who you are',
						tools: 'all',
						needs: 'addon',
						instructions: 'Find.',
					},
				],
			},
		)
		render(<NgomateApp host={host} />)
		await userEvent.click(await screen.findByRole('button', { name: 'Find funding' }))
		await typeAndSend('A water NGO')
		expect((await screen.findByRole('alert')).textContent).toContain('needs a connected tool')
		expect(chat).not.toHaveBeenCalled()
	})

	it('says when no model is chosen, and offers no broken send', async () => {
		const { host } = makeHost([], { model: null })
		render(<NgomateApp host={host} />)
		await typeAndSend('Hi')
		expect((await screen.findByRole('alert')).textContent).toContain('Choose a model first')
	})

	it('keeps the message when no model could be used at all', async () => {
		const { host, conversations } = makeHost([], { model: null })
		render(<NgomateApp host={host} />)
		await typeAndSend('My long message')
		await screen.findByRole('alert')
		expect([...conversations.values()][0]?.messages[0]?.content).toBe('My long message')
		expect(document.querySelector('.ngm-user')?.textContent).toBe('My long message')
	})

	it('says why a document could not be read', async () => {
		const { host } = makeHost(
			[],
			{},
			{
				pickDocument: async () => {
					throw new Error('This PDF has no text to read. It may be a scan.')
				},
			},
		)
		render(<NgomateApp host={host} />)
		await userEvent.click(await screen.findByRole('button', { name: 'Attach document' }))
		expect((await screen.findByRole('alert')).textContent).toContain('may be a scan')
	})

	it('keeps what was written when the person presses Stop', async () => {
		const { host, conversations, chat } = makeHost([])
		chat.mockImplementationOnce(
			(request: ChatRequest) =>
				new Promise((_, reject) => {
					request.onText?.('The first part')
					request.signal?.addEventListener('abort', () => reject(new Error('aborted')))
				}),
		)
		render(<NgomateApp host={host} />)
		await typeAndSend('Write')
		await screen.findByText('The first part')
		await userEvent.click(screen.getByRole('button', { name: 'Stop' }))
		await screen.findByRole('button', { name: 'Send' })
		expect([...conversations.values()][0]?.messages.at(-1)?.content).toBe('The first part')
	})

	it('reports a model failure and keeps what the person wrote', async () => {
		const { host, conversations } = makeHost([])
		render(<NgomateApp host={host} />)
		await typeAndSend('Hi')
		expect((await screen.findByRole('alert')).textContent).toContain('no more replies')
		await waitFor(() => expect([...conversations.values()][0]?.messages[0]?.content).toBe('Hi'))
	})

	it('carries on without an add-on that cannot be reached, and names it', async () => {
		const addon = {
			id: 'a',
			name: 'Offline tool',
			connection: { kind: 'http' as const, url: 'https://x.example' },
			enabled: true,
			allowDestructive: false,
		}
		const { host } = makeHost([say('Fine.')], { addons: [addon] })
		render(<NgomateApp host={host} />)
		await typeAndSend('Hi')
		await screen.findByText('Fine.')
		expect(await screen.findByText(/Could not reach: Offline tool/)).toBeTruthy()
	})

	it('hides an add-on tool that deletes unless the person allows it', async () => {
		const callTool = vi.fn(async () => ({ text: 'gone', isError: false }))
		const source: ToolSource = {
			listTools: async () => [
				{ name: 'delete_page', description: '', inputSchema: {} },
				{ name: 'read_page', description: '', inputSchema: {}, annotations: { readOnly: true } },
			],
			callTool,
			close: async () => {},
		}
		const addon = {
			id: 'a',
			name: 'Wiki',
			connection: { kind: 'http' as const, url: 'https://x.example' },
			enabled: true,
			allowDestructive: false,
		}
		const { host, chat } = makeHost(
			[say('ok')],
			{ addons: [addon] },
			{ connectAddon: async () => source },
		)
		render(<NgomateApp host={host} />)
		await typeAndSend('Hi')
		await screen.findByText('ok')
		const names = (chat.mock.calls[0]?.[0] as ChatRequest).tools.map((tool) => tool.name)
		expect(names).toContain('read_page')
		expect(names).not.toContain('delete_page')
	})

	it('does not render model text as HTML', async () => {
		const { host } = makeHost([
			say('Hello <img src=x onerror="alert(1)"> world ![a](https://x.example/p.png)'),
		])
		const { container } = render(<NgomateApp host={host} />)
		await typeAndSend('Hi')
		await screen.findByText(/Hello/)
		expect(container.querySelector('img')).toBeNull()
	})
})

describe('recommendedModelId', () => {
	const models = [
		{ id: 'big', minRamGb: 32, sizeBytes: 20 },
		{ id: 'small', minRamGb: 8, sizeBytes: 5 },
		{ id: 'mid', minRamGb: 8, sizeBytes: 6 },
	]
	it('offers the smallest that fits, and nothing when none does', () => {
		expect(recommendedModelId(models, 16)).toBe('small')
		expect(recommendedModelId(models, 4)).toBeNull()
	})
})
