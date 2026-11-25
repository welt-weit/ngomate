import {
	type ChatMessage,
	type ConfirmWrite,
	type ModelClient,
	TEAM_TOOLS,
	type TaskFile,
	type TaskProfile,
	type TaskRun,
	type TeamNotes,
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
import {
	type Draft,
	type MakingContext,
	draftToolName,
	draftToolSource,
	makingInstructions,
	parseDraft,
} from './drafts.js'
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
	// Facts about the organization stay limited to its material; general knowledge and writing do not,
	// or a small model refuses to say what the capital of France is once unrelated passages are in view.
	instructions:
		'You help the staff of a nonprofit organization with their back-office work. Use the tools only when ' +
		'they are needed. Search the knowledge base for questions about how others have done this kind of ' +
		'work or what is known in the field, not for writing, translating, lists, general knowledge or small talk. ' +
		'Questions about you, the services you are connected to or what you can do, answer from what you are told ' +
		'here, without a tool. ' +
		'For facts about the organization, its people, funders, deadlines and amounts, use only material the ' +
		'person gave you or a tool returned, and if they are not in it, say so. General knowledge and writing ' +
		'you may give yourself, without presenting them as coming from a tool.',
	readTools: [],
	writeTools: [],
	allTools: true,
}

const STOPPED: Partial<Record<TaskRun['status'], string>> = {
	stuck: 'Stopped because its tool calls kept failing.',
	call_limit: 'Stopped at the limit on tool calls for one request.',
	max_turns: 'Stopped because the request took too many steps.',
}

/**
 * Which services the model can reach, by name. Without it, "are you connected to X?" has no answer but
 * a search, and a search for that finds field passages that have nothing to do with it.
 */
export function connectedServices(addons: { name: string; enabled: boolean }[]): string {
	const names = addons
		.filter((addon) => addon.enabled)
		.map((addon) => addon.name.trim())
		.filter(Boolean)
	return names.length
		? `You are connected to these services through their tools: ${names.join(', ')}.`
		: ''
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
	/** Said to the model beside the date and the notes, such as when a job last ran. */
	context?: string
	/**
	 * For a chat where a task or job is being made: what it may be drafted from. Taken only while the
	 * conversation has a draft not yet saved; the model then gets the draft tool and nothing else.
	 */
	making?: MakingContext
}

export type PendingWrite = WriteRequest & {
	resolve: (answer: boolean | { choice: string }) => void
}

export type ChatDeps = {
	host: NgomateHost
	settings: Settings
	getModel: () => Promise<{
		client: ModelClient
		contextTokens?: number
		/** Search a connected knowledge base before every chat message, not when the model asks. */
		searchKnowledgeFirst?: boolean
	}>
	/** Called after each change that should reach the conversation list. */
	onSaved: () => void
	/** A request started or ended, so a host can tell when a model is idle. */
	onBusyChange?: (busy: boolean) => void
	/**
	 * The person's team, when they are in one: its notes beside their own, and its tasks. `addonId` is
	 * the connector that holds them, if one does: its team tools are reached through memory only.
	 */
	team?: { notes: TeamNotes; tasks: TaskFile[]; addonId?: string }
}

const TEAM_TOOL_NAMES = new Set<string>(Object.values(TEAM_TOOLS))

function connectTools(
	host: NgomateHost,
	addons: Addon[],
	withMemory: boolean,
	onProblem: (name: string) => void,
	team?: { notes: TeamNotes; addonId?: string },
): Promise<ToolSource> {
	return (async () => {
		const sources = withMemory
			? [{ id: 'memory', source: createMemoryToolSource(host.memory, team?.notes) }]
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
							(addon.allowDestructive || !isDestructiveTool(tool)) &&
							// Saved through the memory tools, where the person picks; never written around them.
							!(addon.id === team?.addonId && TEAM_TOOL_NAMES.has(tool.name)),
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

/**
 * Makes one change a job asked for, once the person allows it: through the same connectors and the
 * same tool the run would have used. A tool turned off or removed since is not reached.
 */
export async function makeChange(
	deps: ChatDeps,
	change: { tool: string; args: Record<string, unknown> },
): Promise<void> {
	const tools = await connectTools(deps.host, deps.settings.addons, false, () => {}, deps.team)
	try {
		const offered = await tools.listTools()
		if (!offered.some((tool) => tool.name === change.tool))
			throw new Error(`No connector offers ${change.tool} now.`)
		const result = await tools.callTool(change.tool, change.args)
		if (result.isError) throw new Error(result.text || `${change.tool} did not work.`)
	} finally {
		await tools.close().catch(() => {})
	}
}

/**
 * Why a ready-made task cannot run, when it needs a connector and none is on. Checked before the model
 * is asked, which may otherwise answer from memory with calls that do not exist.
 */
export function missingConnector(deps: ChatDeps, task: TaskFile | undefined): string | null {
	if (task?.needs !== 'addon' || deps.settings.addons.some((addon) => addon.enabled)) return null
	return `${task.title} needs a connected tool. Add one under Connectors, such as a search service or Action Network Worldwide.`
}

/** What happens while an answer is written, for a window showing it. All optional but the first three. */
export type AnswerHooks = {
	signal: AbortSignal
	/** Asked before anything is changed. A run nobody is watching refuses and records what was asked. */
	confirmWrite: ConfirmWrite
	/** The conversation as it stands, kept before the model is asked and again with its answer. */
	save: (conversation: Conversation) => Promise<void>
	onStartingModel?: (starting: boolean) => void
	onBudget?: (room: ReturnType<typeof textBudget>) => void
	onReadingDocument?: (reading: boolean) => void
	/** A connector that could not be reached, once per name. */
	onProblem?: (name: string) => void
	/** Each piece of the answer as it is written. */
	onText?: (piece: string) => void
	/** A tool is called: what was written so far belonged to the step before. */
	onToolCall?: (tool: string) => void
	onTurn?: () => void
}

export type AnswerResult = {
	conversation: Conversation
	/** Shown instead of, or beside, an answer. */
	error: string | null
	/** The answer and what the checks found, when there is one. */
	answer: string | null
	notice: AnswerNotice | null
}

/**
 * Sends one message and keeps the conversation with its answer: the chat in a window and a job no one
 * is watching go through this same path, so both get the same material, limits and checks.
 */
export async function answerRequest(
	deps: ChatDeps,
	current: Conversation,
	text: string,
	options: SendOptions,
	hooks: AnswerHooks,
): Promise<AnswerResult> {
	const { host } = deps
	// A chat making a task or job talks about that alone: no ready-made task, no connectors, no notes.
	const making = current.draft && !current.draft.saved ? options.making : undefined
	let draft: Draft | undefined = current.draft
	const { documents = [], prompt } = options
	const task = making ? undefined : options.task
	const request = [prompt?.text, text].filter(Boolean).join('\n\n')
	const named = documents.length
		? `[Attached: ${documents.map((document) => document.name).join(', ')}]`
		: ''
	// What is kept and shown. The documents themselves go with each message, as far as it needs them.
	const input = [request, named].filter(Boolean).join('\n\n')
	// The same file attached twice would only divide the room between two copies.
	const allDocuments = [...(current.documents ?? []), ...documents].filter(
		(document, index, all) =>
			all.findIndex((other) => other.name === document.name && other.text === document.text) ===
			index,
	)
	const nothing = { conversation: current, answer: null, notice: null }
	if (!input.trim()) return { ...nothing, error: null }
	const missing = missingConnector(deps, task)
	if (missing) return { ...nothing, error: missing }

	let tools: ToolSource | null = null
	let written = ''
	// Where the wait went, kept with the answer so slow answers can be looked into.
	const sentAt = performance.now()
	const waited = { startMs: 0, firstWordMs: null as number | null }
	// A hidden window may be slowed down by the computer, which would look like a slow answer.
	const hidden = { ms: 0, since: document.hidden ? sentAt : (null as number | null) }
	const onVisibility = () => {
		if (document.hidden) hidden.since ??= performance.now()
		else if (hidden.since !== null) {
			hidden.ms += performance.now() - hidden.since
			hidden.since = null
		}
	}
	document.addEventListener('visibilitychange', onVisibility)
	const hiddenMs = () =>
		Math.round(hidden.ms + (hidden.since === null ? 0 : performance.now() - hidden.since))
	const title = current.messages.length
		? current.title
		: makeTitle(prompt?.title ?? task?.title ?? (text || documents[0]?.name || ''))
	const asked = [...current.messages, { role: 'user' as const, content: input }]
	const times = { ...current.times, [current.messages.length]: new Date().toISOString() }
	const tasks = task ? { ...current.tasks, [current.messages.length]: task.id } : current.tasks
	let latest: Conversation = current
	// One save after another, so a draft saved while the answer is written never lands after the answer.
	let saving: Promise<void> = Promise.resolve()
	const keep = (next: Conversation) => {
		latest = next
		saving = saving.catch(() => {}).then(() => hooks.save(next))
		return saving
	}
	const makingProfile =
		making && draft
			? {
					id: `make-${draft.kind}`,
					instructions: makingInstructions(draft, making),
					readTools: [draftToolName(draft.kind)],
					writeTools: [],
					instructionsInRequest: true,
				}
			: null
	try {
		// Saved before anything can fail, because the composer has already been cleared.
		await keep({
			...current,
			title,
			updatedAt: new Date().toISOString(),
			messages: asked,
			times,
			tasks,
			documents: allDocuments,
		})

		hooks.onStartingModel?.(true)
		const {
			client: model,
			contextTokens,
			searchKnowledgeFirst,
		} = await deps.getModel().finally(() => hooks.onStartingModel?.(false))
		waited.startMs = Math.round(performance.now() - sentAt)
		const room = textBudget(contextTokens)
		hooks.onBudget?.(room)
		// A draft needs every fact it can get. A question needs the passages that answer it.
		const share = task?.tools === 'none' ? 1 : QUESTION_SHARE
		const each = Math.floor((room.document * share) / Math.max(1, allDocuments.length))
		const blocks = allDocuments.map((document) => ({
			name: document.name,
			...documentBlock(document, passageQuery(request, current.messages), each),
			truncated: document.truncated,
		}))
		const attachments = blocks.map((block) => block.text).join('\n\n')
		const seen = new Set<string>()
		// A ready-made task gets notes as context, not as tools that distract a small model from the job.
		const team = deps.team
		tools = making
			? draftToolSource(
					making,
					() => draft ?? { kind: 'task', task: {}, job: {} },
					(next) => {
						draft = next
						// Shown at once, so the card fills in while the answer is still being written.
						keep({ ...latest, draft: next }).catch((err) =>
							console.error('The draft could not be kept:', err),
						)
					},
				)
			: await connectTools(
					host,
					deps.settings.addons,
					!task,
					(name) => {
						if (!seen.has(name)) hooks.onProblem?.(name)
						seen.add(name)
					},
					team,
				)

		const memory = making
			? ''
			: await buildMemoryContext(
					host.memory,
					room.memory,
					team ? { notes: team.notes, question: passageQuery(text, current.messages) } : undefined,
				).catch(() => '')
		const context = [
			`Today is ${new Date().toISOString().slice(0, 10)}.`,
			making ? '' : connectedServices(deps.settings.addons),
			options.context ?? '',
			memory,
		]
			.filter(Boolean)
			.join('\n\n')
		// Open chat only: a ready-made task has its own material and every token spoken for. The model
		// decides whether to search: passages found for "thanks" or "draft an email" pull a small model's
		// answer off course, and a knowledge base of field practice has nothing for them anyway. A model
		// that seldom asks, or answers without reading what a search it asked for found, is searched for.
		const knowledge =
			!task && !making && text.trim() && deps.settings.addons.some((addon) => addon.enabled)
				? {
						query: passageQuery(text, current.messages),
						maxChars: room.knowledge,
						onRequest: !searchKnowledgeFirst,
					}
				: undefined
		const history: ChatMessage[] = fitHistory(
			current.messages,
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
		hooks.onReadingDocument?.(allDocuments.length > 0)
		const run = await runTask({
			model,
			tools,
			profile: makingProfile ?? (task ? taskFileToProfile(task) : CHAT_PROFILE),
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
			confirmWrite: hooks.confirmWrite,
			signal: hooks.signal,
			onText: (piece) => {
				waited.firstWordMs ??= Math.round(performance.now() - sentAt)
				hooks.onReadingDocument?.(false)
				written += piece
				hooks.onText?.(piece)
			},
			onEvent: (event) => {
				if (event.type === 'tool_call') {
					// A new step starts, so what was shown belongs to the step before.
					hooks.onReadingDocument?.(false)
					written = ''
					hooks.onToolCall?.(event.tool)
				}
				if (event.type === 'turn') hooks.onTurn?.()
			},
		})

		let error = run.status === 'model_error' ? (run.error ?? 'The model did not answer.') : null

		// Older messages were left out of what the model saw, but stay in what is kept.
		const earlier = current.messages.slice(0, current.messages.length - history.length)
		const messages = [...earlier, ...run.messages]
		// Stopping keeps what was already written: it may be all the person wanted.
		if (run.status === 'cancelled' && written.trim())
			messages.push({ role: 'assistant', content: written })
		const notices = { ...current.notices }
		let notice: AnswerNotice | null = null
		if (run.answer) {
			notice = {
				unsourcedDates: run.unsourcedDates,
				unsourcedLinks: run.unsourcedLinks,
				checkFigures: Boolean(task) && task?.tools === 'none',
				figureProblems: run.figureProblems,
				stopped: STOPPED[run.status] ?? null,
				earlierLeftOut: history.length < current.messages.length,
				partlyRead: blocks.filter((block) => block.cut).map((block) => block.name),
				neverRead: blocks.filter((block) => block.truncated).map((block) => block.name),
				cutOff: run.cutOff,
				toolsDidNotFit: run.toolsDidNotFit,
				knowledgeEntries: run.knowledgeEntries,
				knowledgeUnavailable: run.knowledgeUnavailable,
				timing: {
					...waited,
					totalMs: Math.round(performance.now() - sentAt),
					knowledgeMs: run.knowledgeMs,
					toolMs: run.toolMs,
					toolCalls: run.toolCalls,
					modelCalls: run.modelCalls,
					hiddenMs: hiddenMs(),
				},
			}
			notices[messages.length - 1] = notice
			times[messages.length - 1] = new Date().toISOString()
		} else if (STOPPED[run.status]) {
			error = STOPPED[run.status] ?? null
		}
		await keep({
			...current,
			title,
			updatedAt: new Date().toISOString(),
			messages,
			notices,
			times,
			tasks,
			documents: allDocuments,
			...(draft ? { draft } : {}),
		})
		return { conversation: latest, error, answer: run.answer ?? null, notice }
	} catch (err) {
		return {
			conversation: latest,
			error: err instanceof Error ? err.message : String(err),
			answer: null,
			notice: null,
		}
	} finally {
		document.removeEventListener('visibilitychange', onVisibility)
		hooks.onReadingDocument?.(false)
		await tools?.close().catch(() => {})
	}
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
	// The stored conversation has been read: before that, nothing may be saved over it.
	const [loaded, setLoaded] = useState(false)
	// The newest conversation, for changes made after an await, which a render's copy may predate.
	const conversationRef = useRef(conversation)

	useEffect(() => {
		let current = true
		setLoaded(false)
		setError(null)
		setProblems([])
		setStreaming('')
		host.readConversation(conversationId).then(
			(stored) => {
				if (!current) return
				const draft = parseDraft(stored?.draft)
				const { draft: _stored, ...rest } = stored ?? newConversation(conversationId)
				const read = draft ? { ...rest, draft } : rest
				conversationRef.current = read
				setConversation(read)
				setLoaded(true)
			},
			// Never counted as read: anything saved now would replace the stored chat with an empty one.
			(err) => {
				if (current)
					setError(
						`This chat could not be read: ${err instanceof Error ? err.message : String(err)}`,
					)
			},
		)
		return () => {
			current = false
			abort.current?.abort()
		}
	}, [host, conversationId])

	const save = useCallback(
		async (next: Conversation) => {
			conversationRef.current = next
			setConversation(next)
			await host.writeConversation(next)
			depsRef.current.onSaved()
		},
		[host],
	)

	const send = useCallback(
		async (text: string, options: SendOptions = {}, from?: Conversation) => {
			// Retry starts from the conversation without its last question, which this render has not seen yet.
			const current = from ?? conversation
			// Before the stored chat is read, anything saved would replace it with this empty one.
			if (!loaded) return setError('This chat is not read yet. Wait a moment and send again.')
			if (!text.trim() && !options.prompt?.text?.trim() && !options.documents?.length) return
			// Said before anything starts, as it always was: nothing is sent, so nothing is busy.
			const missing = missingConnector(depsRef.current, options.task)
			if (missing) return setError(missing)
			setBusy(true)
			depsRef.current.onBusyChange?.(true)
			setError(null)
			setProblems([])
			setStreaming('')
			setActivity(null)
			const controller = new AbortController()
			abort.current = controller

			let written = ''
			// Shown in batches: every small piece redrawing the page is too much for a slow computer.
			let flushTimer: ReturnType<typeof setTimeout> | null = null
			const flush = () => {
				flushTimer = null
				setStreaming(written)
			}
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
			try {
				const result = await answerRequest(depsRef.current, current, text, options, {
					signal: controller.signal,
					confirmWrite,
					save,
					onStartingModel: setStartingModel,
					onBudget: setBudget,
					onReadingDocument: setReadingDocument,
					onProblem: (name) => setProblems((known) => [...known, name]),
					onText: (piece) => {
						written += piece
						flushTimer ??= setTimeout(flush, 60)
					},
					onToolCall: (tool) => {
						written = ''
						if (flushTimer) clearTimeout(flushTimer)
						flushTimer = null
						setStreaming('')
						setActivity(tool)
					},
					onTurn: () => setActivity(null),
				})
				if (result.error) setError(result.error)
			} finally {
				if (flushTimer) clearTimeout(flushTimer)
				depsRef.current.onBusyChange?.(false)
				setStreaming('')
				setActivity(null)
				setBusy(false)
				abort.current = null
			}
		},
		[conversation, save, loaded],
	)

	const stop = useCallback(() => abort.current?.abort(), [])

	/**
	 * Sends the last question again, in place of its answer, or of the answer it never got, through the
	 * ready-made task it was asked through. One this app no longer has, or one asked before tasks were
	 * kept, goes as a plain message.
	 */
	const retry = useCallback(
		(making?: MakingContext) => {
			const at = conversation.messages.findLastIndex((message) => message.role === 'user')
			const question = conversation.messages[at]
			if (at < 0 || !question?.content) return
			const before = <T>(record: Record<number, T> = {}) =>
				Object.fromEntries(Object.entries(record).filter(([index]) => Number(index) < at))
			const taskId = conversation.tasks?.[at]
			const task = taskId
				? [...host.tasks, ...(depsRef.current.team?.tasks ?? [])].find(
						(known) => known.id === taskId,
					)
				: undefined
			// A chat making something is retried making it: never with the connectors and notes of a chat.
			return send(
				question.content,
				{ task, making },
				{
					...conversation,
					messages: conversation.messages.slice(0, at),
					notices: before(conversation.notices),
					times: before(conversation.times),
					tasks: before(conversation.tasks),
				},
			)
		},
		[conversation, host, send],
	)

	/** The conversation as it is now, past any render. */
	const latest = useCallback(() => conversationRef.current, [])

	/** Sets the task or job this chat is making, or clears it; a saved one names the chat after it. */
	const updateDraft = useCallback(
		(draft: Draft | undefined, title?: string) => {
			const { draft: _old, ...rest } = conversationRef.current
			return save({ ...rest, ...(draft ? { draft } : {}), ...(title ? { title } : {}) })
		},
		[save],
	)

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
		retry,
		stop,
		removeDocument,
		updateDraft,
		loaded,
		latest,
	}
}
