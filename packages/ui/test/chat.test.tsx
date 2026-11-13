// @vitest-environment jsdom
import type { ChatRequest, ModelClient, ModelReply, ToolSource } from '@ngomate/core'
import { cleanup, render, renderHook, screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { connectionProblem, splitCommand } from '../src/AddonsPanel.js'
import { NgomateApp } from '../src/NgomateApp.js'
import { recommendedModelId } from '../src/format.js'
import {
	type Conversation,
	DEFAULT_SETTINGS,
	type NgomateHost,
	type Settings,
} from '../src/host.js'
import type { NgomatePrimitives } from '../src/primitives.js'
import { documentBlock, textBudget } from '../src/useChat.js'
import { useIdleUnload } from '../src/useIdleUnload.js'

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
			throw new Error('no connectors here')
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

	it('runs a ready-made task with a document, lists a figure it does not back, and reminds the person to check', async () => {
		const { host, chat } = makeHost([say('A draft with 12 tanks.')])
		render(<NgomateApp host={host} />)
		await userEvent.click(await screen.findByRole('button', { name: 'Draft a section' }))
		await userEvent.click(await screen.findByRole('button', { name: 'Attach document' }))
		await screen.findByText('notes.txt')
		await typeAndSend('Question 2')
		await screen.findByText('A draft with 12 tanks.')
		expect(await screen.findByText('12 tanks')).toBeTruthy()
		expect(screen.getByText(/not found in your material/)).toBeTruthy()
		expect(screen.getByText(/Also check every name and figure/)).toBeTruthy()
		const request = chat.mock.calls[0]?.[0] as ChatRequest
		expect(request.tools).toEqual([])
		expect(request.messages.at(1)?.content).toContain('Use only what is given.')
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

	it('shares the room between documents, so two cannot overflow the model', async () => {
		const long = { name: 'a.txt', text: 'x'.repeat(50_000), truncated: false }
		const { host, chat } = makeHost([say('ok')], {}, { pickDocument: async () => long })
		render(<NgomateApp host={host} />)
		await userEvent.click(await screen.findByRole('button', { name: 'Attach document' }))
		await userEvent.click(await screen.findByRole('button', { name: 'Attach document' }))
		await waitFor(() => expect(screen.getAllByText('a.txt')).toHaveLength(2))
		await userEvent.click(screen.getByRole('button', { name: 'Send' }))
		await screen.findByText('ok')
		const request = chat.mock.calls[0]?.[0] as ChatRequest
		expect(request.messages.at(1)?.content?.length).toBeLessThan(textBudget().document + 300)
	})

	it('says when the model did not see the start of a long conversation', async () => {
		const { host, conversations } = makeHost([say('Answer.')])
		conversations.set('old', {
			id: 'old',
			title: 'Long one',
			updatedAt: '2027-01-01T00:00:00.000Z',
			messages: [
				{ role: 'user', content: 'x'.repeat(40_000) },
				{ role: 'assistant', content: 'Earlier reply.' },
			],
			notices: {},
		})
		render(<NgomateApp host={host} />)
		await userEvent.click(await screen.findByRole('button', { name: 'Long one' }))
		await screen.findByText('Earlier reply.')
		await typeAndSend('And now?')
		await screen.findByText('Answer.')
		expect(await screen.findByText(/did not see the earliest part/)).toBeTruthy()
	})

	it('says it is reading a document until the first words come', async () => {
		let release: (reply: ModelReply) => void = () => {}
		const { host, chat } = makeHost([])
		chat.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					release = resolve
				}),
		)
		render(<NgomateApp host={host} />)
		await userEvent.click(await screen.findByRole('button', { name: 'Attach document' }))
		await screen.findByText('notes.txt')
		await userEvent.click(screen.getByRole('button', { name: 'Send' }))
		expect(await screen.findByText(/Reading your document/)).toBeTruthy()
		release(say('Done reading.'))
		await screen.findByText('Done reading.')
		expect(screen.queryByText(/Reading your document/)).toBeNull()
	})

	it('keeps the document with the conversation, and finds another part for a follow-up', async () => {
		const text = `Report.\n\n${'Filler about the team and the visits. '.repeat(300)}\n\nThe borehole cost EUR 18,400.\n\n${'More filler about meetings. '.repeat(300)}\n\nThe auditor was Amara Okafor.`
		const { host, chat, conversations } = makeHost(
			[say('First.'), say('Second.')],
			{},
			{
				pickDocument: async () => ({ name: 'report.pdf', text, truncated: false }),
			},
		)
		render(<NgomateApp host={host} />)
		await userEvent.click(await screen.findByRole('button', { name: 'Attach document' }))
		await screen.findByText('report.pdf')
		await typeAndSend('What did the borehole cost?')
		await screen.findByText('First.')
		await typeAndSend('Who was the auditor?')
		await screen.findByText('Second.')
		const second = chat.mock.calls[1]?.[0] as ChatRequest
		const sent = second.messages.map((message) => message.content ?? '').join('\n')
		expect(sent).toContain('Amara Okafor')
		const stored = [...conversations.values()][0]
		expect(stored?.documents?.[0]?.text).toBe(text)
		expect(stored?.messages[0]?.content).toBe(
			'What did the borehole cost?\n\n[Attached: report.pdf]',
		)
		expect(await screen.findAllByText(/Read only part of report.pdf/)).toHaveLength(2)
	})

	it('lets a document be taken out, so later messages no longer send it', async () => {
		const { host, chat, conversations } = makeHost(
			[say('First.'), say('Second.')],
			{},
			{
				pickDocument: async () => ({
					name: 'private.txt',
					text: 'Confidential words.',
					truncated: false,
				}),
			},
		)
		render(<NgomateApp host={host} />)
		await userEvent.click(await screen.findByRole('button', { name: 'Attach document' }))
		await screen.findByText('private.txt')
		await typeAndSend('Read this')
		await screen.findByText('First.')
		await userEvent.click(await screen.findByRole('button', { name: 'Stop using private.txt' }))
		await waitFor(() => expect([...conversations.values()][0]?.documents).toEqual([]))
		await typeAndSend('Anything else?')
		await screen.findByText('Second.')
		const second = chat.mock.calls[1]?.[0] as ChatRequest
		const sentLast = second.messages.filter((message) => message.role === 'user').at(-1)?.content
		expect(sentLast).not.toContain('Confidential')
	})

	it('sends a file attached twice only once', async () => {
		const { host, chat } = makeHost(
			[say('ok')],
			{},
			{
				pickDocument: async () => ({ name: 'a.txt', text: 'Same words.', truncated: false }),
			},
		)
		render(<NgomateApp host={host} />)
		await userEvent.click(await screen.findByRole('button', { name: 'Attach document' }))
		await userEvent.click(await screen.findByRole('button', { name: 'Attach document' }))
		await waitFor(() => expect(screen.getAllByText('a.txt')).toHaveLength(2))
		await userEvent.click(screen.getByRole('button', { name: 'Send' }))
		await screen.findByText('ok')
		const sent = (chat.mock.calls[0]?.[0] as ChatRequest).messages.at(1)?.content ?? ''
		expect(sent.match(/Document "a.txt"/g)).toHaveLength(1)
	})

	it('finds the earlier passage again for a short follow-up', async () => {
		const text = `Report.\n\n${'Filler about visits. '.repeat(400)}\n\nThe borehole cost EUR 18,400 in Tosa.\n\n${'More filler. '.repeat(400)}`
		const { host, chat } = makeHost(
			[say('First.'), say('Second.')],
			{},
			{
				pickDocument: async () => ({ name: 'r.txt', text, truncated: false }),
			},
		)
		render(<NgomateApp host={host} />)
		await userEvent.click(await screen.findByRole('button', { name: 'Attach document' }))
		await screen.findByText('r.txt')
		await typeAndSend('What did the borehole cost?')
		await screen.findByText('First.')
		await typeAndSend('Why?')
		await screen.findByText('Second.')
		const sent = (chat.mock.calls[1]?.[0] as ChatRequest).messages
			.filter((m) => m.role === 'user')
			.at(-1)?.content
		expect(sent).toContain('EUR 18,400')
	})

	it('says when a file was too long to read to the end, wherever the answer looked', async () => {
		const { host } = makeHost(
			[say('Answer.')],
			{},
			{
				pickDocument: async () => ({ name: 'big.pdf', text: 'x '.repeat(30_000), truncated: true }),
			},
		)
		render(<NgomateApp host={host} />)
		await userEvent.click(await screen.findByRole('button', { name: 'Attach document' }))
		await screen.findByText(/only the first part of the file can be read/)
		await typeAndSend('Anything?')
		await screen.findByText('Answer.')
		expect(await screen.findByText(/big.pdf is too long to read to the end/)).toBeTruthy()
	})

	it('reports a model failure and keeps what the person wrote', async () => {
		const { host, conversations } = makeHost([])
		render(<NgomateApp host={host} />)
		await typeAndSend('Hi')
		expect((await screen.findByRole('alert')).textContent).toContain('no more replies')
		await waitFor(() => expect([...conversations.values()][0]?.messages[0]?.content).toBe('Hi'))
	})

	it('carries on without a connector that cannot be reached, and names it', async () => {
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

	it('hides a connector tool that deletes unless the person allows it', async () => {
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

	it('looks up the question in a connected knowledge base', async () => {
		const callTool = vi.fn(async () => ({
			text: JSON.stringify({
				passages: [{ text: 'Compost helps.', heading: null, entry: { title: 'Soil guide' } }],
			}),
			isError: false,
		}))
		const source: ToolSource = {
			listTools: async () => [
				{
					name: 'search_knowledge',
					description: 'Find',
					inputSchema: {},
					annotations: { readOnly: true },
				},
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
		const { host } = makeHost(
			[say('Use compost.')],
			{ addons: [addon] },
			{ connectAddon: async () => source },
		)
		render(<NgomateApp host={host} />)
		await typeAndSend('How do we restore soil?')
		await screen.findByText('Use compost.')
		expect(callTool).toHaveBeenCalledWith(
			'search_knowledge',
			expect.objectContaining({ query: 'How do we restore soil?' }),
		)
		expect(await screen.findByText(/Looked up in the knowledge base: Soil guide/)).toBeTruthy()
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

describe('connectors', () => {
	const tools: ToolSource = {
		listTools: async () => [
			{
				name: 'search_grants',
				description: 'Search grants',
				inputSchema: {},
				annotations: { readOnly: true },
			},
			{ name: 'add_contact', description: 'Add a contact', inputSchema: {} },
			{ name: 'delete_page', description: 'Delete a page', inputSchema: {} },
		],
		callTool: async () => ({ text: '', isError: false }),
		close: async () => {},
	}

	function open(overrides: Partial<NgomateHost>, settings: Partial<Settings> = {}) {
		const saved: Settings[] = []
		const { host } = makeHost([], settings, {
			connectAddon: async () => tools,
			saveSettings: async (next) => void saved.push(next),
			...overrides,
		})
		render(<NgomateApp host={host} />)
		return { saved }
	}
	const toConnectors = async () =>
		userEvent.click(await screen.findByRole('button', { name: 'Connectors' }))

	it('connects a suggested connector with only a token, and checks it before keeping it', async () => {
		const connectAddon = vi.fn(async () => tools)
		const setSecret = vi.fn(async () => {})
		const { saved } = open({ connectAddon, setSecret })
		await toConnectors()
		await userEvent.click(await screen.findByRole('button', { name: 'Connect Apify' }))
		await userEvent.type(screen.getByLabelText(/Paste your token/), 'my-token')
		await userEvent.click(screen.getByRole('button', { name: 'Connect' }))
		await waitFor(() => expect(saved.at(-1)?.addons).toHaveLength(1))
		expect(connectAddon).toHaveBeenCalled()
		expect(setSecret).toHaveBeenCalledWith(expect.stringMatching(/^addon:/), 'my-token')
		expect(await screen.findByText('Connected')).toBeTruthy()
		expect(
			await screen.findByText(/1 tool to read, 1 tool to change things after asking you/),
		).toBeTruthy()
	})

	it('keeps nothing when the token is refused, and says so plainly', async () => {
		const deleteSecret = vi.fn(async () => {})
		const { saved } = open({
			deleteSecret,
			connectAddon: async () => {
				throw new Error('Error POSTing to endpoint (HTTP 401)')
			},
		})
		await toConnectors()
		await userEvent.click(await screen.findByRole('button', { name: 'Connect Apify' }))
		await userEvent.type(screen.getByLabelText(/Paste your token/), 'bad')
		await userEvent.click(screen.getByRole('button', { name: 'Connect' }))
		expect((await screen.findByRole('alert')).textContent).toContain('token was not accepted')
		expect(saved).toEqual([])
		expect(deleteSecret).toHaveBeenCalled()
		expect(screen.getByLabelText(/Paste your token/)).toBeTruthy()
	})

	const connected = {
		id: 'a',
		name: 'Grant search',
		connection: { kind: 'http' as const, url: 'https://x.example' },
		enabled: true,
		allowDestructive: false,
	}

	it('shows connectors in a grid, and connects one in a dialog that closes when done', async () => {
		const { saved } = open({})
		await toConnectors()
		expect(screen.queryByRole('dialog')).toBeNull()
		await userEvent.click(await screen.findByRole('button', { name: 'Connect Apify' }))
		await screen.findByRole('dialog', { name: 'Connect Apify' })
		await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
		expect(screen.queryByRole('dialog')).toBeNull()
		expect(saved).toEqual([])

		await userEvent.click(screen.getByRole('button', { name: 'Connect Apify' }))
		await userEvent.type(screen.getByLabelText(/Paste your token/), 'good')
		await userEvent.click(screen.getByRole('button', { name: 'Connect' }))
		await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
		expect(saved.at(-1)?.addons).toHaveLength(1)
		expect(await screen.findByRole('button', { name: 'Manage Apify' })).toBeTruthy()
		expect(screen.queryByRole('button', { name: 'Connect Apify' })).toBeNull()
	})

	it('uses the dialog a host passes down', async () => {
		const { host } = makeHost([])
		const Dialog: NgomatePrimitives['Dialog'] = ({ title, children }) => (
			<section data-host-dialog={title}>{children}</section>
		)
		const { container } = render(<NgomateApp host={host} primitives={{ Dialog }} />)
		await toConnectors()
		await userEvent.click(await screen.findByRole('button', { name: 'Connect Apify' }))
		expect(container.querySelector('[data-host-dialog="Connect Apify"]')).not.toBeNull()
	})

	it('shows what a connector can read, change and delete, and lets a tool be turned off', async () => {
		const { saved } = open({}, { addons: [connected] })
		await toConnectors()
		await screen.findByText('Connected')
		await userEvent.click(screen.getByRole('button', { name: 'Manage Grant search' }))
		await screen.findByRole('dialog', { name: 'Grant search' })
		expect(screen.getByText('It can read')).toBeTruthy()
		expect(screen.getByText('It can change, after asking you')).toBeTruthy()
		expect(screen.getByText(/1 tool kept off/)).toBeTruthy()
		expect(screen.queryByText('Delete page')).toBeNull()
		await userEvent.click(screen.getByRole('checkbox', { name: /Search grants/ }))
		expect(saved.at(-1)?.addons[0]?.disabledTools).toEqual(['search_grants'])
	})

	it('says that questions go to a knowledge search while it is on', async () => {
		const withKnowledge: ToolSource = {
			...tools,
			listTools: async () => [
				{
					name: 'search_knowledge',
					description: 'Search the knowledge base',
					inputSchema: {},
					annotations: { readOnly: true },
				},
			],
		}
		open({ connectAddon: async () => withKnowledge }, { addons: [connected] })
		await toConnectors()
		await screen.findByText('Connected')
		await userEvent.click(screen.getByRole('button', { name: 'Manage Grant search' }))
		const notice = /Each question you ask in chat is also sent to its knowledge search/
		expect(await screen.findByText(notice)).toBeTruthy()
		await userEvent.click(screen.getByRole('checkbox', { name: /Search knowledge/ }))
		expect(screen.queryByText(notice)).toBeNull()
	})

	it('does not start a program just because the screen opened', async () => {
		const connectAddon = vi.fn(async () => tools)
		const program = {
			...connected,
			connection: { kind: 'command' as const, command: 'tool', args: [] },
		}
		open(
			{ connectAddon, listConversations: async () => [] },
			{ addons: [{ ...program, enabled: false }] },
		)
		await toConnectors()
		await screen.findByText('Turned off.')
		expect(connectAddon).not.toHaveBeenCalled()
	})

	it('turns technical failures into words', () => {
		expect(connectionProblem(new Error('HTTP 401'))).toContain('token was not accepted')
		// As a real server's refusal arrives: the status is only in `code`.
		const refused = Object.assign(new Error('Streamable HTTP error: Error POSTing to endpoint: '), {
			code: 401,
		})
		expect(connectionProblem(refused)).toContain('token was not accepted')
		expect(connectionProblem(Object.assign(new Error('x'), { code: 404 }))).toContain(
			'Nothing answered',
		)
		expect(connectionProblem(new Error('HTTP 404'))).toContain('Nothing answered')
		expect(connectionProblem(new TypeError('Load failed'))).toContain('Could not reach')
	})
})

describe('moving around while an answer is written', () => {
	it('keeps writing when the settings are opened, and shows the answer on the way back', async () => {
		let release: (reply: ModelReply) => void = () => {}
		const { host, chat, conversations } = makeHost([])
		chat.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					release = resolve
				}),
		)
		render(<NgomateApp host={host} />)
		await typeAndSend('Write something long')
		await userEvent.click(await screen.findByRole('button', { name: 'Model' }))
		const request = chat.mock.calls[0]?.[0] as ChatRequest
		expect(request.signal?.aborted).toBe(false)
		release(say('Finished anyway.'))
		await waitFor(() =>
			expect([...conversations.values()][0]?.messages.at(-1)?.content).toBe('Finished anyway.'),
		)
		await userEvent.click(screen.getByRole('button', { name: 'Write something long' }))
		expect(await screen.findByText('Finished anyway.')).toBeTruthy()
	})
})

describe('command lines for program connectors', () => {
	it('keeps a quoted path with spaces in one piece', () => {
		expect(splitCommand('node "/Users/me/My Tools/server.js" --port 3')).toEqual([
			'node',
			'/Users/me/My Tools/server.js',
			'--port',
			'3',
		])
		expect(splitCommand("  tool   'a b'  ")).toEqual(['tool', 'a b'])
		expect(splitCommand('')).toEqual([])
	})
})

describe('white-label', () => {
	it('uses the primitives a host passes down, and its own for the rest', async () => {
		const { host } = makeHost([])
		const Button: NgomatePrimitives['Button'] = ({ variant, active, ...props }) => (
			<button type="button" data-host-button={variant ?? 'default'} {...props} />
		)
		const { container } = render(<NgomateApp host={host} primitives={{ Button }} />)
		const send = await screen.findByRole('button', { name: 'Send' })
		expect(send.getAttribute('data-host-button')).toBe('primary')
		expect(container.querySelector('.ngm-button')).toBeNull()
		expect(container.querySelector('textarea.ngm-input')).not.toBeNull()
	})

	it('sets a theme on its own root, and leaves out what the host left out', async () => {
		const { host } = makeHost([])
		const { container } = render(<NgomateApp host={host} theme={{ accent: 'rebeccapurple' }} />)
		await screen.findByRole('button', { name: 'New conversation' })
		const root = container.querySelector('.ngm-app') as HTMLElement
		expect(root.style.getPropertyValue('--ngm-accent')).toBe('rebeccapurple')
		expect(root.style.getPropertyValue('--ngm-bg')).toBe('')
	})

	it('hides its own name when embedded', async () => {
		const { host } = makeHost([])
		const { container } = render(<NgomateApp host={host} embedded />)
		await screen.findByRole('button', { name: 'New conversation' })
		expect(container.querySelector('.ngm-brand')).toBeNull()
	})
})

describe('recommendedModelId', () => {
	const models = [
		{ id: 'big', minRamGb: 32, sizeBytes: 20 },
		{ id: 'first', minRamGb: 8, sizeBytes: 6 },
		{ id: 'second', minRamGb: 8, sizeBytes: 5 },
		{ id: 'small', minRamGb: 4, sizeBytes: 2 },
	]

	it('offers the most capable that fits, and nothing when none does', () => {
		expect(recommendedModelId(models, 64)).toBe('big')
		expect(recommendedModelId(models, 16)).toBe('first')
		expect(recommendedModelId(models, 6)).toBe('small')
		expect(recommendedModelId(models, 2)).toBeNull()
	})

	it('leaves out what the disk cannot take, unless it is already there', () => {
		expect(recommendedModelId(models, 16, 3)).toBe('small')
		const installed = { id: 'first', minRamGb: 8, sizeBytes: 6, installed: true }
		expect(recommendedModelId([installed], 16, 3)).toBe('first')
	})
})

describe('textBudget', () => {
	it('shrinks with the model, so less is read rather than a request failing', () => {
		expect(textBudget(16384).document).toBeGreaterThan(textBudget(4096).document)
		expect(textBudget(4096).input).toBeLessThan(4096 * 3)
		const room = textBudget(8192)
		expect(room.document + room.memory).toBeLessThan(room.input)
	})

	it('reads a long document for the request, and says it read only part', () => {
		const long = {
			name: 'a.txt',
			text: `${'Opening. '.repeat(400)}\n\nThe borehole cost EUR 18,400.`,
			truncated: false,
		}
		const block = documentBlock(long, 'What did the borehole cost?', 1500)
		expect(block.cut).toBe(true)
		expect(block.text).toContain('EUR 18,400')
		expect(block.text).toContain('Only the passages closest')
		expect(documentBlock({ ...long, text: 'Short.' }, 'anything', 1500).cut).toBe(false)
	})
})

describe('useIdleUnload', () => {
	afterEach(() => vi.useRealTimers())

	it('unloads after the idle time, and not while a request is running', () => {
		vi.useFakeTimers()
		const unload = vi.fn(async () => {})
		const { result } = renderHook(() => useIdleUnload(unload, 1000))
		result.current(true)
		vi.advanceTimersByTime(5000)
		expect(unload).not.toHaveBeenCalled()
		result.current(false)
		vi.advanceTimersByTime(999)
		expect(unload).not.toHaveBeenCalled()
		vi.advanceTimersByTime(1)
		expect(unload).toHaveBeenCalledTimes(1)
	})

	it('starts counting again when another request comes in', () => {
		vi.useFakeTimers()
		const unload = vi.fn(async () => {})
		const { result } = renderHook(() => useIdleUnload(unload, 1000))
		result.current(true)
		result.current(false)
		vi.advanceTimersByTime(900)
		result.current(true)
		vi.advanceTimersByTime(5000)
		expect(unload).not.toHaveBeenCalled()
	})

	it('unloads when the interface goes away, but only a model it used', () => {
		const unload = vi.fn(async () => {})
		const first = renderHook(() => useIdleUnload(unload, 1000))
		first.unmount()
		expect(unload).not.toHaveBeenCalled()
		const second = renderHook(() => useIdleUnload(unload, 1000))
		second.result.current(true)
		second.unmount()
		expect(unload).toHaveBeenCalledTimes(1)
	})
})
