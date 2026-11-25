import {
	type ChatRequest,
	type JobState,
	type JobStore,
	type MemoryStore,
	type ModelReply,
	TeamConflict,
	type TeamStore,
	type ToolSource,
	newTeamFile,
	parseTeamFile,
	serializeTeamFile,
} from '@ngomate/core'
import {
	type Conversation,
	DEFAULT_SETTINGS,
	type ModelHost,
	type NgomateHost,
	type OwnTaskStore,
	type Settings,
	type TeamHost,
	type TeamMembership,
	type VoiceHost,
} from './host.js'

/**
 * A host where everything is made up: a scripted model, sample conversations, notes and teams, all in
 * memory and gone on reload. For seeing every screen without a model or a desktop app, in Storybook
 * and in the browser preview.
 */
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
		3: {
			unsourcedDates: [],
			unsourcedLinks: [],
			checkFigures: true,
			figureProblems: [
				{ figure: '14 tanks', problem: 'different', material: ['12 rainwater tanks'] },
				{ figure: '9 schools', problem: 'missing' },
			],
			stopped: null,
		},
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
		download: null,
	})
	return {
		info: async () => ({
			models: [
				entry('qwen3-8b-q4', 'Qwen 3 8B', 'Alibaba', 5_027_783_488),
				entry('ministral-3-8b-q4', 'Ministral 3 8B', 'Mistral AI', 5_198_911_904, 1_400_000_000),
				entry('granite-4.2-8b-q4', 'Granite 4.2 8B', 'IBM', 5_347_917_952),
			],
			ramGb: 16,
			freeRamGb: 3.2,
			freeDiskBytes: 80_000_000_000,
			runningId: null,
			folder: '/Users/example/Library/Application Support/NGOmate/models',
			folderAvailable: true,
			folderIsDefault: true,
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
		chooseFolder: async () => false,
		resetFolder: async () => {},
		start: async () => ({ baseUrl: 'http://fake', apiKey: 'fake', contextTokens: 16384 }),
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
	/** Teams this person is in, by name, each kept in a made-up shared folder. The first is active. */
	teams?: string[]
	/** Where the made-up teams keep their files: a synced folder, or a WebDAV server. */
	teamStorage?: 'folder' | 'webdav'
	/** Job files and their state, by id. */
	jobs?: Record<string, { text: string; state?: JobState }>
	/** Tasks the person made, by id, as their files' text. */
	ownTasks?: Record<string, string>
	/** Voice input that "hears" this sentence; `installed` voice models are there from the start. */
	voice?: { heard: string; installed?: string[] }
}

/** Jobs in memory, as the desktop app keeps them in files. */
/** Voice input on made-up models: downloads finish at once, and every recording is heard as `heard`. */
export function fakeVoice(options: { heard: string; installed?: string[] }): VoiceHost {
	const installed = new Set(options.installed ?? [])
	const model = (id: string, name: string, sizeBytes: number, minRamGb: number) => ({
		id,
		name,
		vendor: 'OpenAI (Whisper)',
		license: 'MIT',
		sizeBytes,
		minRamGb,
		installed: installed.has(id),
		partialBytes: 0,
		download: null,
	})
	return {
		info: async () => ({
			models: [
				model('whisper-base-q5', 'Voice, standard', 59_707_625, 2),
				model('whisper-tiny-q5', 'Voice, small and fast', 32_152_673, 1),
				model('whisper-small-q5', 'Voice, most accurate', 190_085_487, 4),
			],
			recommended: 'whisper-base-q5',
			freeDiskBytes: 50_000_000_000,
		}),
		async download(id, onProgress) {
			onProgress({ id, receivedBytes: 1, totalBytes: 1, phase: 'downloading' })
			installed.add(id)
		},
		cancelDownload: async () => {},
		remove: async (id) => void installed.delete(id),
		transcribe: async () => options.heard,
		record: async () => ({ stop: async () => new Float32Array(16_000), cancel: () => {} }),
	}
}

export function memoryOwnTasks(initial: Record<string, string> = {}): OwnTaskStore {
	const tasks = new Map(Object.entries(initial))
	return {
		list: async () => [...tasks].map(([id, text]) => ({ id, text })),
		write: async (id, text) => void tasks.set(id, text),
		remove: async (id) => void tasks.delete(id),
	}
}

export function memoryJobStore(initial: FakeHostOptions['jobs'] = {}): JobStore {
	const jobs = new Map(
		Object.entries(initial).map(([id, job]) => [id, { text: job.text, state: job.state ?? null }]),
	)
	return {
		list: async () => [...jobs].map(([id, job]) => ({ id, ...job })),
		write: async (id, text) => void jobs.set(id, { text, state: jobs.get(id)?.state ?? null }),
		replace: async (id, text) => {
			const job = jobs.get(id)
			if (!job) throw new Error('This job is not there any more.')
			jobs.set(id, { ...job, text })
		},
		update: async (id, change) => {
			const job = jobs.get(id)
			const next = change(job?.state ?? null)
			if (!job || !next) return null
			jobs.set(id, { ...job, state: next })
			return next
		},
		remove: async (id) => void jobs.delete(id),
	}
}

/** Teams in memory, each in its own made-up place, with a team file and nothing else. */
function fakeTeams(names: string[], storage: 'folder' | 'webdav' = 'folder'): TeamHost {
	const files = new Map<string, Map<string, { text: string; version: string }>>()
	let next = 1
	const memberships: TeamMembership[] = names.map((name, index) => {
		const id = `team-${index}`
		files.set(
			id,
			new Map([['team', { text: serializeTeamFile(newTeamFile(name, null)), version: 'v0' }]]),
		)
		return {
			id,
			name,
			location:
				storage === 'webdav'
					? {
							type: 'webdav',
							url: `https://dav.example/${encodeURIComponent(name)}`,
							user: 'made-up',
						}
					: { type: 'folder', path: `/Shared/${name}` },
			refusesOverwrites: true,
		}
	})
	let active = memberships[0]?.id ?? null
	const here = () => (active && files.get(active)) || new Map()
	const store: TeamStore = {
		list: async (area) =>
			[...here()]
				.filter(([key]) => key.startsWith(`${area}/`))
				.map(([key, file]) => ({
					name: key.slice(area.length + 1),
					version: file.version,
					updatedAt: null,
					bytes: file.text.length,
				})),
		read: async (area, name) => here().get(`${area}/${name}`) ?? null,
		// Like a real store, a write over a version other than the one read is refused.
		async write(area, name, text, expected) {
			if ((here().get(`${area}/${name}`)?.version ?? null) !== expected)
				throw new TeamConflict(area, name)
			const version = `v${next++}`
			here().set(`${area}/${name}`, { text, version })
			return { version }
		},
		async remove(area, name, expected) {
			if ((here().get(`${area}/${name}`)?.version ?? null) !== expected)
				throw new TeamConflict(area, name)
			here().delete(`${area}/${name}`)
		},
		readTeamFile: async () => {
			const file = here().get('team')
			return file ? parseTeamFile(file.text) : null
		},
	}
	return {
		teams: async () => ({ active, teams: memberships }),
		switchTo: async (id) => {
			active = id
		},
		label: async () => {},
		location: async () =>
			memberships.find((membership) => membership.id === active)?.location ?? null,
		chooseFolder: async () => null,
		use: async () => {},
		forget: async () => {},
		store,
		readTeamFile: async () => {
			const file = here().get('team')
			return file ? { team: parseTeamFile(file.text), version: file.version } : null
		},
		writeTeamFile: async (team) =>
			void here().set('team', { text: serializeTeamFile(team), version: `v${next++}` }),
	}
}

export function createFakeHost(options: FakeHostOptions = {}): NgomateHost {
	const replies = [...(options.replies ?? [])]
	// A token of `wrong` is refused, to show what that looks like.
	const secrets = new Map<string, string>()
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
		jobs: memoryJobStore(options.jobs),
		ownTasks: memoryOwnTasks(options.ownTasks),
		...(options.voice ? { voice: fakeVoice(options.voice) } : {}),
		models: options.models,
		team: fakeTeams(options.teams ?? [], options.teamStorage),
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
		connectAddon: async (addon) => {
			if (secrets.get(`addon:${addon.id}`) === 'wrong')
				throw new Error('Error POSTing to endpoint (HTTP 401)')
			return fakeAddon
		},
		getSecret: async (name) => secrets.get(name) ?? null,
		setSecret: async (name, value) => void secrets.set(name, value),
		deleteSecret: async (name) => void secrets.delete(name),
	}
}
