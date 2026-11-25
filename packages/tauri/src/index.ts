import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import {
	type JobStore,
	type MemoryStore,
	type TaskFile,
	TeamConflict,
	type TeamStore,
	connectMcpToolSource,
	createOpenAiCompatibleClient,
	parseJobState,
	parseTeamFile,
	serializeTeamFile,
} from '@ngomate/core'
import {
	type Conversation,
	DEFAULT_SETTINGS,
	type FilesHost,
	type ModelHost,
	type NgomateHost,
	type OwnTaskStore,
	type PickedDocument,
	type Settings,
	type TeamHost,
	type VoiceHost,
	type WakeHost,
} from '@ngomate/ui'
import { Channel, invoke } from '@tauri-apps/api/core'
import { fetch as tauriFetch } from '@tauri-apps/plugin-http'

const call = <T>(command: string, args?: Record<string, unknown>) =>
	invoke<T>(`plugin:ngomate|${command}`, args)

type Entry = { name: string; updatedAt: number | null; bytes: number }

const toIso = (millis: number | null) => (millis ? new Date(millis).toISOString() : null)

const memory: MemoryStore = {
	async list() {
		const entries = await call<Entry[]>('store_list', { area: 'memory' })
		return entries.map((entry) => ({
			name: entry.name,
			updatedAt: toIso(entry.updatedAt),
			chars: entry.bytes,
		}))
	},
	read: (name) => call<string | null>('store_read', { area: 'memory', name }),
	write: (name, text) => call('store_write', { area: 'memory', name, text }),
	remove: (name) => call('store_remove', { area: 'memory', name }),
}

/** Changes to one job's state, one after another: a run's result and a click on Pause must not cross. */
const jobQueue = new Map<string, Promise<unknown>>()
function oneAtATime<T>(id: string, work: () => Promise<T>): Promise<T> {
	const before = jobQueue.get(id) ?? Promise.resolve()
	const next = before.then(work, work)
	const settled = next.catch(() => {})
	jobQueue.set(id, settled)
	void settled.then(() => {
		if (jobQueue.get(id) === settled) jobQueue.delete(id)
	})
	return next
}

const jobs: JobStore = {
	async list() {
		const entries = await call<Entry[]>('store_list', { area: 'jobs' })
		return Promise.all(
			entries.map(async (entry) => {
				const [text, state] = await Promise.all([
					call<string | null>('store_read', { area: 'jobs', name: entry.name }),
					call<string | null>('store_read', { area: 'job-states', name: entry.name }),
				])
				return { id: entry.name, text: text ?? '', state: parseJobState(state) }
			}),
		)
	},
	write: (id, text) => call('store_write', { area: 'jobs', name: id, text }),
	replace: (id, text) =>
		oneAtATime(id, async () => {
			if ((await call<string | null>('store_read', { area: 'jobs', name: id })) === null)
				throw new Error('This job is not there any more.')
			await call('store_write', { area: 'jobs', name: id, text })
		}),
	update: (id, change) =>
		oneAtATime(id, async () => {
			// A job deleted meanwhile keeps no state, or a new job of the same name would take it over.
			const file = await call<string | null>('store_read', { area: 'jobs', name: id })
			if (file === null) return null
			const text = await call<string | null>('store_read', { area: 'job-states', name: id })
			const next = change(parseJobState(text))
			if (!next) return null
			await call('store_write', {
				area: 'job-states',
				name: id,
				text: JSON.stringify(next, null, 2),
			})
			return next
		}),
	remove: (id) =>
		oneAtATime(id, async () => {
			// The file first: a state without its file is never written again (see update), and the next job
			// of that name writes its own.
			await call('store_remove', { area: 'jobs', name: id })
			await call('store_remove', { area: 'job-states', name: id })
		}),
}

type TeamEntry = { name: string; version: string; updatedAt: number | null; bytes: number }
type TeamRead = { text: string; version: string }
type Written = { version: string | null; conflict: boolean }

const teamStore: TeamStore = {
	async list(area) {
		const entries = await call<TeamEntry[]>('team_list', { area })
		return entries.map((entry) => ({ ...entry, updatedAt: toIso(entry.updatedAt) }))
	},
	read: (area, name) => call<TeamRead | null>('team_read', { area, name }),
	async write(area, name, text, expected) {
		const written = await call<Written>('team_write', { area, name, text, expected })
		if (written.conflict) throw new TeamConflict(area, name)
		return { version: written.version }
	},
	async remove(area, name, expected) {
		const written = await call<Written>('team_remove', { area, name, expected })
		if (written.conflict) throw new TeamConflict(area, name)
	},
	async readTeamFile() {
		const read = await call<TeamRead | null>('team_file_read')
		return read ? parseTeamFile(read.text) : null
	},
}

/** A team whose notes and tasks sit in a folder the team's own sync app shares. */
const team: TeamHost = {
	teams: () => call('teams'),
	switchTo: (id) => call('team_switch', { id }),
	label: (name) => call('team_label', { name }),
	location: () => call('team_location'),
	chooseFolder: () => call<string | null>('team_folder_choose'),
	use: (location, secret) => call('team_use', { location, secret: secret ?? null }),
	forget: () => call('team_forget'),
	noteCopies: (id) => ({
		load: () => call('team_note_copies_load', { id }),
		save: (notes) => call('team_note_copies_save', { id, notes }),
	}),
	nextcloudLogin: {
		start: (server) => call('nextcloud_login_start', { server }),
		wait: (pollUrl, token) => call('nextcloud_login_wait', { pollUrl, token }),
	},
	store: teamStore,
	async readTeamFile() {
		const read = await call<TeamRead | null>('team_file_read')
		return read ? { team: parseTeamFile(read.text), version: read.version } : null
	},
	async writeTeamFile(file, expected) {
		const written = await call<Written>('team_file_write', {
			text: serializeTeamFile(file),
			expected,
		})
		if (written.conflict) throw new TeamConflict('notes', 'the team settings')
	},
}

const models: ModelHost = {
	info: () => call('model_info'),
	async download(id, onProgress) {
		const channel = new Channel<Parameters<typeof onProgress>[0]>()
		channel.onmessage = onProgress
		await call('model_download', { id, onProgress: channel })
	},
	cancelDownload: (id) => call('model_cancel_download', { id }),
	remove: (id) => call('model_remove', { id }),
	importFile: (id) => call('model_import', { id }),
	chooseFolder: () => call('model_folder_choose'),
	resetFolder: () => call('model_folder_reset'),
	start: (id) => call('runtime_start', { id }),
	stop: () => call('runtime_stop'),
}

/** Where jobs write results as files: a folder the person picks, new files only. */
const files: FilesHost = {
	chooseFolder: () => call('folder_choose'),
	writeNew: (folder, name, text) => call('file_write_new', { folder, name, text }),
}

/** Starting NGOmate for jobs at their times while it is closed, through the system's own scheduler. */
const wake: WakeHost = {
	set: (times) => call('wake_set', { times }),
	startedForJobs: () => call('wake_started_for_jobs'),
	doneWithJobs: () => call('wake_done_with_jobs'),
}

/** Voice input with Whisper, built into the plugin. Its models download like the chat models. */
const voice: VoiceHost = {
	info: () => call('voice_info'),
	prepare: (id) => call('voice_prepare', { id }),
	download: models.download,
	cancelDownload: models.cancelDownload,
	remove: models.remove,
	// Sent as raw bytes, the samples as they are: as JSON numbers a minute of speech is megabytes of text.
	transcribe: (id, samples) =>
		invoke<string>(
			'plugin:ngomate|voice_transcribe',
			new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength),
			{ headers: { 'x-voice-model': id } },
		),
}

/** A connector that is a program on this computer, speaking MCP over its input and output. */
export function programTransport(id: string, command: string, args: string[]): Transport {
	const transport: Transport = {
		async start() {
			const onLine = new Channel<string>()
			onLine.onmessage = (line) => {
				if (!line.trim()) return
				try {
					transport.onmessage?.(JSON.parse(line) as JSONRPCMessage)
				} catch (err) {
					transport.onerror?.(err instanceof Error ? err : new Error(String(err)))
				}
			}
			const onClose = new Channel<null>()
			onClose.onmessage = () => transport.onclose?.()
			await call('addon_start', { id, command, args, onLine, onClose })
		},
		send: (message) => call('addon_send', { id, line: JSON.stringify(message) }),
		close: () => call('addon_stop', { id }),
	}
	return transport
}

/** Far more than any task needs; a bigger file in the tasks folder is not read. */
const TASK_FILE_MAX_BYTES = 200_000

/** Tasks the person made, as Markdown files beside their notes. */
const ownTasks: OwnTaskStore = {
	async list() {
		const entries = await call<Entry[]>('store_list', { area: 'tasks' })
		// One file that cannot be read, or is far too long for a task, is listed as broken rather than
		// hiding all the others.
		const read = await Promise.all(
			entries.map(async (entry) => ({
				id: entry.name,
				text:
					entry.bytes > TASK_FILE_MAX_BYTES
						? ''
						: await call<string | null>('store_read', { area: 'tasks', name: entry.name }).catch(
								() => '',
							),
			})),
		)
		return read.flatMap((entry) =>
			entry.text === null ? [] : [{ id: entry.id, text: entry.text }],
		)
	},
	write: (id, text) => call('store_write', { area: 'tasks', name: id, text }),
	remove: (id) => call('store_remove', { area: 'tasks', name: id }),
}

/** Everything the interface needs from a Tauri window with the plugin installed. */
export function createTauriHost(options: { appName: string; tasks: TaskFile[] }): NgomateHost {
	return {
		...options,
		memory,
		jobs,
		ownTasks,
		voice,
		files,
		wake,
		models,
		team,
		async loadSettings() {
			const stored = await call<string | null>('store_read', { area: 'settings', name: 'settings' })
			return stored
				? { ...DEFAULT_SETTINGS, ...(JSON.parse(stored) as Partial<Settings>) }
				: DEFAULT_SETTINGS
		},
		saveSettings: (settings) =>
			call('store_write', {
				area: 'settings',
				name: 'settings',
				text: JSON.stringify(settings, null, 2),
			}),
		listConversations: () => call('conversation_list'),
		async readConversation(id) {
			const text = await call<string | null>('store_read', { area: 'conversations', name: id })
			return text ? (JSON.parse(text) as Conversation) : null
		},
		writeConversation: (conversation) =>
			call('store_write', {
				area: 'conversations',
				name: conversation.id,
				text: JSON.stringify(conversation),
			}),
		removeConversation: (id) => call('store_remove', { area: 'conversations', name: id }),
		pickDocument: () => call<PickedDocument | null>('pick_document'),
		saveDocument: (suggestedName, text) => call('save_document', { suggestedName, text }),
		createModelClient(baseUrl, model, apiKey) {
			return createOpenAiCompatibleClient({
				baseUrl,
				model,
				apiKey,
				temperature: 0.3,
				fetch: tauriFetch as typeof fetch,
				// Asked of servers that think unless told not to. Those that do not know it ignore it.
				extraBody: { reasoning_effort: 'none' },
			})
		},
		async connectAddon(addon) {
			if (addon.connection.kind === 'command') {
				return connectMcpToolSource({
					// A process per connection: a second one must not end a run still using the first.
					transport: programTransport(
						`${addon.id}-${crypto.randomUUID()}`,
						addon.connection.command,
						addon.connection.args,
					),
					clientName: options.appName,
				})
			}
			const token = await call<string | null>('secret_get', { name: `addon:${addon.id}` })
			return connectMcpToolSource({
				url: addon.connection.url,
				fetch: tauriFetch as typeof fetch,
				clientName: options.appName,
				getAccessToken: token ? async () => token : undefined,
			})
		},
		getSecret: (name) => call('secret_get', { name }),
		setSecret: (name, value) => call('secret_set', { name, value }),
		deleteSecret: (name) => call('secret_delete', { name }),
	}
}
