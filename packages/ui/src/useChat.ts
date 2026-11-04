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
		tools: Math.round(input * 0.25),
		output: Math.round(contextTokens / 4),
	}
}

const CHAT_PROFILE: TaskProfile = {
	id: 'chat',
	instructions:
		'You help the staff of a nonprofit organization with their back-office work. Use the tools only when ' +
		'they are needed. When writing from material the person gave you, use only the facts in it, and say what is missing.',
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

/** The document as text for the model. The person is told when only part of it could be read. */
export function documentBlock(
	document: PickedDocument,
	maxChars = textBudget().document,
): { text: string; cut: boolean } {
	const cut = document.truncated || document.text.length > maxChars
	const body = document.text.slice(0, maxChars)
	const note = cut ? '\n[Only the first part of this document is included.]' : ''
	return { text: `Document "${document.name}":\n"""\n${body}\n"""${note}`, cut }
}

/** One message from what the person gave, with the room for documents shared between them. */
function joinInput(
	promptText: string | undefined,
	text: string,
	documents: PickedDocument[],
	documentChars: number,
): string {
	const each = Math.floor(documentChars / Math.max(1, documents.length))
	return [promptText, text, ...documents.map((document) => documentBlock(document, each).text)]
		.filter(Boolean)
		.join('\n\n')
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
			const input = joinInput(prompt?.text, text, documents, textBudget().document)
			if (!input.trim()) return
			// Checked here and not left to the model, which may answer from memory with calls that do not exist.
			if (
				task?.needs === 'addon' &&
				!depsRef.current.settings.addons.some((addon) => addon.enabled)
			) {
				setError(
					`${task.title} needs a connected tool. Add one under Add-ons, such as a search service or Action Network Worldwide.`,
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
				: makeTitle(prompt?.title ?? task?.title ?? text)
			const asked = [...conversation.messages, { role: 'user' as const, content: input }]
			try {
				// Saved before anything can fail, because the composer has already been cleared.
				await save({ ...conversation, title, updatedAt: new Date().toISOString(), messages: asked })

				setStartingModel(true)
				const { client: model, contextTokens } = await depsRef.current
					.getModel()
					.finally(() => setStartingModel(false))
				const room = textBudget(contextTokens)
				setBudget(room)
				// What the person sees was cut before the model's size was known. This is cut to fit it.
				const fitted = joinInput(prompt?.text, text, documents, room.document)
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
				const history: ChatMessage[] = fitHistory(
					conversation.messages,
					Math.max(0, room.input - room.tools - fitted.length - context.length),
				)

				const run = await runTask({
					model,
					tools,
					profile: task ? taskFileToProfile(task) : CHAT_PROFILE,
					input: fitted,
					context,
					history,
					maxToolResultChars: room.toolResult,
					maxInputChars: room.input - room.tools,
					maxToolChars: room.tools,
					maxOutputTokens: room.output,
					confirmWrite,
					signal: controller.signal,
					onText: (piece) => {
						written += piece
						flushTimer ??= setTimeout(flush, 60)
					},
					onEvent: (event) => {
						if (event.type === 'tool_call') {
							// A new step starts, so what was shown belongs to the step before.
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
						cutOff: run.cutOff,
						toolsDidNotFit: run.toolsDidNotFit,
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
				})
			} catch (err) {
				setError(err instanceof Error ? err.message : String(err))
			} finally {
				if (flushTimer) clearTimeout(flushTimer)
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

	return {
		conversation,
		streaming,
		busy,
		activity,
		startingModel,
		documentLimit: budget.document,
		error,
		problems,
		pendingWrite,
		send,
		stop,
	}
}
