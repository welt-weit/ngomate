import type { ChatRequest, MemoryStore, ModelReply, ToolSource } from '@ngomate/core'
import {
	type Conversation,
	DEFAULT_SETTINGS,
	type ModelHost,
	type NgomateHost,
	type Settings,
} from '../src/host.js'

/** All of this is made up. It lets every screen be seen without a model or a desktop app. */
export const say = (content: string): ModelReply => ({
	content,
	toolCalls: [],
	promptTokens: 0,
	completionTokens: 0,
})

export const call = (name: string, args: unknown): ModelReply => ({
	content: null,
	toolCalls: [{ id: `call-${name}`, name, arguments: JSON.stringify(args) }],
	promptTokens: 0,
	completionTokens: 0,
})

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export const TASKS: NgomateHost['tasks'] = [
	{
		id: 'find-opportunities',
		title: 'Find funding opportunities',
		description: 'Looks for open calls that fit your organization, using a connected tool.',
		ask: 'Who you are, what you work on and where',
		tools: 'all',
		instructions: 'Find open funding opportunities.',
	},
	{
		id: 'draft-proposal-section',
		title: 'Draft a proposal section',
		description: 'Writes one section of a funding proposal from your own notes.',
		ask: "The funder's question and its word limit, plus your notes or an attached document",
		tools: 'none',
		instructions: 'Draft one section.',
	},
	{
		id: 'write-update-or-report',
		title: 'Write an update or report',
		description: 'Turns your notes into a supporter update, article or report section.',
		ask: 'Who it is for and how long, plus your notes or an attached document',
		tools: 'none',
		instructions: 'Write the update.',
	},
]

export const DRAFT = `## The need

In the Larem district, **41 of 62 schools** have no reliable water, and the dry season lasts seven months.

| Year | Tanks | Schools |
|---|---|---|
| 2025 | 14 | 9 |

Still missing from your notes: how the project will be maintained after the grant ends.`

export const SAMPLE_CONVERSATION: Conversation = {
	id: 'sample',
	title: 'Water proposal, question 2',
	updatedAt: '2027-01-15T10:00:00.000Z',
	messages: [
		{ role: 'user', content: 'Draft the answer to question 2 from our notes.' },
		{
			role: 'assistant',
			content: null,
			toolCalls: [{ id: 'a', name: 'search_grants', arguments: '{}' }],
		},
		{ role: 'tool', toolCallId: 'a', content: 'Fictional Water Fund.' },
		{ role: 'assistant', content: DRAFT },
		{ role: 'user', content: 'Where do I apply, and by when?' },
		{ role: 'assistant', content: 'Apply at https://made-up.example/apply by 1 May 2027.' },
	],
	notices: {
		3: { unsourcedDates: [], unsourcedLinks: [], checkFigures: true, stopped: null },
		5: {
			unsourcedDates: ['2027-05-01'],
			unsourcedLinks: ['https://made-up.example/apply'],
			checkFigures: false,
			stopped: 'Stopped because its tool calls kept failing.',
		},
	},
}

export function fakeModels(installed: string[] = ['qwen3-8b-q4']): ModelHost {
	const entry = (
		id: string,
		name: string,
		vendor: string,
		sizeBytes: number,
		partialBytes = 0,
	) => ({
		id,
		name,
		vendor,
		license: 'Apache-2.0',
		sizeBytes,
		minRamGb: 8,
		installed: installed.includes(id),
		partialBytes,
	})
	return {
		info: async () => ({
			models: [
				entry('qwen3-8b-q4', 'Qwen 3 8B', 'Alibaba', 5_027_783_488),
				entry('ministral-3-8b-q4', 'Ministral 3 8B', 'Mistral AI', 5_198_911_904, 1_400_000_000),
				entry('granite-4.2-8b-q4', 'Granite 4.2 8B', 'IBM', 5_347_917_952),
			],
			ramGb: 16,
			freeDiskBytes: 80_000_000_000,
			runningId: null,
		}),
		download: async (id, onProgress) => {
			for (let received = 0; received <= 5; received++) {
				onProgress({
					id,
					receivedBytes: received * 1_000_000_000,
					totalBytes: 5_000_000_000,
					phase: 'downloading',
				})
				await wait(600)
			}
			onProgress({ id, receivedBytes: 0, totalBytes: 5_000_000_000, phase: 'verifying' })
			await wait(800)
		},
		cancelDownload: async () => {},
		remove: async () => {},
		importFile: async () => false,
		start: async () => ({ baseUrl: 'http://fake', apiKey: 'fake' }),
		stop: async () => {},
	}
}

function memoryStore(initial: Record<string, string>): MemoryStore {
	const notes = new Map(Object.entries(initial))
	return {
		list: async () =>
			[...notes].map(([name, text]) => ({ name, updatedAt: null, chars: text.length })),
		read: async (name) => notes.get(name) ?? null,
		write: async (name, text) => void notes.set(name, text),
		remove: async (name) => void notes.delete(name),
	}
}

const fakeAddon: ToolSource = {
	listTools: async () => [
		{
			name: 'search_grants',
			description: 'Search open grants',
			inputSchema: {},
			annotations: { readOnly: true },
		},
		{ name: 'add_contact', description: 'Add a contact', inputSchema: {} },
		{
			name: 'delete_everything',
			description: 'Delete all',
			inputSchema: {},
			annotations: { destructive: true },
		},
	],
	callTool: async () => ({
		text: 'Fictional Water Fund. Deadline 2027-03-01. https://fund.example/water-7',
		isError: false,
	}),
	close: async () => {},
}

export type FakeHostOptions = {
	replies?: ModelReply[]
	settings?: Partial<Settings>
	conversations?: Conversation[]
	notes?: Record<string, string>
	models?: ModelHost
}

export function createFakeHost(options: FakeHostOptions = {}): NgomateHost {
	const replies = [...(options.replies ?? [])]
	const conversations = new Map((options.conversations ?? []).map((item) => [item.id, item]))
	let settings: Settings = {
		...DEFAULT_SETTINGS,
		model: { kind: 'server', baseUrl: 'http://fake', model: 'fake' },
		...options.settings,
	}
	return {
		appName: 'NGOmate',
		tasks: TASKS,
		memory: memoryStore(options.notes ?? {}),
		models: options.models,
		loadSettings: async () => settings,
		saveSettings: async (next) => {
			settings = next
		},
		listConversations: async () => [...conversations.values()],
		readConversation: async (id) => conversations.get(id) ?? null,
		writeConversation: async (conversation) =>
			void conversations.set(conversation.id, conversation),
		removeConversation: async (id) => void conversations.delete(id),
		pickDocument: async () => ({
			name: 'field-notes.pdf',
			text: 'Made-up notes.',
			truncated: false,
		}),
		saveDocument: async () => true,
		createModelClient: () => ({
			async chat(request: ChatRequest) {
				const reply = replies.shift() ?? say('That is all this preview has scripted.')
				for (const word of reply.content?.split(/(?<= )/) ?? []) {
					if (request.signal?.aborted) throw new Error('aborted')
					request.onText?.(word)
					await wait(35)
				}
				return reply
			},
		}),
		connectAddon: async () => fakeAddon,
		getSecret: async () => null,
		setSecret: async () => {},
		deleteSecret: async () => {},
	}
}
