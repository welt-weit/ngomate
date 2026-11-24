import type {
	ChatMessage,
	FigureProblem,
	MemoryStore,
	ModelClient,
	ModelTiming,
	TaskFile,
	TeamFile,
	TeamNoteCopies,
	TeamStore,
	ToolSource,
	ToolTiming,
} from '@ngomate/core'
import type { StoredLayout } from './layout.js'

/** One model the app offers. Sizes in bytes. */
export type ModelEntry = {
	id: string
	name: string
	vendor: string
	license: string
	sizeBytes: number
	minRamGb: number
	installed: boolean
	/** Bytes already downloaded when a download stopped partway. */
	partialBytes: number
	/** A download running now, also when this window did not start it. */
	download: DownloadProgress | null
}

export type ModelInfo = {
	models: ModelEntry[]
	ramGb: number
	/** Memory free right now. */
	freeRamGb: number
	freeDiskBytes: number
	runningId: string | null
	/** Where models are kept. */
	folder: string
	/** False when the chosen folder is on a drive that is not connected. */
	folderAvailable: boolean
	folderIsDefault: boolean
}

export type DownloadProgress = {
	id: string
	receivedBytes: number
	totalBytes: number
	phase: 'downloading' | 'verifying'
}

/** The local model runtime. A host without one, such as a browser preview, leaves this out. */
export interface ModelHost {
	info(): Promise<ModelInfo>
	download(id: string, onProgress: (progress: DownloadProgress) => void): Promise<void>
	cancelDownload(id: string): Promise<void>
	remove(id: string): Promise<void>
	/** Installs a model file the person picks, for example from a USB stick. False if they cancel. */
	importFile(id: string): Promise<boolean>
	/** Reuses a model already running. `contextTokens` is how much that model can hold at once. */
	/** Asks for a folder and offers to move the models there. False if the person cancels. */
	chooseFolder(): Promise<boolean>
	/** Back to the usual folder, with the same offer. */
	resetFolder(): Promise<void>
	/**
	 * `searchKnowledgeFirst`: in chat, search a connected knowledge base before every message rather than
	 * when the model asks, for a model that seldom asks.
	 */
	start(id: string): Promise<{
		baseUrl: string
		apiKey: string
		contextTokens: number
		searchKnowledgeFirst?: boolean
	}>
	stop(): Promise<void>
}

export type AddonConnection =
	| { kind: 'http'; url: string }
	| { kind: 'command'; command: string; args: string[] }

export type Addon = {
	id: string
	name: string
	connection: AddonConnection
	enabled: boolean
	/** Tools that delete or archive stay hidden unless the person turns this on. */
	allowDestructive: boolean
	/** Tools the person turned off. Each tool left on costs tokens when it is relevant. */
	disabledTools?: string[]
	/** The person's own note on it, such as that the service bills per use. */
	note?: string
}

export type ModelChoice =
	| { kind: 'local'; id: string }
	/** A model server the person runs themselves. Its key, if any, is the secret `model-server`. */
	| { kind: 'server'; baseUrl: string; model: string }

export type Settings = {
	model: ModelChoice | null
	addons: Addon[]
	/** Show an answer once it is complete, rather than as it is written. Off unless chosen. */
	wholeAnswers?: boolean
	/** The tabs and panes open when the app was last used, opened again on the next launch. */
	layout?: StoredLayout
	/** The name this person goes by in a team, shown to the others as information only. */
	yourName?: string
	/** The sidebar is folded to a strip of icons. */
	sidebarCollapsed?: boolean
	/** Conversations kept at the top of the sidebar, by id, in the order pinned. */
	pinned?: string[]
	/** The panel of chats, tasks and jobs on the right is folded to a strip. */
	workCollapsed?: boolean
	/** Which list that panel shows. */
	workGroup?: 'chats' | 'tasks' | 'jobs'
	/** The version of each team task this person last ran, by team and task, so a change is shown. */
	teamTasksSeen?: Record<string, string>
}

export const DEFAULT_SETTINGS: Settings = { model: null, addons: [] }

export type Conversation = {
	id: string
	title: string
	updatedAt: string
	messages: ChatMessage[]
	/** Attached documents, in full. Each message reads again what it needs from them. */
	documents?: PickedDocument[]
	/** What to show beside an answer, keyed by the answer's position in `messages`. */
	notices: Record<number, AnswerNotice>
	/** When each message was sent or answered, keyed by position. Missing on messages kept before this. */
	times?: Record<number, string>
	/** The ready-made task a question was asked through, by its id, keyed by position. So Retry can use it. */
	tasks?: Record<number, string>
}

export type AnswerNotice = {
	unsourcedDates: string[]
	unsourcedLinks: string[]
	checkFigures: boolean
	/** Figures the material does not back. Missing on answers saved before this check existed. */
	figureProblems?: FigureProblem[]
	stopped: string | null
	/** The conversation had grown too long, so the model did not see its beginning. */
	earlierLeftOut?: boolean
	/** Documents only partly read for this answer. */
	partlyRead?: string[]
	/** Files too long to read to the end, so part of them was not even searched. */
	neverRead?: string[]
	/** The answer reached the length limit. */
	cutOff?: boolean
	/** Tools relevant to the request that there was no room to offer. */
	toolsDidNotFit?: string[]
	/** Entries of a connected knowledge base the model was given passages from. */
	knowledgeEntries?: string[]
	/** A connected knowledge base did not answer, so this answer was written without it. */
	knowledgeUnavailable?: boolean
	/** Where the wait for this answer went. Missing on answers kept before this was measured. */
	timing?: AnswerTiming
}

export type AnswerTiming = {
	/** From pressing Send until the first word showed; null when none did. */
	firstWordMs: number | null
	totalMs: number
	/** Waiting for the model to be ready, which includes loading it when it was not running. */
	startMs: number
	/** The knowledge search made before the model was asked; null when none was. */
	knowledgeMs: number | null
	toolMs: number
	/** Each tool call. Missing on answers kept before this was measured. */
	toolCalls?: ToolTiming[]
	modelCalls: ModelTiming[]
	/**
	 * How long the app was out of sight while answering: a computer may slow a hidden window down.
	 * Missing on answers kept before this was measured.
	 */
	hiddenMs?: number
}

export type PickedDocument = {
	name: string
	text: string
	/** The file had more than could be read. */
	truncated: boolean
}

/** A newer version of the app that the host can install. */
export type AvailableUpdate = {
	version: string
	/** What changed, as the release describes it. */
	notes: string | null
	/** Downloads and installs it, then restarts the app. Progress from 0 to 1, or null when unknown. */
	install(onProgress: (fraction: number | null) => void): Promise<void>
}

/** Where a team keeps its notes and tasks. Addresses and names only: secrets stay with the host. */
export type TeamLocation =
	| { type: 'folder'; path: string }
	/** A connector offering the team memory tools, by its id under Connectors. */
	| { type: 'connector'; addonId: string }
	| { type: 's3'; endpoint: string; region: string; bucket: string; accessKeyId: string }
	| { type: 'webdav'; url: string; user: string }

/** A team this person is in, as the host keeps it. */
export type TeamMembership = {
	id: string
	/** The team's name as last read, so the switcher can name a team it cannot reach right now. */
	name: string | null
	location: TeamLocation
	/** False when the storage did not refuse a write over a changed note when it was tested. */
	refusesOverwrites: boolean
}

/**
 * The teams this person is in, one of them active. A host without it leaves this out, and the app is
 * for one person. The host keeps the locations itself: the interface asks it to choose one, never
 * hands it a path. Adding a team makes it the active one; everything else acts on the active one.
 */
export interface TeamHost {
	teams(): Promise<{ active: string | null; teams: TeamMembership[] }>
	switchTo(id: string): Promise<void>
	/** Remembers the active team's name for the switcher. */
	label(name: string): Promise<void>
	location(): Promise<TeamLocation | null>
	/** Asks for a team's shared folder and adds that team. Null when the person cancels. */
	chooseFolder(): Promise<string | null>
	/**
	 * Uses storage reached over the network or a connector. With a secret, the host checks it can list
	 * the notes before keeping anything, and keeps the secret in the keychain.
	 */
	use(location: Exclude<TeamLocation, { type: 'folder' }>, secret?: string): Promise<void>
	/**
	 * Leaves the active team on this computer and forgets its secret, going back to the team active
	 * before. The team's files stay where they are.
	 */
	forget(): Promise<void>
	/** The host's own storage: a folder, S3 or WebDAV. A connector is reached by the app instead. */
	store: TeamStore
	/** The team file with the version it was read at, for changing it. */
	readTeamFile(): Promise<{ team: TeamFile; version: string } | null>
	/** Throws `TeamConflict` when the file is no longer the version read. */
	writeTeamFile(team: TeamFile, expected: string | null): Promise<void>
	/**
	 * Copies of one team's notes kept on this computer between starts, by version, so a new start fetches
	 * only the notes that changed. Removed when the team is forgotten. Without it, every start reads all.
	 */
	noteCopies?(teamId: string): TeamNoteCopies
	/**
	 * Nextcloud's own sign-in, in the person's browser: `start` gives the page to open, `wait` returns
	 * once they have signed in, with a password Nextcloud made for this app. A host without it leaves
	 * them out, and a WebDAV password is typed instead.
	 */
	nextcloudLogin?: {
		start(server: string): Promise<{ loginUrl: string; pollUrl: string; token: string }>
		wait(
			pollUrl: string,
			token: string,
		): Promise<{ server: string; loginName: string; appPassword: string }>
	}
	/**
	 * For a host that opens `ngomate://join` links: calls back with each link, including one the app
	 * was started with. Returns a function that stops listening. Without it, invites are pasted.
	 */
	onInvite?(listener: (link: string) => void): () => void
}

/** A command from the host's own menus, such as the macOS menu bar. */
export type MenuCommand =
	| { type: 'new-conversation'; beside: boolean }
	| { type: 'close-tab' }
	| { type: 'attach' }
	| { type: 'show'; page: 'chat' | 'model' | 'addons' | 'memory' | 'team' }
	| { type: 'switch-team'; id: string }
	| { type: 'add-team' }
	| { type: 'copy-invite' }
	| { type: 'check-updates' }
	| { type: 'toggle-sidebar' }
	| { type: 'toggle-work' }
	| { type: 'find' }

/** What the host's menus show that only the interface knows. */
export type MenuState = {
	teams: { id: string; name: string | null }[]
	activeId: string | null
	canInvite: boolean
	/** So the View menu can say Show Sidebar or Hide Sidebar. */
	sidebarCollapsed: boolean
	/** And Show Your Work or Hide Your Work. */
	workCollapsed: boolean
}

/**
 * What a host app provides. The interface knows nothing about Tauri or any backend, so the same
 * components can sit in any window that fills this in.
 */
export interface NgomateHost {
	appName: string
	/** Image addresses of the app's mark for a light and a dark background, shown beside its name. */
	logo?: { light: string; dark: string }
	tasks: TaskFile[]
	memory: MemoryStore
	loadSettings(): Promise<Settings>
	saveSettings(settings: Settings): Promise<void>
	listConversations(): Promise<{ id: string; title: string; updatedAt: string }[]>
	readConversation(id: string): Promise<Conversation | null>
	writeConversation(conversation: Conversation): Promise<void>
	removeConversation(id: string): Promise<void>
	/** Null when the person cancels. */
	pickDocument(): Promise<PickedDocument | null>
	/** False when the person cancels. */
	saveDocument(suggestedName: string, text: string): Promise<boolean>
	/** For a server the person picks by address. */
	createModelClient(baseUrl: string, model: string, apiKey?: string): ModelClient
	connectAddon(addon: Addon): Promise<ToolSource>
	getSecret(name: string): Promise<string | null>
	setSecret(name: string, value: string): Promise<void>
	deleteSecret(name: string): Promise<void>
	models?: ModelHost
	team?: TeamHost
	/** For a host with menus of its own: their commands, and what to show in them. */
	menu?: {
		onCommand(listener: (command: MenuCommand) => void): () => void
		update(state: MenuState): void
	}
	/**
	 * For a host that can update itself: a newer version, or null when there is none. Nothing is
	 * installed until the person chooses to. A host that cannot update leaves this out.
	 */
	checkForUpdate?(): Promise<AvailableUpdate | null>
}
