import type {
	ChatMessage,
	FigureProblem,
	MemoryStore,
	ModelClient,
	TaskFile,
	ToolSource,
} from '@ngomate/core'

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
	start(id: string): Promise<{ baseUrl: string; apiKey: string; contextTokens: number }>
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
}

export type PickedDocument = {
	name: string
	text: string
	/** The file had more than could be read. */
	truncated: boolean
}

/**
 * What a host app provides. The interface knows nothing about Tauri or any backend, so the same
 * components can sit in any window that fills this in.
 */
export interface NgomateHost {
	appName: string
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
}
