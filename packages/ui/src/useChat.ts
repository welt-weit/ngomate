import {
	type CallContext,
	type ChatMessage,
	type ConfirmWrite,
	DATA_CLASSES,
	type DataClass,
	type ModelClient,
	type PolicyFile,
	SAVE_NOTE_TOOL,
	TEAM_TOOLS,
	type TaskFile,
	type TaskProfile,
	type TaskRun,
	type TeamNotes,
	type ToolDefinition,
	type ToolSource,
	type WriteRequest,
	buildMemoryContext,
	combineToolSources,
	createMemoryToolSource,
	filterToolSource,
	fitHistory,
	isDestructiveTool,
	mostSensitive,
	reachesTeamNotes,
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
	PolicyNotice,
	Settings,
} from './host.js'
import {
	CONNECTOR_REFUSED,
	type PolicyRecordEntry,
	connectorMayAnswer,
	documentClass,
	effectivePolicy,
	labelled,
	mayCallConnector,
	modelApproved,
	onThisComputer,
	ownPolicy,
	planLeaving,
	policyNotice,
	recordPolicy,
	reviewCovers,
	widerReview,
} from './policyCheck.js'
import {
	type Identifier,
	type StandIn,
	addStandIns,
	findIdentifiers,
	putBackArgs,
	standIn,
	withStandIns,
} from './standIns.js'

/** The text with stand-ins for what the conversation swaps, or as it is when it swaps nothing. */
const standInsOr = (text: string, table: StandIn[]) => (table.length ? standIn(text, table) : text)
import { countForTeam } from './teamCounts.js'

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
	/** Tools offered whatever the request says, such as a job's fixed send tool. */
	offerTools?: string[]
	/** What is asking, for the AI-use policy's record of use. A chat or a task when left out. */
	feature?: 'job'
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
	team?: { notes: TeamNotes; tasks: TaskFile[]; addonId?: string; id?: string; policy?: PolicyFile }
	/**
	 * The model on this computer, for a conversation the AI-use policy keeps here while a model server is
	 * chosen. Null when none is downloaded.
	 */
	/** This computer's random id for its counts in the team's storage, made when first asked for. */
	countsId?: () => string
	/** The AI-use policy an organisation set for this computer: a ceiling nothing in the app changes. */
	managedPolicy?: PolicyFile
	getLocalModel?: () => Promise<{
		client: ModelClient
		contextTokens?: number
		searchKnowledgeFirst?: boolean
		/** Its name, said under an answer it gave instead of the model server. */
		name?: string
	} | null>
}

const TEAM_TOOL_NAMES = new Set<string>(Object.values(TEAM_TOOLS))

type PrepareCall = (
	name: string,
	args: Record<string, unknown>,
	context?: CallContext,
) => Record<string, unknown>

/** What a conversation holds before an answer: what it held, its documents, and the notes it reads. */
export function heldBefore(
	deps: ChatDeps,
	read: { earlier?: DataClass[]; documents: PickedDocument[]; notesRead: boolean },
): DataClass[] {
	const labels = deps.settings.labels
	const held = new Set<DataClass>(read.earlier ?? [])
	for (const document of read.documents) held.add(documentClass(document, labels))
	if (read.notesRead) {
		held.add(labelled(labels?.notes))
		if (deps.team) held.add(labelled(deps.team.id ? labels?.teams?.[deps.team.id] : undefined))
	}
	return DATA_CLASSES.filter((each) => held.has(each))
}

/** The labels of the connectors an answer called, for what their results brought in. */
const connectorClasses = (deps: ChatDeps, used: Iterable<string>) =>
	[...used]
		.filter((id) => id !== 'memory')
		.map((id) => labelled(deps.settings.labels?.connectors?.[id]))

/**
 * What the AI-use policy makes of one answer that went ahead: every class the conversation now holds,
 * and the line for under the answer about what would have been held back.
 */
function policyFor(
	deps: ChatDeps,
	policy: PolicyFile | undefined,
	before: DataClass[],
	used: Set<string>,
	modelLocal: boolean,
	approved = false,
): { classes: DataClass[]; notice: PolicyNotice | null } {
	const brought = connectorClasses(deps, used)
	const all = new Set([...before, ...brought])
	const classes = DATA_CLASSES.filter((each) => all.has(each))
	return {
		classes,
		notice: policyNotice(policy, {
			model: { classes, local: modelLocal, approved },
			...(brought.length ? { connector: before } : {}),
		}),
	}
}

/**
 * A tool source that says when it is called, and may refuse a call: `guard` returns the words a refused
 * call gets back, for the AI-use policy.
 */
function noteUse(
	source: ToolSource,
	id: string,
	onUse?: (id: string) => void,
	guard?: (id: string) => string | null,
	/** Changes a call's arguments before it is made: the real values back for notes kept here. */
	prepare?: PrepareCall,
): ToolSource {
	if (!onUse && !guard && !prepare) return source
	return {
		listTools: () => source.listTools(),
		callTool: async (name, args, context) => {
			const refused = guard?.(id)
			if (refused) return { text: refused, isError: true }
			onUse?.(id)
			return source.callTool(name, prepare ? prepare(name, args, context) : args, context)
		},
		...(source.listPrompts
			? { listPrompts: () => source.listPrompts?.() ?? Promise.resolve([]) }
			: {}),
		...(source.getPrompt
			? {
					getPrompt: (name: string, args: Record<string, string>) =>
						source.getPrompt?.(name, args) ?? Promise.resolve(''),
				}
			: {}),
		close: () => source.close(),
	}
}

function connectTools(
	host: NgomateHost,
	addons: Addon[],
	withMemory: boolean,
	onProblem: (name: string) => void,
	team?: { notes: TeamNotes; addonId?: string },
	/** Told which source each call went to (`memory`, or a connector's id), for the AI-use policy. */
	onUse?: (sourceId: string) => void,
	/** Refuses a call to a source, with the words it gets back; null lets it through. */
	guard?: (sourceId: string) => string | null,
	/** Changes the arguments of a call to the person's notes before it is made. */
	prepareNotes?: PrepareCall,
): Promise<ToolSource> {
	return (async () => {
		const sources = withMemory
			? [
					{
						id: 'memory',
						source: noteUse(
							createMemoryToolSource(host.memory, team?.notes),
							'memory',
							onUse,
							undefined,
							prepareNotes,
						),
					},
				]
			: []
		for (const addon of addons.filter((candidate) => candidate.enabled)) {
			try {
				const source = await host.connectAddon(addon)
				sources.push({
					id: addon.id,
					source: noteUse(
						filterToolSource(
							source,
							(tool) =>
								!addon.disabledTools?.includes(tool.name) &&
								(addon.allowDestructive || !isDestructiveTool(tool)) &&
								// Saved through the memory tools, where the person picks; never written around them.
								!(addon.id === team?.addonId && TEAM_TOOL_NAMES.has(tool.name)),
						),
						addon.id,
						onUse,
						guard,
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
 * The tools the connectors offer now, for picking one a job writes to or sends with. Write tools
 * included: what is picked there is approved by making the job.
 */
export async function listConnectorTools(deps: ChatDeps): Promise<ToolDefinition[]> {
	const tools = await connectTools(deps.host, deps.settings.addons, false, () => {}, deps.team)
	try {
		return await tools.listTools()
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

/** The person's answer before a conversation leaves: no, yes as it is, or yes with these taken out. */
export type LeaveAnswer = boolean | { takeOut: Identifier[] }

/** What happens while an answer is written, for a window showing it. All optional but the first three. */
export type AnswerHooks = {
	signal: AbortSignal
	/** Asked before anything is changed. A run nobody is watching refuses and records what was asked. */
	confirmWrite: ConfirmWrite
	/**
	 * Asked once per conversation when the AI-use policy wants the person to confirm before something
	 * leaves. Without it (a job no one watches) nothing is sent.
	 */
	confirmLeave?: (
		notice: PolicyNotice,
		/** What in the conversation looks like it says who someone is, and was not decided on before. */
		found: Identifier[],
		/** The message as typed, to show what leaves. */
		message: string,
	) => Promise<LeaveAnswer>
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
	/** Not sent, because the AI-use policy kept it from leaving or no one confirmed it. */
	refused?: boolean
}

/** Not sent because of the AI-use policy, rather than a failure to try again. */
class PolicyRefusal extends Error {}

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

		// The AI-use policy: what the conversation holds decides where it may go, before anything leaves.
		const policy = effectivePolicy(ownPolicy(deps.settings), deps.team?.policy, deps.managedPolicy)
		const modelLocal = onThisComputer(deps.settings.model)
		const approved = modelApproved(policy, deps.settings.model)
		const notesRead =
			!making && (Boolean(deps.team) || (await host.memory.list().catch(() => [])).length > 0)
		const before = heldBefore(deps, {
			earlier: current.classes,
			documents: allDocuments,
			notesRead,
		})
		// What the person said the conversation counts as weighs in, but is not kept as held: they can take it back.
		const planned = current.countsAs
			? DATA_CLASSES.filter((each) => each === current.countsAs || before.includes(each))
			: before
		// Who the conversation is about, taken out before it leaves when the person chose so.
		let standIns = current.standIns ?? []
		let sentAsIs = current.sentAsIs ?? []
		const decided = new Set([...standIns.map((each) => each.real), ...sentAsIs])
		const found = findIdentifiers([
			request,
			...allDocuments.map((document) => document.text),
			...current.messages.map((message) =>
				typeof message.content === 'string' ? message.content : '',
			),
		]).filter((each) => !decided.has(each.text))
		// The person's own choice: nothing leaves this conversation, whatever the policy allows.
		const keptHere = Boolean(current.keepHere)
		let reviewed = false
		const planFor = () =>
			planLeaving(policy, planned, {
				modelLocal,
				modelApproved: approved,
				reviewed,
				keepHere: keptHere,
			})
		// A yes counts only for what it was given for: data no more sensitive, and the model server only
		// when that was asked. Something new that says who someone is is offered again, unless the
		// conversation already swaps such things unasked.
		const wouldAsk = planFor().review
		reviewed =
			reviewCovers(current.reviewedFor, planned, !modelLocal) &&
			!(wouldAsk?.action === 'redact' && found.length > 0 && standIns.length === 0)
		let reviewedFor = current.reviewedFor
		let plan = planFor()
		if (plan.review) {
			const answer = await hooks.confirmLeave?.(plan.review, found, request)
			if (typeof answer === 'object') {
				standIns = addStandIns(standIns, answer.takeOut)
				const taken = new Set(answer.takeOut.map((each) => each.text))
				sentAsIs = [
					...sentAsIs,
					...found.filter((each) => !taken.has(each.text)).map((each) => each.text),
				]
			}
			if (!answer) {
				return {
					...nothing,
					conversation: latest,
					error:
						'Not sent: your AI-use policy asks you first, and this was not confirmed. Send it again to be asked.',
					refused: true,
				}
			}
			reviewed = true
			reviewedFor = widerReview(reviewedFor, plan.review)
			plan = planFor()
		}
		// Taken out once in this conversation: what is new of the same kind is taken out too, unasked.
		else if (standIns.length && found.length) standIns = addStandIns(standIns, found)
		if (plan.refuse) return { ...nothing, conversation: latest, error: plan.refuse, refused: true }
		const answersHere = modelLocal || Boolean(plan.useLocalModel)
		// The connectors this answer may use: all, none, or those whose results may reach its model.
		const offered = deps.settings.addons.filter(
			(addon) =>
				plan.connectors === 'all' ||
				(plan.connectors === 'allowed' &&
					connectorMayAnswer(
						policy,
						labelled(deps.settings.labels?.connectors?.[addon.id]),
						answersHere,
						reviewed,
						approved,
					)),
		)
		const leftOut = deps.settings.addons.some((addon) => addon.enabled && !offered.includes(addon))

		hooks.onStartingModel?.(true)
		let localName: string | undefined
		const chosen = plan.useLocalModel
			? deps.getLocalModel?.().then((local) => {
					if (local) {
						localName = local.name
						return local
					}
					throw new PolicyRefusal(
						keptHere
							? 'Not sent: you chose to keep this conversation on this computer, and no model is downloaded here. Download one under Model.'
							: 'Not sent: your AI-use policy keeps this conversation on this computer, and no model is downloaded here. Download one under Model.',
					)
				})
			: deps.getModel()
		const {
			client: model,
			contextTokens,
			searchKnowledgeFirst,
		} = await (
			chosen ??
			Promise.reject(
				new PolicyRefusal(
					'Not sent: your AI-use policy keeps this conversation on this computer, and this app cannot run a model here.',
				),
			)
		).finally(() => hooks.onStartingModel?.(false))
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
		// The sources this answer called: `memory`, or a connector's id. For the AI-use policy.
		const used = new Set<string>()
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
					offered,
					!task,
					(name) => {
						if (!seen.has(name)) hooks.onProblem?.(name)
						seen.add(name)
					},
					team,
					(id) => used.add(id),
					// What the conversation holds now, the results of other connectors included, goes with a call.
					(id) =>
						mayCallConnector(
							policy,
							[
								...before,
								...connectorClasses(
									deps,
									[...used].filter((other) => other !== id),
								),
							],
							reviewed,
						)
							? null
							: CONNECTOR_REFUSED,
					// The person's own notes stay on this computer, so they keep the real values; a team
					// note keeps the stand-ins, as a connector does.
					standIns.length
						? (name, args, context) =>
								reachesTeamNotes(name, args, context) ? args : putBackArgs(args, standIns)
						: undefined,
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
			!task && !making && text.trim() && offered.some((addon) => addon.enabled)
				? {
						// The search is a connector too: it gets the stand-ins, never the real values.
						query: standInsOr(passageQuery(text, current.messages), standIns),
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
		// What leaves carries stand-ins: to a model server, and through the model to its connectors.
		const swapping = standIns.length > 0 && (!answersHere || offered.length > 0)
		const run = await runTask({
			model: swapping ? withStandIns(model, standIns) : model,
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
			offerTools: options.offerTools,
			maxOutputTokens: room.output,
			// A note kept here is saved with the real values, so it is shown with them; anything else is
			// shown exactly as it will be sent, stand-ins and all.
			confirmWrite: standIns.length
				? (write) =>
						hooks.confirmWrite(
							write.tool === SAVE_NOTE_TOOL
								? {
										...write,
										args: putBackArgs(write.args, standIns),
										// Shown with the real values; saved for the team, it keeps the stand-ins.
										...(write.choices
											? {
													choices: write.choices.map((choice) =>
														choice.id === 'team'
															? {
																	...choice,
																	label: `${choice.label}, with stand-ins such as [PERSON_1] for who it is about`,
																}
															: choice,
													),
												}
											: {}),
									}
								: write,
						)
				: hooks.confirmWrite,
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
		let classes: DataClass[] = current.classes ?? []
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
			if (swapping) notice.tookOut = standIns.length
			const held = policyFor(
				deps,
				policy,
				planned,
				used,
				modelLocal,
				!plan.useLocalModel && approved,
			)
			// Kept as held: what came in, not what the person said, which they can take back.
			const brought = connectorClasses(deps, used)
			const kept = DATA_CLASSES.filter((each) => before.includes(each) || brought.includes(each))
			if (keptHere) {
				held.notice = null
				notice.keptHere = plan.useLocalModel && localName ? { model: localName } : {}
			}
			// Kept to: say what was held back. Everything else went where it was allowed to.
			else if (policy?.rules?.mode === 'enforce')
				held.notice =
					plan.useLocalModel || leftOut
						? {
								action: 'local_only',
								// Left out for what its own results would bring in, not for what the conversation holds.
								dataClass:
									plan.connectors === 'allowed' && !plan.useLocalModel
										? mostSensitive(
												deps.settings.addons
													.filter((addon) => addon.enabled && !offered.includes(addon))
													.map((addon) => labelled(deps.settings.labels?.connectors?.[addon.id])),
											)
										: mostSensitive(planned),
								where: [
									...(plan.useLocalModel ? (['model'] as const) : []),
									...(leftOut ? (['connector'] as const) : []),
								],
								observed: false,
								...(policy.template ? { template: policy.template } : {}),
								...(plan.useLocalModel && localName ? { localModel: localName } : {}),
							}
						: null
			if (held.notice) {
				notice.policy = held.notice
				const entry: PolicyRecordEntry = {
					at: new Date().toISOString(),
					feature: options.feature ?? (task ? 'task' : 'chat'),
					where: held.notice.where,
					dataClass: held.notice.dataClass,
					action: held.notice.action,
					observed: held.notice.observed,
					template: policy?.template,
					version: policy?.version ?? 0,
				}
				recordPolicy(host, entry).catch((err) =>
					console.error('The record of use could not be written:', err),
				)
				// The team's counts, in its own storage; a team kept by a connector keeps none.
				if (deps.team && !deps.team.addonId && host.team && deps.countsId)
					countForTeam(host.team.store, deps.countsId(), entry).catch((err) =>
						console.error("The team's counts could not be written:", err),
					)
			}
			classes = kept
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
			...(classes.length ? { classes } : {}),
			...(reviewedFor ? { reviewedFor } : {}),
			...(standIns.length ? { standIns } : {}),
			...(sentAsIs.length ? { sentAsIs } : {}),
		})
		return { conversation: latest, error, answer: run.answer ?? null, notice }
	} catch (err) {
		return {
			conversation: latest,
			error: err instanceof Error ? err.message : String(err),
			answer: null,
			notice: null,
			...(err instanceof PolicyRefusal ? { refused: true } : {}),
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
	// The AI-use policy asking once whether this conversation may leave the computer.
	const [pendingLeave, setPendingLeave] = useState<{
		notice: PolicyNotice
		found: Identifier[]
		message: string
		resolve: (answer: LeaveAnswer) => void
	} | null>(null)
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
			const confirmLeave = (notice: PolicyNotice, found: Identifier[], message: string) =>
				new Promise<LeaveAnswer>((resolve) => {
					const onAbort = () => {
						setPendingLeave(null)
						resolve(false)
					}
					controller.signal.addEventListener('abort', onAbort, { once: true })
					setPendingLeave({
						notice,
						found,
						message,
						resolve: (answer) => {
							controller.signal.removeEventListener('abort', onAbort)
							setPendingLeave(null)
							resolve(answer)
						},
					})
				})
			try {
				const result = await answerRequest(depsRef.current, current, text, options, {
					signal: controller.signal,
					confirmWrite,
					confirmLeave,
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

	/** What the person says this conversation counts as, or nothing to take it back. */
	const setCountsAs = useCallback(
		(dataClass: DataClass | undefined) => {
			const { countsAs: _, ...rest } = conversation
			return save(dataClass ? { ...rest, countsAs: dataClass } : rest)
		},
		[conversation, save],
	)

	/** Keeps this conversation on this computer, or lets it go where the policy allows again. */
	const setKeepHere = useCallback(
		(on: boolean) => {
			const { keepHere: _, ...rest } = conversation
			return save(on ? { ...rest, keepHere: true } : rest)
		},
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
		pendingLeave,
		send,
		retry,
		stop,
		removeDocument,
		setCountsAs,
		setKeepHere,
		updateDraft,
		loaded,
		latest,
	}
}
