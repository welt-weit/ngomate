// @vitest-environment jsdom
import type { ChatRequest, ModelClient, ModelReply, ToolSource } from '@ngomate/core'
import {
	cleanup,
	createEvent,
	fireEvent,
	render,
	renderHook,
	screen,
	waitFor,
	within,
} from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { connectionProblem, splitCommand } from '../src/AddonsPanel.js'
import { describeTiming } from '../src/Chat.js'
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
		await userEvent.click(await screen.findByRole('button', { name: 'Tasks' }))
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
		await userEvent.click(await screen.findByRole('button', { name: 'Tasks' }))
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

	it('shows an answer only once it is complete, when the person chose that', async () => {
		const { host, chat } = makeHost([], { wholeAnswers: true })
		let finish = () => {}
		chat.mockImplementationOnce(
			(request: ChatRequest) =>
				new Promise((resolve) => {
					request.onText?.('The first part')
					finish = () => resolve(say('The first part, and the rest.'))
				}),
		)
		render(<NgomateApp host={host} />)
		await typeAndSend('Write')
		expect(await screen.findByText('Writing the answer…')).toBeTruthy()
		expect(screen.queryByText('The first part')).toBeNull()
		finish()
		expect(await screen.findByText('The first part, and the rest.')).toBeTruthy()
		expect(screen.queryByText('Writing the answer…')).toBeNull()
	})

	it('stops following the answer once the person scrolls up, and follows again on the next message', async () => {
		const scrolled = vi.fn()
		Element.prototype.scrollIntoView = scrolled
		const { host, chat } = makeHost([say('Second answer.')])
		let write: (piece: string) => void = () => {}
		let finish = () => {}
		chat.mockImplementationOnce(
			(request: ChatRequest) =>
				new Promise((resolve) => {
					write = (piece) => request.onText?.(piece)
					finish = () => resolve(say('Start of it and more.'))
				}),
		)
		render(<NgomateApp host={host} />)
		await typeAndSend('Write')
		write('Start of it')
		await screen.findByText('Start of it')
		const list = document.querySelector('.ngm-messages') as HTMLElement
		Object.defineProperty(list, 'scrollHeight', { value: 2000, configurable: true })
		Object.defineProperty(list, 'clientHeight', { value: 500, configurable: true })
		list.scrollTop = 200
		fireEvent.scroll(list)
		scrolled.mockClear()
		write(' and more.')
		await screen.findByText('Start of it and more.')
		finish()
		await screen.findByRole('button', { name: 'Send' })
		expect(scrolled).not.toHaveBeenCalled()
		await typeAndSend('Again')
		await screen.findByText('Second answer.')
		expect(scrolled).toHaveBeenCalled()
		Reflect.deleteProperty(Element.prototype, 'scrollIntoView')
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

	it('offers Retry on a question that got no answer, and answers it in place', async () => {
		const replies: ModelReply[] = []
		const { host, conversations } = makeHost(replies)
		render(<NgomateApp host={host} />)
		await typeAndSend('Find funding')
		await screen.findByRole('alert')
		expect(await screen.findByText('No answer')).toBeTruthy()
		replies.push(say('Here are two funds.'))
		await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
		await screen.findByText('Here are two funds.')
		expect(screen.queryByText('No answer')).toBeNull()
		await waitFor(() => {
			const saved = [...conversations.values()][0]
			expect(saved?.messages.map((message) => message.content)).toEqual([
				'Find funding',
				'Here are two funds.',
			])
			expect(Object.keys(saved?.times ?? {})).toEqual(['0', '1'])
		})
	})

	it('retries a question through the ready-made task it was asked with', async () => {
		const replies: ModelReply[] = []
		const { host, chat, conversations } = makeHost(replies)
		render(<NgomateApp host={host} />)
		await userEvent.click(await screen.findByRole('button', { name: 'Tasks' }))
		await userEvent.click(await screen.findByRole('button', { name: 'Draft a section' }))
		await typeAndSend('Question 2')
		expect(await screen.findByText('No answer')).toBeTruthy()
		replies.push(say('The section.'))
		await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
		await screen.findByText('The section.')
		const again = chat.mock.calls.at(-1)?.[0] as ChatRequest
		expect(again.tools).toEqual([])
		expect(again.messages.at(1)?.content).toContain('Use only what is given.')
		await waitFor(() => expect([...conversations.values()][0]?.tasks).toEqual({ 0: 'draft' }))
	})

	it('shows when each message was sent, and keeps Copy and Save in the message menu', async () => {
		const { host } = makeHost([say('Done.')])
		render(<NgomateApp host={host} />)
		await typeAndSend('Hi')
		await screen.findByText('Done.')
		expect(document.querySelectorAll('.ngm-messages time')).toHaveLength(2)
		const menus = screen.getAllByRole('button', { name: 'More actions' })
		await userEvent.click(menus[1] as HTMLElement)
		const menu = within(screen.getByRole('group', { name: 'More actions' }))
		expect(menu.getAllByRole('button').map((button) => button.textContent)).toEqual([
			'Copy',
			'Save as file',
			'Retry',
		])
		await userEvent.keyboard('{Escape}')
		expect(screen.queryByRole('button', { name: 'Save as file' })).toBeNull()
	})

	it('keeps where the wait for an answer went, and shows it on the answer time', async () => {
		const { host, conversations } = makeHost([
			{
				...say('Done.'),
				timing: {
					firstMs: 900,
					totalMs: 2000,
					promptRead: 1830,
					promptReused: 2100,
					promptMs: 850,
					tokensPerSecond: 14.2,
				},
			},
		])
		render(<NgomateApp host={host} />)
		await typeAndSend('Hi')
		await screen.findByText('Done.')
		await waitFor(() => {
			const timing = [...conversations.values()][0]?.notices[1]?.timing
			expect(timing?.modelCalls).toHaveLength(1)
			expect(timing?.firstWordMs).toBeTypeOf('number')
			expect(timing?.toolCalls).toEqual([])
			expect(timing?.hiddenMs).toBe(0)
		})
		const shown = document.querySelectorAll('.ngm-messages time')[1]?.getAttribute('title') ?? ''
		expect(shown).toMatch(/^First words after \d+\.\d s, done after \d+\.\d s/)
		expect(shown).toContain(
			'Model call 1: 2.0 s, read 1,830 tokens (2,100 reused) in 0.8 s, wrote 14.2 tokens/s',
		)
	})

	it('selects the answer on Select All, then the conversation, and never the interface', async () => {
		const { host } = makeHost([say('An answer to copy.')])
		render(<NgomateApp host={host} />)
		await typeAndSend('A question')
		const answer = await screen.findByText('An answer to copy.')
		const selection = document.getSelection() as Selection
		selection.collapse(answer.firstChild as Node, 3)
		const selectAll = () =>
			fireEvent.keyDown(document.body, { key: 'a', metaKey: true, ctrlKey: false })
		selectAll()
		expect(selection.toString().trim()).toBe('An answer to copy.')
		selectAll()
		expect(selection.toString()).toContain('A question')
		expect(selection.toString()).toContain('An answer to copy.')
		expect(selection.toString()).not.toContain('Conversations')
		// In the text box the usual Select All applies.
		const box = screen.getByRole('textbox')
		expect(fireEvent.keyDown(box, { key: 'a', ctrlKey: true })).toBe(true)
		selection.removeAllRanges()
	})

	it('counts the time the app was out of sight while answering', async () => {
		const { host, chat, conversations } = makeHost([])
		let finish = () => {}
		chat.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finish = () => resolve(say('Back again.'))
				}),
		)
		render(<NgomateApp host={host} />)
		await typeAndSend('Hi')
		await waitFor(() => expect(chat).toHaveBeenCalled())
		const setHidden = (value: boolean) => {
			Object.defineProperty(document, 'hidden', { value, configurable: true })
			document.dispatchEvent(new Event('visibilitychange'))
		}
		setHidden(true)
		await new Promise((resolve) => setTimeout(resolve, 30))
		setHidden(false)
		finish()
		await screen.findByText('Back again.')
		Reflect.deleteProperty(document, 'hidden')
		await waitFor(() =>
			expect([...conversations.values()][0]?.notices[1]?.timing?.hiddenMs).toBeGreaterThanOrEqual(
				25,
			),
		)
	})

	it('shows each tool call and its time on the network on the answer time', () => {
		const shown = describeTiming({
			firstWordMs: 1000,
			totalMs: 140000,
			startMs: 10,
			knowledgeMs: null,
			toolMs: 131000,
			toolCalls: [{ tool: 'search_opportunities', ms: 131000, httpMs: 2100 }],
			modelCalls: [],
			hiddenMs: 120000,
		})
		expect(shown).toContain('The app was out of sight for 120.0 s')
		expect(shown).toContain('search_opportunities: 131.0 s, 2.1 s of it on the network')
	})

	it('opens a conversation dragged from the list onto a tab bar, and ignores anything else dropped there', async () => {
		const { host } = makeHost([say('Done.')])
		render(<NgomateApp host={host} />)
		await typeAndSend('Hi')
		await screen.findByText('Done.')
		await userEvent.click(screen.getByRole('button', { name: 'New conversation side by side' }))
		await waitFor(() => expect(document.querySelectorAll('.ngm-pane')).toHaveLength(2))

		// jsdom has no DataTransfer; this carries what a real drag would.
		const transfer = () => {
			const data = new Map<string, string>()
			return {
				types: [] as string[],
				effectAllowed: '',
				dropEffect: '',
				setData(type: string, value: string) {
					data.set(type, value)
					this.types.push(type)
				},
				getData: (type: string) => data.get(type) ?? '',
			}
		}
		const bars = () => [...document.querySelectorAll<HTMLElement>('.ngm-tabs')]
		const right = bars()[1] as HTMLElement

		// A file or text from outside, and a conversation id this window does not have, open nothing.
		const foreign = transfer()
		foreign.setData('text/plain', 'hello')
		fireEvent.dragOver(right, { dataTransfer: foreign })
		fireEvent.drop(right, { dataTransfer: foreign })
		const unknown = transfer()
		unknown.setData('application/x-ngomate-conversation', 'not-a-conversation')
		fireEvent.dragOver(right, { dataTransfer: unknown })
		fireEvent.drop(right, { dataTransfer: unknown })
		expect(document.querySelectorAll('.ngm-pane')).toHaveLength(2)
		expect(document.querySelectorAll('.ngm-tab')).toHaveLength(2)

		const item = document.querySelector('.ngm-side-item') as HTMLElement
		const drag = transfer()
		fireEvent.dragStart(item, { dataTransfer: drag })
		fireEvent.dragOver(right, { dataTransfer: drag })
		expect(right.classList.contains('ngm-tabs-dropping')).toBe(true)
		fireEvent.drop(right, { dataTransfer: drag })

		// It moved: the pane it left was empty and closed, and it is now the tab in use beside the new one.
		await waitFor(() => expect(document.querySelectorAll('.ngm-pane')).toHaveLength(1))
		expect(document.querySelectorAll('.ngm-tab')).toHaveLength(2)
		expect(document.querySelector('.ngm-tab-active')?.getAttribute('title')).toBe(
			item.querySelector('button')?.textContent,
		)
		expect(document.querySelector('.ngm-tabs-dropping')).toBeNull()
		expect(screen.getByText('Done.')).toBeTruthy()

		// Within a bar, the left half of a tab means before it and the right half after it.
		const tabs = () => [...document.querySelectorAll<HTMLElement>('.ngm-tab')]
		const titles = () => tabs().map((tab) => tab.getAttribute('title'))
		const [first, second] = titles()
		const dropOnFirst = (clientX: number) => {
			const target = tabs()[0] as HTMLElement
			target.getBoundingClientRect = () => ({ left: 0, width: 100 }) as DOMRect
			const move = transfer()
			fireEvent.dragStart(tabs()[1] as HTMLElement, { dataTransfer: move })
			// jsdom has no DragEvent either, so the pointer position is set on the event by hand.
			const over = createEvent.dragOver(target, { dataTransfer: move })
			Object.defineProperty(over, 'clientX', { value: clientX })
			fireEvent(target, over)
			fireEvent.drop(target, { dataTransfer: move })
		}
		dropOnFirst(80)
		expect(titles()).toEqual([first, second])
		dropOnFirst(20)
		expect(titles()).toEqual([second, first])
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

	it('looks up the question in a connected knowledge base when the model asks', async () => {
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
			[say('You are welcome.'), call('search_knowledge', { query: 'soil' }), say('Use compost.')],
			{ addons: [addon] },
			{ connectAddon: async () => source },
		)
		render(<NgomateApp host={host} />)
		// Nothing to look up: no search, and no entries named as if they were consulted.
		await typeAndSend('Thanks!')
		await screen.findByText('You are welcome.')
		expect(callTool).not.toHaveBeenCalled()
		await typeAndSend('How do we restore soil?')
		await screen.findByText('Use compost.')
		expect(callTool).toHaveBeenCalledTimes(1)
		expect(callTool).toHaveBeenCalledWith(
			'search_knowledge',
			expect.objectContaining({ query: 'How do we restore soil?' }),
		)
		expect(await screen.findByText(/Looked up in the knowledge base: Soil guide/)).toBeTruthy()
	})

	it('tells the model which services are connected, so it can say so without a search', async () => {
		const callTool = vi.fn()
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
		const addon = (name: string, enabled: boolean) => ({
			id: name,
			name,
			connection: { kind: 'http' as const, url: 'https://x.example' },
			enabled,
			allowDestructive: false,
		})
		const { host, chat } = makeHost(
			[say('Yes, I am connected to Field Network.')],
			{ addons: [addon('Field Network', true), addon('Old Wiki', false)] },
			{ connectAddon: async () => source },
		)
		render(<NgomateApp host={host} />)
		await typeAndSend('Are you connected to Field Network?')
		await screen.findByText('Yes, I am connected to Field Network.')
		const system = chat.mock.calls[0]?.[0].messages[0]?.content ?? ''
		expect(system).toContain(
			'You are connected to these services through their tools: Field Network.',
		)
		expect(system).not.toContain('Old Wiki')
		expect(callTool).not.toHaveBeenCalled()
	})

	it('shows the mark beside the app name when the host has one, and the name alone otherwise', async () => {
		const { host } = makeHost([])
		const { container, unmount } = render(
			<NgomateApp host={{ ...host, logo: { light: '/l.svg', dark: '/d.svg' } }} />,
		)
		expect((await screen.findByRole('heading', { level: 1 })).textContent).toBe('NGOmate')
		// Beside the name it is decoration, so a screen reader reads the name once.
		expect(container.querySelector('.ngm-brand img')?.getAttribute('alt')).toBe('')
		expect(container.querySelector('.ngm-brand img')?.getAttribute('src')).toBe('/l.svg')
		unmount()
		const plain = render(<NgomateApp host={host} />)
		expect((await screen.findByRole('heading', { level: 1 })).textContent).toBe('NGOmate')
		expect(plain.container.querySelector('.ngm-brand img')).toBeNull()
	})

	it('searches before every message for a model that seldom asks', async () => {
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
		const models = {
			start: async () => ({
				baseUrl: 'http://127.0.0.1:1/v1',
				apiKey: 'k',
				contextTokens: 8192,
				searchKnowledgeFirst: true,
			}),
			stop: async () => {},
		} as unknown as NonNullable<NgomateHost['models']>
		const { host } = makeHost(
			[say('Use compost.')],
			{ addons: [addon], model: { kind: 'local', id: 'small' } },
			{ connectAddon: async () => source, models },
		)
		render(<NgomateApp host={host} />)
		await typeAndSend('How do we restore soil?')
		await screen.findByText('Use compost.')
		expect(callTool).toHaveBeenCalledTimes(1)
		expect(callTool).toHaveBeenCalledWith(
			'search_knowledge',
			expect.objectContaining({ query: 'How do we restore soil?' }),
		)
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
	const toConnectors = async () => {
		await userEvent.click(await screen.findByRole('button', { name: 'Connectors' }))
	}

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
		expect(saved.flatMap((each) => each.addons)).toEqual([])
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
		// Opening the page is saved as a tab; no connector is.
		expect(saved.flatMap((each) => each.addons)).toEqual([])

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
		const notice = /the assistant sends your question to its knowledge/
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

describe('moving a tab while its answer is written', () => {
	it('keeps writing when the tab is dragged to another pane', async () => {
		let release: (reply: ModelReply) => void = () => {}
		const { host, chat, conversations } = makeHost([])
		chat.mockImplementationOnce(
			(request: ChatRequest) =>
				new Promise((resolve) => {
					request.onText?.('Halfway')
					release = resolve
				}),
		)
		render(<NgomateApp host={host} />)
		await typeAndSend('Write something long')
		await screen.findByText('Halfway')
		await userEvent.click(screen.getByRole('button', { name: 'New conversation side by side' }))
		await waitFor(() => expect(document.querySelectorAll('.ngm-pane')).toHaveLength(2))

		const data = new Map<string, string>()
		const drag = {
			types: [] as string[],
			effectAllowed: '',
			dropEffect: '',
			setData(type: string, value: string) {
				data.set(type, value)
				this.types.push(type)
			},
			getData: (type: string) => data.get(type) ?? '',
		}
		const right = document.querySelectorAll<HTMLElement>('.ngm-tabs')[1] as HTMLElement
		fireEvent.dragStart(document.querySelector('.ngm-tab') as HTMLElement, { dataTransfer: drag })
		fireEvent.dragOver(right, { dataTransfer: drag })
		fireEvent.drop(right, { dataTransfer: drag })
		await waitFor(() => expect(document.querySelectorAll('.ngm-pane')).toHaveLength(1))

		const request = chat.mock.calls[0]?.[0] as ChatRequest
		expect(request.signal?.aborted).toBe(false)
		expect(screen.getByText('Halfway')).toBeTruthy()
		release(say('Halfway, and finished.'))
		expect(await screen.findByText('Halfway, and finished.')).toBeTruthy()
		expect([...conversations.values()][0]?.messages.at(-1)?.content).toBe('Halfway, and finished.')
	})
})

describe('tabs between launches', () => {
	it('opens the tabs and panes from last time, and keeps each change for next time', async () => {
		const saved: Settings[] = []
		const { host, conversations } = makeHost(
			[],
			{
				layout: {
					panes: [
						{ tabs: ['one', 'deleted'], active: 'one' },
						{ tabs: ['two'], active: 'two' },
					],
					focused: 1,
				},
			},
			{ saveSettings: async (next) => void saved.push(next) },
		)
		for (const [id, content] of [
			['one', 'First chat'],
			['two', 'Second chat'],
		] as const) {
			conversations.set(id, {
				id,
				title: content,
				updatedAt: '2026-01-01T00:00:00.000Z',
				messages: [{ role: 'user', content }],
				notices: {},
			})
		}
		render(<NgomateApp host={host} />)
		await waitFor(() => expect(document.querySelectorAll('.ngm-pane')).toHaveLength(2))
		expect(
			[...document.querySelectorAll('.ngm-tab')].map((tab) => tab.getAttribute('title')),
		).toEqual(['First chat', 'Second chat'])
		// The pane that was in use is in use again, showing its conversation.
		await waitFor(() =>
			expect(
				[...document.querySelectorAll('.ngm-chat-holder:not([hidden]) .ngm-messages')].map(
					(list) => list.textContent,
				),
			).toEqual([expect.stringContaining('First chat'), expect.stringContaining('Second chat')]),
		)
		expect(document.querySelectorAll('.ngm-pane')[1]?.classList.contains('ngm-pane-focused')).toBe(
			true,
		)
		// Reading it back saves nothing: only a change does.
		expect(saved).toHaveLength(0)

		await userEvent.click(
			screen.getAllByRole('button', { name: 'New conversation side by side' })[0] as HTMLElement,
		)
		await waitFor(() => expect(saved.at(-1)?.layout?.panes).toHaveLength(3))
		expect(saved.at(-1)?.layout?.panes[0]?.tabs).toEqual(['one'])
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

describe('update notice', () => {
	afterEach(cleanup)

	it('shows nothing when there is no newer version, or the host cannot tell', async () => {
		const { host } = makeHost([], {}, { checkForUpdate: async () => null })
		render(<NgomateApp host={host} />)
		await screen.findByRole('button', { name: 'New conversation' })
		expect(screen.queryByText(/is ready/)).toBeNull()
	})

	it('says a newer version is ready, and installs it only when asked', async () => {
		const install = vi.fn(async (onProgress: (fraction: number | null) => void) => {
			onProgress(0.5)
			await new Promise(() => {})
		})
		const { host } = makeHost(
			[],
			{},
			{
				checkForUpdate: async () => ({ version: '0.0.4', notes: 'Figures are checked.', install }),
			},
		)
		render(<NgomateApp host={host} />)
		expect(await screen.findByText(/0\.0\.4 is ready/)).toBeTruthy()
		expect(screen.getByText('Figures are checked.')).toBeTruthy()
		expect(install).not.toHaveBeenCalled()
		await userEvent.click(screen.getByRole('button', { name: 'Install and restart' }))
		expect(install).toHaveBeenCalledTimes(1)
		expect(await screen.findByRole('button', { name: 'Installing… 50%' })).toBeTruthy()
		expect(screen.queryByRole('button', { name: 'Later' })).toBeNull()
	})

	it('says so when installing fails, and can be put off', async () => {
		const { host } = makeHost(
			[],
			{},
			{
				checkForUpdate: async () => ({
					version: '0.0.4',
					notes: null,
					install: async () => {
						throw new Error('signature mismatch')
					},
				}),
			},
		)
		render(<NgomateApp host={host} />)
		await userEvent.click(await screen.findByRole('button', { name: 'Install and restart' }))
		expect(await screen.findByText(/could not be installed/)).toBeTruthy()
		await userEvent.click(screen.getByRole('button', { name: 'Later' }))
		expect(screen.queryByText(/is ready/)).toBeNull()
	})

	it('treats a failed check as nothing to offer', async () => {
		const { host } = makeHost(
			[],
			{},
			{ checkForUpdate: async () => Promise.reject(new Error('offline')) },
		)
		render(<NgomateApp host={host} />)
		await screen.findByRole('button', { name: 'New conversation' })
		expect(screen.queryByText(/is ready/)).toBeNull()
	})
})
