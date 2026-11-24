import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import {
	type MemoryStore,
	type TaskFile,
	TeamConflict,
	type TeamStore,
	connectMcpToolSource,
	createOpenAiCompatibleClient,
	parseTeamFile,
	serializeTeamFile,
} from '@ngomate/core'
import {
	type Conversation,
	DEFAULT_SETTINGS,
	type ModelHost,
	type NgomateHost,
	type PickedDocument,
	type Settings,
	type TeamHost,
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

/** Everything the interface needs from a Tauri window with the plugin installed. */
export function createTauriHost(options: { appName: string; tasks: TaskFile[] }): NgomateHost {
	return {
		...options,
		memory,
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
