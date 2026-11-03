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

/** Room for the conversation in a model's context, in characters. The rest is the system text and the answer. */
const HISTORY_CHARS = 30_000
const DOCUMENT_CHARS = 24_000

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
export function documentBlock(document: PickedDocument): { text: string; cut: boolean } {
	const cut = document.truncated || document.text.length > DOCUMENT_CHARS
	const body = document.text.slice(0, DOCUMENT_CHARS)
	const note = cut ? '\n[Only the first part of this document is included.]' : ''
	return { text: `Document "${document.name}":\n"""\n${body}\n"""${note}`, cut }
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
	getModel: () => Promise<ModelClient>
	/** Called after each change that should reach the conversation list. */
	onSaved: () => void
}

function connectTools(
	host: NgomateHost,
	addons: Addon[],
	onProblem: (name: string) => void,
): Promise<ToolSource> {
	return (async () => {
		const sources = [{ id: 'memory', source: createMemoryToolSource(host.memory) }]
		for (const addon of addons.filter((candidate) => candidate.enabled)) {
			try {
				const source = await host.connectAddon(addon)
				sources.push({
					id: addon.id,
					source: addon.allowDestructive
						? source
						: filterToolSource(source, (tool) => !isDestructiveTool(tool)),
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
			const input = [
				prompt?.text,
				text,
				...documents.map((document) => documentBlock(document).text),
			]
				.filter(Boolean)
				.join('\n\n')
			if (!input.trim()) return

			setBusy(true)
			setError(null)
			setProblems([])
			setStreaming('')
			setActivity(null)
			const controller = new AbortController()
			abort.current = controller

			let tools: ToolSource | null = null
			let written = ''
			const title = conversation.messages.length
				? conversation.title
				: makeTitle(prompt?.title ?? task?.title ?? text)
			const asked = [...conversation.messages, { role: 'user' as const, content: input }]
			try {
				// Saved before anything can fail, because the composer has already been cleared.
				await save({ ...conversation, title, updatedAt: new Date().toISOString(), messages: asked })

				const model = await depsRef.current.getModel()
				const seen = new Set<string>()
				tools = await connectTools(host, depsRef.current.settings.addons, (name) => {
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

				const memory = await buildMemoryContext(host.memory).catch(() => '')
				const context = [`Today is ${new Date().toISOString().slice(0, 10)}.`, memory]
					.filter(Boolean)
					.join('\n\n')
				const history: ChatMessage[] = fitHistory(conversation.messages, HISTORY_CHARS)

				const run = await runTask({
					model,
					tools,
					profile: task ? taskFileToProfile(task) : CHAT_PROFILE,
					input,
					context,
					history,
					confirmWrite,
					signal: controller.signal,
					onText: (piece) => {
						written += piece
						setStreaming((shown) => shown + piece)
					},
					onEvent: (event) => {
						if (event.type === 'tool_call') {
							// A new step starts, so what was shown belongs to the step before.
							written = ''
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
				await tools?.close().catch(() => {})
				setStreaming('')
				setActivity(null)
				setBusy(false)
				abort.current = null
			}
		},
		[conversation, host, save],
	)

	const stop = useCallback(() => abort.current?.abort(), [])

	return { conversation, streaming, busy, activity, error, problems, pendingWrite, send, stop }
}
