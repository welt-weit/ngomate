import {
	type ChatMessage,
	type ConfirmWrite,
	type ModelClient,
	type TaskFile,
	type TaskProfile,
	type TaskRun,
	type ToolSource,
	type WriteRequest,
	buildMemoryContext,
	combineToolSources,
	createMemoryToolSource,
	filterToolSource,
	fitHistory,
	isDestructiveTool,
	readDocument,
	runTask,
	taskFileToProfile,
} from '@ngomate/core'
import { useCallback, useEffect, useRef, useState } from 'react'
import type {
	Addon,
	AnswerNotice,
	Conversation,
	NgomateHost,
	PickedDocument,
	Settings,
} from './host.js'

/** For a server the person runs, whose size is unknown. */
const UNKNOWN_CONTEXT_TOKENS = 8192

/**
 * How much text fits a model, in characters: about 3 to a token, with a quarter of the room kept for the
 * answer. It decides what is cut, so a small computer gets a shorter read rather than a failed request.
 */
export function textBudget(contextTokens: number = UNKNOWN_CONTEXT_TOKENS) {
	const input = Math.round(contextTokens * 3 * 0.75)
	return {
		input,
		document: Math.round(input * 0.6),
		memory: Math.round(input * 0.1),
		toolResult: Math.round(input * 0.25),
		knowledge: Math.round(input * 0.15),
		tools: Math.round(input * 0.25),
		output: Math.round(contextTokens / 4),
	}
}

const CHAT_PROFILE: TaskProfile = {
	id: 'chat',
	instructions:
		'You help the staff of a nonprofit organization with their back-office work. Use the tools only when ' +
		'they are needed. Use only the facts in material the person gave you or a tool returned. If what they asked is not in it, say so.',
	readTools: [],
	writeTools: [],
	allTools: true,
}

const STOPPED: Partial<Record<TaskRun['status'], string>> = {
	stuck: 'Stopped because its tool calls kept failing.',
	call_limit: 'Stopped at the limit on tool calls for one request.',
	max_turns: 'Stopped because the request took too many steps.',
}

export function makeTitle(text: string): string {
	const line = text.split('\n')[0]?.trim() ?? ''
	return line.length > 60 ? `${line.slice(0, 57)}…` : line || 'New conversation'
}

/** For a question, the matching passages are enough: more costs time and tokens and did not answer better. */
const QUESTION_SHARE = 0.3

/** One document as the model gets it for this request, and whether part of it was left out. */
export function documentBlock(
	document: PickedDocument,
	request: string,
	maxChars = textBudget().document,
): { text: string; cut: boolean } {
	const read = readDocument(document.text, request, maxChars)
	const cut = document.truncated || read.mode !== 'whole'
	const notes = {
		whole: '',
		relevant:
			'[Only the passages closest to the request are included. There is more in the document.]',
		overview: '[Only the opening of each part is included. There is more in the document.]',
	}
	const note = [
		notes[read.mode],
		document.truncated ? '[The end of this file could not be read at all.]' : '',
	]
		.filter(Boolean)
		.join(' ')
	return { text: `Document "${document.name}":\n"""\n${read.text}\n"""\n${note}`.trim(), cut }
}

/** A short follow-up like "and why?" is about what was just discussed, so that helps choose the passages. */
function passageQuery(request: string, messages: ChatMessage[]): string {
	if (request.trim().split(/\s+/).length >= 4) return request
	const previous = [...messages].reverse().find((message) => message.role === 'user')
	// A file's name is no help in finding a passage, and this also goes to a connected knowledge base.
	return `${request} ${previous?.content?.replace(/\n*\[Attached: .*\]$/, '') ?? ''}`
}

export function newConversation(id: string): Conversation {
	return {
		id,
		title: 'New conversation',
		updatedAt: new Date().toISOString(),
		messages: [],
		notices: {},
	}
}

export type SendOptions = {
	task?: TaskFile
	documents?: PickedDocument[]
	prompt?: { title: string; text: string }
}

export type PendingWrite = WriteRequest & { resolve: (approved: boolean) => void }

export type ChatDeps = {
	host: NgomateHost
	settings: Settings
	getModel: () => Promise<{ client: ModelClient; contextTokens?: number }>
	/** Called after each change that should reach the conversation list. */
	onSaved: () => void
	/** A request started or ended, so a host can tell when a model is idle. */
	onBusyChange?: (busy: boolean) => void
}

function connectTools(
	host: NgomateHost,
	addons: Addon[],
	withMemory: boolean,
	onProblem: (name: string) => void,
): Promise<ToolSource> {
	return (async () => {
		const sources = withMemory
			? [{ id: 'memory', source: createMemoryToolSource(host.memory) }]
			: []
		for (const addon of addons.filter((candidate) => candidate.enabled)) {
			try {
				const source = await host.connectAddon(addon)
				sources.push({
					id: addon.id,
					source: filterToolSource(
						source,
						(tool) =>
							!addon.disabledTools?.includes(tool.name) &&
							(addon.allowDestructive || !isDestructiveTool(tool)),
					),
				})
			} catch {
				onProblem(addon.name)
			}
		}
		return combineToolSources(sources, {
			onSourceError: (id) => onProblem(addons.find((addon) => addon.id === id)?.name ?? id),
		})
	})()
}

export function useChat(deps: ChatDeps, conversationId: string) {
	const { host } = deps
	const depsRef = useRef(deps)
	depsRef.current = deps

	const [conversation, setConversation] = useState<Conversation>(() =>
		newConversation(conversationId),
	)
	const [streaming, setStreaming] = useState('')
	const [busy, setBusy] = useState(false)
	const [activity, setActivity] = useState<string | null>(null)
	const [error, setError] = useState<string | null>(null)
	const [problems, setProblems] = useState<string[]>([])
	const [pendingWrite, setPendingWrite] = useState<PendingWrite | null>(null)
	const [startingModel, setStartingModel] = useState(false)
	const [readingDocument, setReadingDocument] = useState(false)
	const [budget, setBudget] = useState(() => textBudget())
	const abort = useRef<AbortController | null>(null)

	useEffect(() => {
		let current = true
		setError(null)
		setProblems([])
		setStreaming('')
		host.readConversation(conversationId).then((stored) => {
			if (current) setConversation(stored ?? newConversation(conversationId))
		})
		return () => {
			current = false
			abort.current?.abort()
		}
	}, [host, conversationId])

	const save = useCallback(
		async (next: Conversation) => {
			setConversation(next)
			await host.writeConversation(next)
			depsRef.current.onSaved()
		},
		[host],
	)

	const send = useCallback(
		async (text: string, options: SendOptions = {}) => {
			const { task, documents = [], prompt } = options
			const request = [prompt?.text, text].filter(Boolean).join('\n\n')
			const named = documents.length
				? `[Attached: ${documents.map((document) => document.name).join(', ')}]`
				: ''
			// What is kept and shown. The documents themselves go with each message, as far as it needs them.
			const input = [request, named].filter(Boolean).join('\n\n')
			// The same file attached twice would only divide the room between two copies.
			const allDocuments = [...(conversation.documents ?? []), ...documents].filter(
				(document, index, all) =>
					all.findIndex((other) => other.name === document.name && other.text === document.text) ===
					index,
			)
			if (!input.trim()) return
			// Checked here and not left to the model, which may answer from memory with calls that do not exist.
			if (
				task?.needs === 'addon' &&
				!depsRef.current.settings.addons.some((addon) => addon.enabled)
			) {
				setError(
					`${task.title} needs a connected tool. Add one under Connectors, such as a search service or Action Network Worldwide.`,
				)
				return
			}

			setBusy(true)
			depsRef.current.onBusyChange?.(true)
			setError(null)
			setProblems([])
			setStreaming('')
			setActivity(null)
			const controller = new AbortController()
			abort.current = controller

			let tools: ToolSource | null = null
			let written = ''
			// Shown in batches: every small piece redrawing the page is too much for a slow computer.
			let flushTimer: ReturnType<typeof setTimeout> | null = null
			const flush = () => {
				flushTimer = null
				setStreaming(written)
			}
			const title = conversation.messages.length
				? conversation.title
				: makeTitle(prompt?.title ?? task?.title ?? (text || documents[0]?.name || ''))
			const asked = [...conversation.messages, { role: 'user' as const, content: input }]
			try {
				// Saved before anything can fail, because the composer has already been cleared.
				await save({
					...conversation,
					title,
					updatedAt: new Date().toISOString(),
					messages: asked,
					documents: allDocuments,
				})

				setStartingModel(true)
				const { client: model, contextTokens } = await depsRef.current
					.getModel()
					.finally(() => setStartingModel(false))
				const room = textBudget(contextTokens)
				setBudget(room)
				// A draft needs every fact it can get. A question needs the passages that answer it.
				const share = task?.tools === 'none' ? 1 : QUESTION_SHARE
				const each = Math.floor((room.document * share) / Math.max(1, allDocuments.length))
				const blocks = allDocuments.map((document) => ({
					name: document.name,
					...documentBlock(document, passageQuery(request, conversation.messages), each),
					truncated: document.truncated,
				}))
				const attachments = blocks.map((block) => block.text).join('\n\n')
				const seen = new Set<string>()
				// A ready-made task gets notes as context, not as tools that distract a small model from the job.
				tools = await connectTools(host, depsRef.current.settings.addons, !task, (name) => {
					if (!seen.has(name)) setProblems((known) => [...known, name])
					seen.add(name)
				})
				const confirmWrite: ConfirmWrite = (request) =>
					new Promise((resolve) => {
						const onAbort = () => {
							setPendingWrite(null)
							resolve(false)
						}
						controller.signal.addEventListener('abort', onAbort, { once: true })
						setPendingWrite({
							...request,
							resolve: (approved) => {
								controller.signal.removeEventListener('abort', onAbort)
								setPendingWrite(null)
								resolve(approved)
							},
						})
					})

				const memory = await buildMemoryContext(host.memory, room.memory).catch(() => '')
				const context = [`Today is ${new Date().toISOString().slice(0, 10)}.`, memory]
					.filter(Boolean)
					.join('\n\n')
				// Open chat only: a ready-made task has its own material and every token spoken for.
				const knowledge =
					!task && text.trim() && depsRef.current.settings.addons.some((addon) => addon.enabled)
						? { query: passageQuery(text, conversation.messages), maxChars: room.knowledge }
						: undefined
				const history: ChatMessage[] = fitHistory(
					conversation.messages,
					Math.max(
						0,
						room.input -
							room.tools -
							input.length -
							attachments.length -
							context.length -
							(knowledge?.maxChars ?? 0),
					),
				)

				// Nothing appears until the model has read it, which on a long document is most of the wait.
				setReadingDocument(allDocuments.length > 0)
				const run = await runTask({
					model,
					tools,
					profile: task ? taskFileToProfile(task) : CHAT_PROFILE,
					input,
					attachments,
					knowledge,
					sourceTexts: allDocuments.map((document) => document.text),
					context,
					history,
					maxToolResultChars: room.toolResult,
					maxInputChars: room.input - room.tools,
					maxToolChars: room.tools,
					maxOutputTokens: room.output,
					confirmWrite,
					signal: controller.signal,
					onText: (piece) => {
						setReadingDocument(false)
						written += piece
						flushTimer ??= setTimeout(flush, 60)
					},
					onEvent: (event) => {
						if (event.type === 'tool_call') {
							// A new step starts, so what was shown belongs to the step before.
							setReadingDocument(false)
							written = ''
							if (flushTimer) clearTimeout(flushTimer)
							flushTimer = null
							setStreaming('')
							setActivity(event.tool)
						}
						if (event.type === 'turn') setActivity(null)
					},
				})

				if (run.status === 'model_error') setError(run.error ?? 'The model did not answer.')

				// Older messages were left out of what the model saw, but stay in what is kept.
				const earlier = conversation.messages.slice(
					0,
					conversation.messages.length - history.length,
				)
				const messages = [...earlier, ...run.messages]
				// Stopping keeps what was already written: it may be all the person wanted.
				if (run.status === 'cancelled' && written.trim())
					messages.push({ role: 'assistant', content: written })
				const notices = { ...conversation.notices }
				if (run.answer) {
					const notice: AnswerNotice = {
						unsourcedDates: run.unsourcedDates,
						unsourcedLinks: run.unsourcedLinks,
						checkFigures: Boolean(task) && task?.tools === 'none',
						stopped: STOPPED[run.status] ?? null,
						earlierLeftOut: history.length < conversation.messages.length,
						partlyRead: blocks.filter((block) => block.cut).map((block) => block.name),
						neverRead: blocks.filter((block) => block.truncated).map((block) => block.name),
						cutOff: run.cutOff,
						toolsDidNotFit: run.toolsDidNotFit,
						knowledgeEntries: run.knowledgeEntries,
						knowledgeUnavailable: run.knowledgeUnavailable,
					}
					notices[messages.length - 1] = notice
				} else if (STOPPED[run.status]) {
					setError(STOPPED[run.status] ?? null)
				}
				await save({
					...conversation,
					title,
					updatedAt: new Date().toISOString(),
					messages,
					notices,
					documents: allDocuments,
				})
			} catch (err) {
				setError(err instanceof Error ? err.message : String(err))
			} finally {
				if (flushTimer) clearTimeout(flushTimer)
				setReadingDocument(false)
				await tools?.close().catch(() => {})
				depsRef.current.onBusyChange?.(false)
				setStreaming('')
				setActivity(null)
				setBusy(false)
				abort.current = null
			}
		},
		[conversation, host, save],
	)

	const stop = useCallback(() => abort.current?.abort(), [])

	/** Takes a document out of the conversation, so it is not sent with any later message. */
	const removeDocument = useCallback(
		(index: number) =>
			save({
				...conversation,
				documents: conversation.documents?.filter((_, at) => at !== index),
			}),
		[conversation, save],
	)

	return {
		conversation,
		streaming,
		busy,
		activity,
		startingModel,
		readingDocument,
		documentLimit: budget.document,
		error,
		problems,
		pendingWrite,
		send,
		stop,
		removeDocument,
	}
}
