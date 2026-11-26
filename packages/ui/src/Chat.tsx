import {
	CLASS_WORDS,
	type ChatMessage,
	DATA_CLASSES,
	type DataClass,
	type PromptDefinition,
	type TaskFile,
	decide,
} from '@ngomate/core'
import {
	type FormEvent,
	type KeyboardEvent,
	type UIEvent,
	memo,
	useCallback,
	useEffect,
	useRef,
	useState,
} from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { type ActionItem, ActionMenu } from './ActionMenu.js'
import { DraftCard } from './DraftCard.js'
import { type Draft, type MakingContext, emptyDraft } from './drafts.js'
import { formatBytes, promptLabel } from './format.js'
import type {
	AnswerNotice,
	AnswerTiming,
	NgomateHost,
	PickedDocument,
	PolicyNotice,
} from './host.js'
import { ICONS, Icon } from './icons.js'
import {
	composerStatus,
	documentClass,
	effectivePolicy,
	keptHereText,
	labelled,
	looksPersonal,
	modelApproved,
	onThisComputer,
	ownPolicy,
	policyNoticeText,
	reviewCovers,
} from './policyCheck.js'
import { usePrimitives } from './primitives.js'
import { type Identifier, type IdentifierKind, addStandIns, standIn } from './standIns.js'
import {
	type ChatDeps,
	type LeaveAnswer,
	type PendingWrite,
	heldBefore,
	useChat,
} from './useChat.js'
import { WAVE_BARS, useVoice } from './useVoice.js'

/** The AI-use policy asking once whether this conversation may leave the computer. */
const KIND_WORDS: Record<IdentifierKind, string> = {
	name: 'name',
	email: 'email address',
	phone: 'phone number',
}

/**
 * Asked once in a conversation before it leaves, as the AI-use policy wants: what in it says who
 * someone is, ticked to go out as a stand-in, names the person adds, and the message as it will leave.
 */
function LeaveConfirmation({
	request,
}: {
	request: {
		notice: PolicyNotice
		found: Identifier[]
		message: string
		resolve: (answer: LeaveAnswer) => void
	}
}) {
	const { Button, Checkbox, Input } = usePrimitives()
	const where = request.notice.where.includes('model') ? 'the model server' : 'a connector'
	const redact = request.notice.action === 'redact'
	const [items, setItems] = useState(() => request.found.map((each) => ({ ...each, take: true })))
	const [name, setName] = useState('')
	const takeOut = items.filter((each) => each.take)
	const add = () => {
		const text = name.trim()
		if (text && !items.some((each) => each.text === text))
			setItems((known) => [...known, { text, kind: 'name', take: true }])
		setName('')
	}
	const leaving = standIn(request.message, addStandIns([], takeOut))
	return (
		<div
			className="ngm-confirm"
			role="alertdialog"
			aria-label="Confirm before it leaves this computer"
		>
			<strong>Send this conversation to {where}?</strong>
			<p className="ngm-muted">
				It holds {CLASS_WORDS[request.notice.dataClass].toLowerCase()}
				{redact
					? '. Your AI-use policy lets it leave only without names or anything else that says who someone is.'
					: ', which your AI-use policy lets leave this computer only once you confirm.'}{' '}
				What you tick goes out as a stand-in such as [PERSON_1], in the message, its documents and
				what was said before; the real ones stay here and are shown again in the answer. You are
				asked once in this conversation.
			</p>
			{items.length > 0 && (
				<div className="ngm-stand-ins">
					{items.map((each, index) => (
						<label className="ngm-tool-switch" key={each.text}>
							<Checkbox
								checked={each.take}
								onChange={(event) =>
									setItems((known) =>
										known.map((item, at) =>
											at === index ? { ...item, take: event.target.checked } : item,
										),
									)
								}
							/>
							<span>
								{each.text} <span className="ngm-muted">({KIND_WORDS[each.kind]})</span>
							</span>
						</label>
					))}
				</div>
			)}
			<div className="ngm-row">
				<Input
					aria-label="A name to take out"
					placeholder="For example: a name it did not find"
					value={name}
					onChange={(event) => setName(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === 'Enter') {
							event.preventDefault()
							add()
						}
					}}
				/>
				<Button onClick={add} disabled={!name.trim()}>
					Take out
				</Button>
			</div>
			{request.message && (
				<p className="ngm-stand-in-preview">
					<span className="ngm-muted">Your message leaves as: </span>
					{leaving}
				</p>
			)}
			{redact && (
				<p className="ngm-muted">
					Names are found only when you add them, and a role and a place can still say who someone
					is: you are the check.
				</p>
			)}
			<div className="ngm-row">
				<Button onClick={() => request.resolve(false)}>Don't send</Button>
				<Button variant="primary" onClick={() => request.resolve({ takeOut })}>
					Send
				</Button>
			</div>
		</div>
	)
}

function WriteConfirmation({ request }: { request: PendingWrite }) {
	const { Button } = usePrimitives()
	const isMemory = request.tool === 'save_memory'
	return (
		<div className="ngm-confirm" role="alertdialog" aria-label="Confirm this action">
			<strong>{isMemory ? 'Save this note?' : `Allow ${request.tool}?`}</strong>
			{isMemory ? (
				<>
					<p className="ngm-muted">Name: {String(request.args.name ?? '')}</p>
					<pre className="ngm-pre">{String(request.args.text ?? '')}</pre>
				</>
			) : (
				<pre className="ngm-pre">{JSON.stringify(request.args, null, 2)}</pre>
			)}
			<div className="ngm-row">
				{request.choices?.length ? (
					request.choices.map((choice, index) => (
						<Button
							key={choice.id}
							variant={index === 0 ? 'primary' : 'default'}
							onClick={() => request.resolve({ choice: choice.id })}
						>
							{choice.label}
						</Button>
					))
				) : (
					<Button variant="primary" onClick={() => request.resolve(true)}>
						Allow
					</Button>
				)}
				<Button onClick={() => request.resolve(false)}>Don't allow</Button>
			</div>
		</div>
	)
}

/** Whether the checks found anything to say about an answer: an empty notice is not drawn at all. */
export function noticeSaysSomething(notice: AnswerNotice): boolean {
	return Boolean(
		notice.stopped ||
			notice.policy ||
			notice.keptHere ||
			notice.tookOut ||
			notice.knowledgeEntries?.length ||
			notice.knowledgeUnavailable ||
			notice.cutOff ||
			notice.toolsDidNotFit?.length ||
			notice.neverRead?.length ||
			notice.partlyRead?.length ||
			notice.earlierLeftOut ||
			notice.figureProblems?.length ||
			notice.checkFigures ||
			notice.unsourcedDates.length ||
			notice.unsourcedLinks.length,
	)
}

function Notice({ notice }: { notice: AnswerNotice }) {
	if (!noticeSaysSomething(notice)) return null
	return (
		<div className="ngm-notice">
			{notice.policy && <p className="ngm-policy-line">{policyNoticeText(notice.policy)}</p>}
			{notice.keptHere && <p className="ngm-policy-line">{keptHereText(notice.keptHere)}</p>}
			{(notice.tookOut ?? 0) > 0 && (
				<p className="ngm-policy-line">
					{notice.tookOut === 1
						? 'One detail that says who someone is went out as a stand-in, and is shown here again.'
						: `${notice.tookOut} details that say who someone is went out as stand-ins, and are shown here again.`}
				</p>
			)}
			{notice.stopped && <p>{notice.stopped}</p>}
			{(notice.knowledgeEntries?.length ?? 0) > 0 && (
				<p>Looked up in the knowledge base: {notice.knowledgeEntries?.join(', ')}.</p>
			)}
			{notice.knowledgeUnavailable && (
				<p>The knowledge base did not answer, so this was written without it.</p>
			)}
			{notice.cutOff && (
				<p>This answer reached the length limit and was cut off. Ask it to continue.</p>
			)}
			{(notice.toolsDidNotFit?.length ?? 0) > 0 && (
				<p>
					There was no room to offer these tools with this message:{' '}
					{notice.toolsDidNotFit?.join(', ')}. Turning off others under Connectors makes room.
				</p>
			)}
			{(notice.neverRead?.length ?? 0) > 0 && (
				<p>
					{notice.neverRead?.join(', ')} is too long to read to the end, so its last part was not
					searched at all.
				</p>
			)}
			{(notice.partlyRead?.length ?? 0) > 0 && (
				<p>
					Read only part of {notice.partlyRead?.join(', ')}, the part closest to your request. If
					something seems missing, ask about it directly.
				</p>
			)}
			{notice.earlierLeftOut && (
				<p>
					This conversation is too long for the model to hold, so it did not see the earliest part.
				</p>
			)}
			{(notice.figureProblems?.length ?? 0) > 0 && (
				<div>
					<p>Check these figures against your material:</p>
					<ul className="ngm-figures">
						{notice.figureProblems?.map((item) => (
							<li key={item.figure}>
								<strong>{item.figure}</strong>
								{item.problem === 'different'
									? `: your material says ${item.material?.join(', ')}`
									: ': not found in your material'}
							</li>
						))}
					</ul>
				</div>
			)}
			{notice.checkFigures && (
				<p>
					{(notice.figureProblems?.length ?? 0) > 0 ? 'Also check' : 'Check'} every name and figure
					against your material. The model can mix them up.
				</p>
			)}
			{notice.unsourcedDates.length > 0 && (
				<p>
					Not found in your material or in any tool's result, so check them:{' '}
					{notice.unsourcedDates.join(', ')}
				</p>
			)}
			{notice.unsourcedLinks.length > 0 && (
				<p>
					These links did not come from your material or any tool, and may not exist:{' '}
					{notice.unsourcedLinks.join(', ')}
				</p>
			)}
		</div>
	)
}

/**
 * How loud the microphone is, over the last moments: flat while it is quiet, moving while someone speaks.
 * Drawn from the readings alone; nothing of the sound itself is shown or kept.
 */
function VoiceWave({ levels }: { levels: number[] }) {
	const bars = [...Array(Math.max(0, WAVE_BARS - levels.length)).fill(0), ...levels]
	return (
		<svg className="ngm-voice-wave" viewBox={`0 0 ${WAVE_BARS * 3} 16`} aria-hidden="true">
			{bars.map((level, index) => {
				const height = Math.max(1.5, level * 16)
				return (
					<rect
						// biome-ignore lint/suspicious/noArrayIndexKey: a bar is its place in the wave
						key={index}
						x={index * 3}
						y={(16 - height) / 2}
						width={2}
						height={height}
						rx={1}
					/>
				)
			})}
		</svg>
	)
}

/** "0:07", "1:42": how long the microphone has been listening. */
const clock = (ms: number) => {
	const seconds = Math.max(0, Math.floor(ms / 1000))
	return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

/** "14:05" today, "12 Nov, 14:05" before. */
export function formatTime(iso: string, now = new Date()): string {
	const date = new Date(iso)
	if (Number.isNaN(date.getTime())) return ''
	const time = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
	if (date.toDateString() === now.toDateString()) return time
	return `${date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}, ${time}`
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`
const count = (n: number) => n.toLocaleString('en')

/** Where the wait for an answer went, one line per step, shown when pointing at its time. */
export function describeTiming(timing: AnswerTiming): string {
	const lines = [
		timing.firstWordMs === null
			? `No words shown, done after ${seconds(timing.totalMs)}`
			: `First words after ${seconds(timing.firstWordMs)}, done after ${seconds(timing.totalMs)}`,
		`Model ready after ${seconds(timing.startMs)}`,
	]
	if (timing.knowledgeMs !== null) lines.push(`Knowledge search: ${seconds(timing.knowledgeMs)}`)
	if (timing.hiddenMs) lines.push(`The app was out of sight for ${seconds(timing.hiddenMs)}`)
	if (timing.toolMs > 0) lines.push(`Tools: ${seconds(timing.toolMs)}`)
	for (const call of timing.toolCalls ?? []) {
		const network = call.httpMs === null ? '' : `, ${seconds(call.httpMs)} of it on the network`
		lines.push(`  ${call.tool}: ${seconds(call.ms)}${network}`)
	}
	timing.modelCalls.forEach((call, index) => {
		const read =
			call.promptRead === null
				? null
				: `read ${count(call.promptRead)} tokens${call.promptReused ? ` (${count(call.promptReused)} reused)` : ''}${call.promptMs === null ? '' : ` in ${seconds(call.promptMs)}`}`
		const wrote = call.tokensPerSecond === null ? null : `wrote ${call.tokensPerSecond} tokens/s`
		lines.push(
			`Model call ${index + 1}: ${[seconds(call.totalMs), read, wrote].filter(Boolean).join(', ')}`,
		)
	})
	return lines.join('\n')
}

function MessageMeta({
	time,
	timeTitle,
	onRetry,
	items,
	note,
}: {
	time?: string
	/** Shown when pointing at the time. */
	timeTitle?: string
	onRetry?: () => void
	items: ActionItem[]
	note?: string | null
}) {
	const { Button } = usePrimitives()
	return (
		<div className="ngm-row ngm-message-meta">
			{time && (
				<time dateTime={time} title={timeTitle}>
					{formatTime(time)}
				</time>
			)}
			{note && <span>{note}</span>}
			{onRetry && (
				<Button variant="quiet" onClick={onRetry}>
					Retry
				</Button>
			)}
			<ActionMenu label="More actions" items={items} className="" />
		</div>
	)
}

// Finished messages do not change, so an answer being written must not parse them all again.
const MessageView = memo(function MessageView({
	message,
	notice,
	time,
	unanswered,
	onRetry,
	host,
	onProblem,
}: {
	message: ChatMessage
	notice?: AnswerNotice
	time?: string
	/** A question whose answer never came. */
	unanswered?: boolean
	/** Only on the latest question and answer, while nothing is running. */
	onRetry?: () => void
	host: NgomateHost
	onProblem: (err: unknown) => void
}) {
	const [copied, setCopied] = useState(false)
	const copy = (text: string): ActionItem => ({
		label: copied ? 'Copied' : 'Copy',
		onSelect: () => navigator.clipboard.writeText(text).then(() => setCopied(true), onProblem),
	})
	if (message.role === 'user') {
		return (
			<div className="ngm-user-turn">
				<div className="ngm-message ngm-user">{message.content}</div>
				<MessageMeta
					time={time}
					note={unanswered ? 'No answer' : null}
					onRetry={onRetry}
					items={[copy(message.content)]}
				/>
			</div>
		)
	}
	if (message.role !== 'assistant') return null
	if (message.toolCalls?.length) {
		return (
			<p className="ngm-tool-line">Used {message.toolCalls.map((call) => call.name).join(', ')}</p>
		)
	}
	const text = message.content
	if (!text) return null
	return (
		<div className="ngm-message ngm-assistant">
			{/* Model text is never rendered as HTML, and its links do not navigate this window. */}
			<div className="ngm-answer-text">
				<Markdown
					remarkPlugins={[remarkGfm]}
					components={{
						a: ({ href, children }) => (
							<a href={href} target="_blank" rel="noreferrer noopener">
								{children}
							</a>
						),
						img: ({ alt }) => <span>{alt}</span>,
					}}
				>
					{text}
				</Markdown>
			</div>
			{notice && <Notice notice={notice} />}
			<MessageMeta
				time={time}
				timeTitle={notice?.timing ? describeTiming(notice.timing) : undefined}
				items={[
					copy(text),
					{
						label: 'Save as file',
						onSelect: () => void host.saveDocument('draft.md', text).catch(onProblem),
					},
					...(onRetry ? [{ label: 'Retry', onSelect: onRetry }] : []),
				]}
			/>
		</div>
	)
})

/** The message field grows with its text, up to a third of the window, then scrolls. */
function fitToText(field: HTMLTextAreaElement) {
	field.style.height = 'auto'
	field.style.height = `${Math.min(field.scrollHeight, Math.round(window.innerHeight / 3))}px`
}

export type ChatStart = {
	task?: TaskFile
	prompt?: { definition: PromptDefinition; text: string }
	/**
	 * Something to make in this chat: the draft, given to it once it has been read, and the person's
	 * words, sent at once if there are any. `title` names a chat that has no messages yet.
	 */
	making?: { draft: Draft; text?: string; title?: string }
}

/** What a chat needs to make a task or job with the person. Left out by a host that cannot keep them. */
export type ChatMaking = {
	context: MakingContext
	taskTitle: (id: string) => string | undefined
	/**
	 * Saves what the draft makes. Resolves to its key and name; throws with a reason. A step saved on the
	 * way, such as a job's new task, is handed to `onStep`, so trying again does not make it twice.
	 */
	save: (
		draft: Draft,
		onStep: (draft: Draft) => Promise<void>,
	) => Promise<{ key: string; title: string }>
	/** Opens the form filled in from the draft. Resolves to what was saved there, or null. */
	openForm: (
		draft: Draft,
		onStep: (draft: Draft) => Promise<void>,
	) => Promise<{ key: string; title: string } | null>
	/** A saved item as a draft to change, read anew, so nothing discarded earlier comes back. */
	draftOf: (kind: Draft['kind'], key: string) => Draft | undefined
	/** Shows the saved item in its list. */
	open: (draft: Draft) => void
	/** The name of what a saved draft made. */
	titleOf: (draft: Draft) => string | undefined
	/** This chat is making something not yet saved (`kind`), or no longer is. */
	onDraft: (conversationId: string, kind: Draft['kind'] | null, saved?: string) => void
}

export function Chat({
	deps,
	conversationId,
	start,
	onStarted,
	attachRequest = 0,
	making,
}: {
	deps: ChatDeps
	conversationId: string
	start: ChatStart | null
	onStarted: () => void
	/** Counts up each time the menu asks this conversation to attach a document. */
	attachRequest?: number
	making?: ChatMaking
}) {
	const { Button, Checkbox, TextArea, Chip, Dialog, Select } = usePrimitives()
	const chat = useChat(deps, conversationId)
	const [text, setText] = useState('')
	const [documents, setDocuments] = useState<PickedDocument[]>([])
	const [task, setTask] = useState<TaskFile | undefined>()
	const [prompt, setPrompt] = useState<ChatStart['prompt']>()
	const [fileProblem, setFileProblem] = useState<string | null>(null)
	const bottom = useRef<HTMLDivElement>(null)
	const onProblem = useCallback(
		(err: unknown) => setFileProblem(err instanceof Error ? err.message : String(err)),
		[],
	)

	useEffect(() => {
		if (!start || start.making) return
		setTask(start.task)
		setPrompt(start.prompt)
		onStarted()
	}, [start, onStarted])

	// Something to make, from New task, New job or Change in chat: once the chat has been read, so
	// nothing it holds is saved over.
	// biome-ignore lint/correctness/useExhaustiveDependencies: runs once per start, when the chat is read
	useEffect(() => {
		const begin = start?.making
		// Not while an answer is written there: it would be saved over, or two would run at once.
		if (!begin || !chat.loaded || chat.busy || !making) return
		onStarted()
		making.onDraft(conversationId, begin.draft.kind)
		if (begin.text)
			void chat.send(
				begin.text,
				{ making: making.context },
				{ ...chat.conversation, draft: begin.draft },
			)
		else
			void chat.updateDraft(
				begin.draft,
				chat.conversation.messages.length ? undefined : begin.title,
			)
	}, [start, chat.loaded, chat.busy, Boolean(making)])

	// Speaking instead of typing: what is heard is added to the message, for the person to read first.
	const voice = useVoice(deps.host, deps.settings.voiceModel, (heard) =>
		setText((typed) => (typed.trim() ? `${typed.trimEnd()} ${heard}` : heard)),
	)
	// A clock while listening, so the person sees it is still on.
	const [, tick] = useState(0)
	useEffect(() => {
		if (voice.status.kind !== 'listening') return
		const timer = setInterval(() => tick((n) => n + 1), 1000)
		return () => clearInterval(timer)
	}, [voice.status.kind])
	const [makeFrom, setMakeFrom] = useState(false)
	// A draft being saved: nothing else is sent meanwhile, or the answer would put it back unsaved.
	const [savingDraft, setSavingDraft] = useState(false)
	const draft = chat.conversation.draft
	const startDraft = (kind: Draft['kind']) => {
		if (!making) return
		setMakeFrom(false)
		making.onDraft(conversationId, kind)
		void chat.send(
			kind === 'job' ? 'Make a job from this conversation.' : 'Make a task from this conversation.',
			{ making: making.context },
			{ ...chat.conversation, draft: emptyDraft(kind) },
		)
	}
	/** Marks the draft saved, as it is now: a job's new task may have been saved into it meanwhile. */
	const markSaved = async (saved: { key: string; title: string }) => {
		const now = chat.latest().draft
		if (!now) return
		const { editing: _editing, editingVersion: _version, ...rest } = now
		await chat.updateDraft({ ...rest, saved: saved.key }, saved.title)
		making?.onDraft(conversationId, null, saved.key)
	}

	/** Follows the end of the chat, until the person scrolls up to read; sending follows it again. */
	const following = useRef(true)
	const onScroll = (event: UIEvent<HTMLDivElement>) => {
		const box = event.currentTarget
		following.current = box.scrollHeight - box.scrollTop - box.clientHeight < 48
	}
	const shownCount = useRef(0)
	// biome-ignore lint/correctness/useExhaustiveDependencies: scrolls when any of these change
	useEffect(() => {
		const { messages } = chat.conversation
		if (messages.length > shownCount.current && messages.at(-1)?.role === 'user') {
			following.current = true
		}
		shownCount.current = messages.length
		if (following.current) bottom.current?.scrollIntoView?.({ block: 'end' })
	}, [chat.conversation.messages.length, chat.streaming, chat.pendingWrite])

	// What is shown can still grow after that: an answer laid out late, a font that loads, a wider
	// pane. While following the end, it follows that too.
	const messagesBox = useRef<HTMLDivElement>(null)
	// biome-ignore lint/correctness/useExhaustiveDependencies: watches the messages shown now
	useEffect(() => {
		const box = messagesBox.current
		if (!box || typeof ResizeObserver === 'undefined') return
		const watcher = new ResizeObserver(() => {
			if (following.current) box.scrollTop = box.scrollHeight
		})
		for (const child of box.children) watcher.observe(child)
		watcher.observe(box)
		return () => watcher.disconnect()
	}, [chat.conversation.messages.length, chat.pendingWrite])
	const whole = Boolean(deps.settings.wholeAnswers)

	// Fitted after every change, a cleared one included, so the field shrinks back after sending.
	const composerBox = useRef<HTMLDivElement>(null)
	// biome-ignore lint/correctness/useExhaustiveDependencies: fitted again whenever the text changes
	useEffect(() => {
		const field = composerBox.current?.querySelector('textarea')
		if (field) fitToText(field)
	}, [text])

	// The AI-use policy, before anything is sent: where this conversation will go, and a warning when
	// the typed text looks like it names someone while the conversation does not count as personal.
	const policy = effectivePolicy(ownPolicy(deps.settings), deps.team?.policy, deps.managedPolicy)
	const [hasNotes, setHasNotes] = useState(false)
	// Keyed on whether there is a policy: a combined one is a new object on every render.
	const hasPolicy = Boolean(policy)
	useEffect(() => {
		if (!hasPolicy) return
		let live = true
		deps.host.memory
			.list()
			.then((notes) => live && setHasNotes(notes.length > 0))
			.catch((err) => console.error('Your notes could not be listed for the policy:', err))
		return () => {
			live = false
		}
	}, [hasPolicy, deps.host])
	const modelLocal = onThisComputer(deps.settings.model)
	const countsAs = chat.conversation.countsAs
	const held = policy
		? heldBefore(deps, {
				earlier: [...(chat.conversation.classes ?? []), ...(countsAs ? [countsAs] : [])],
				documents: [...(chat.conversation.documents ?? []), ...documents],
				notesRead: !(draft && !draft.saved && making) && (Boolean(deps.team) || hasNotes),
			})
		: []
	const keepHere = Boolean(chat.conversation.keepHere)
	// Only worth offering when something could leave: a model server, or a connector switched on.
	const canLeave = !modelLocal || deps.settings.addons.some((addon) => addon.enabled)
	const status = composerStatus(policy, held, {
		modelLocal,
		modelApproved: modelApproved(policy, deps.settings.model),
		reviewed: reviewCovers(chat.conversation.reviewedFor, held, !modelLocal),
		keepHere,
	})
	const personalFound =
		policy &&
		!held.some((each) => DATA_CLASSES.indexOf(each) >= DATA_CLASSES.indexOf('personal')) &&
		!keepHere &&
		decide(policy, 'personal', 'desktop_remote') !== 'allow'
			? looksPersonal(text)
			: []

	const submit = async (event?: FormEvent) => {
		event?.preventDefault()
		// Not while a draft is being saved: the answer would put the unsaved draft back over it.
		if (chat.busy || savingDraft || (!text.trim() && !documents.length && !prompt)) return
		const options = {
			task,
			documents,
			prompt: prompt ? { title: promptLabel(prompt.definition), text: prompt.text } : undefined,
			making: draft && !draft.saved ? making?.context : undefined,
		}
		setText('')
		setDocuments([])
		setTask(undefined)
		setPrompt(undefined)
		await chat.send(text.trim(), options)
	}

	const onKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
		if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
			event.preventDefault()
			submit()
		}
	}

	const attach = async () => {
		setFileProblem(null)
		try {
			const picked = await deps.host.pickDocument()
			// Labelled as it is attached, so changing the label for documents later relabels none.
			const dataClass = policy ? labelled(deps.settings.labels?.documents) : undefined
			if (picked) setDocuments((known) => [...known, dataClass ? { ...picked, dataClass } : picked])
		} catch (err) {
			onProblem(err)
		}
	}

	// Only a request made while this conversation is in front; one from before it opened is not its own.
	const seenAttach = useRef(attachRequest)
	// biome-ignore lint/correctness/useExhaustiveDependencies: runs for a new request only
	useEffect(() => {
		if (attachRequest > seenAttach.current) attach()
		seenAttach.current = attachRequest
	}, [attachRequest])

	const { messages, notices, times = {} } = chat.conversation
	const lastQuestion = messages.findLastIndex((message) => message.role === 'user')
	const lastAnswer = messages.findLastIndex(
		(message) => message.role === 'assistant' && !message.toolCalls?.length && message.content,
	)
	const retry = chat.busy
		? undefined
		: () => void chat.retry(draft && !draft.saved ? making?.context : undefined)
	return (
		<div className="ngm-chat">
			{draft && making && (
				<DraftCard
					draft={draft}
					taskTitle={making.taskTitle}
					savedTitle={draft.saved ? making.titleOf(draft) : undefined}
					busy={chat.busy || savingDraft}
					onMake={async () => {
						setSavingDraft(true)
						try {
							await markSaved(await making.save(draft, (next) => chat.updateDraft(next)))
						} finally {
							setSavingDraft(false)
						}
					}}
					onForm={() => {
						void making
							.openForm(draft, (next) => chat.updateDraft(next))
							.then((saved) => saved && markSaved(saved))
					}}
					onDiscard={() => {
						// A change is dropped, and what it was changing stays as it was saved: only the link to
						// it is kept, and a later change starts from it anew.
						const { editing } = draft
						void chat.updateDraft(
							editing ? { kind: draft.kind, task: {}, job: {}, saved: editing } : undefined,
						)
						making.onDraft(conversationId, null)
					}}
					onOpen={() => making.open(draft)}
					onChange={() => {
						if (!draft.saved) return
						const fresh = making.draftOf(draft.kind, draft.saved)
						if (!fresh) return
						void chat.updateDraft(fresh)
						making.onDraft(conversationId, draft.kind)
					}}
				/>
			)}
			<div className="ngm-messages" ref={messagesBox} aria-live="polite" onScroll={onScroll}>
				{messages.length === 0 && !chat.busy && (
					<div className="ngm-empty">
						<h2>What are we working on?</h2>
						<p className="ngm-muted">
							Everything stays on this computer unless you add a connector. Attach a document or
							pick a ready-made task to start.
						</p>
					</div>
				)}
				{messages.map((message, index) => (
					<MessageView
						// biome-ignore lint/suspicious/noArrayIndexKey: messages only ever grow at the end
						key={index}
						message={message}
						notice={notices[index]}
						time={times[index]}
						unanswered={index === lastQuestion && lastAnswer < index && !chat.busy}
						onRetry={
							index === lastQuestion || (index === lastAnswer && lastAnswer > lastQuestion)
								? retry
								: undefined
						}
						host={deps.host}
						onProblem={onProblem}
					/>
				))}
				{chat.streaming && !whole && (
					<div className="ngm-message ngm-assistant">
						<Markdown
							remarkPlugins={[remarkGfm]}
							components={{ img: ({ alt }) => <span>{alt}</span> }}
						>
							{chat.streaming}
						</Markdown>
					</div>
				)}
				{chat.busy && (!chat.streaming || whole) && !chat.pendingWrite && (
					<output className="ngm-tool-line ngm-working">
						{chat.streaming
							? 'Writing the answer…'
							: chat.startingModel
								? 'Starting the model. This can take a minute…'
								: chat.readingDocument
									? 'Reading your document. A long one can take a minute…'
									: chat.activity
										? `Using ${chat.activity}…`
										: 'Thinking…'}
					</output>
				)}
				{making &&
					!draft &&
					!chat.busy &&
					lastAnswer > lastQuestion &&
					(makeFrom ? (
						<div className="ngm-row">
							<Button onClick={() => startDraft('task')}>As a task you run again</Button>
							<Button onClick={() => startDraft('job')}>As a job on a schedule</Button>
							<Button variant="quiet" onClick={() => setMakeFrom(false)}>
								Cancel
							</Button>
						</div>
					) : (
						<div className="ngm-row">
							<Button variant="quiet" className="ngm-ai" onClick={() => setMakeFrom(true)}>
								<Icon path={ICONS.spark} size={14} />
								Make a task or job from this
							</Button>
						</div>
					))}
				{chat.pendingWrite && <WriteConfirmation request={chat.pendingWrite} />}
				{chat.pendingLeave && <LeaveConfirmation request={chat.pendingLeave} />}
				{chat.error && (
					<p className="ngm-error" role="alert">
						{chat.error}
					</p>
				)}
				{fileProblem && (
					<p className="ngm-error" role="alert">
						{fileProblem}
					</p>
				)}
				{chat.problems.length > 0 && (
					<p className="ngm-notice">
						Could not reach: {chat.problems.join(', ')}. Carried on without them.
					</p>
				)}
				<div ref={bottom} />
			</div>

			<form className="ngm-composer" onSubmit={submit}>
				{task && (
					<div className="ngm-chip-line">
						<Chip>{task.title}</Chip>
						<Button variant="quiet" onClick={() => setTask(undefined)}>
							Remove
						</Button>
						<span className="ngm-muted">{task.ask}</span>
					</div>
				)}
				{prompt && (
					<div className="ngm-chip-line">
						<Chip>{promptLabel(prompt.definition)}</Chip>
						<Button variant="quiet" onClick={() => setPrompt(undefined)}>
							Remove
						</Button>
					</div>
				)}
				{chat.conversation.documents?.map((document, index) => (
					// biome-ignore lint/suspicious/noArrayIndexKey: two files can share a name
					<div className="ngm-chip-line" key={index}>
						<Chip>{document.name}</Chip>
						<Button
							variant="quiet"
							aria-label={`Stop using ${document.name}`}
							disabled={chat.busy}
							onClick={() => chat.removeDocument(index)}
						>
							Stop using
						</Button>
						<span className="ngm-muted">Read again with each message in this conversation.</span>
					</div>
				))}
				{documents.map((document, index) => (
					// biome-ignore lint/suspicious/noArrayIndexKey: two files can share a name
					<div className="ngm-chip-line" key={index}>
						<Chip>{document.name}</Chip>
						<Button
							variant="quiet"
							onClick={() => setDocuments((known) => known.filter((_, at) => at !== index))}
						>
							Remove
						</Button>
						{policy && (
							<label className="ngm-inline ngm-counts-as">
								Counts as
								<Select
									value={documentClass(document, deps.settings.labels)}
									onChange={(event) => {
										const dataClass = event.target.value as DataClass
										setDocuments((known) =>
											known.map((each, at) => (at === index ? { ...each, dataClass } : each)),
										)
									}}
								>
									{DATA_CLASSES.map((each) => (
										<option key={each} value={each}>
											{CLASS_WORDS[each]}
										</option>
									))}
								</Select>
							</label>
						)}
						{document.truncated ? (
							<span className="ngm-muted">
								Very long: only the first part of the file can be read.
							</span>
						) : (
							document.text.length > chat.documentLimit && (
								<span className="ngm-muted">Long: it reads the parts closest to each message.</span>
							)
						)}
					</div>
				))}
				{personalFound.length > 0 && (
					<output className="ngm-chip-line ngm-policy-warning">
						<span>
							This message holds {personalFound.join(' and ')}, which may say who someone is. Your
							AI-use policy treats personal data differently, but this conversation does not count
							as personal.
						</span>
						<Button disabled={chat.busy} onClick={() => void chat.setCountsAs('personal')}>
							Count it as personal
						</Button>
					</output>
				)}
				{countsAs && (
					<div className="ngm-chip-line ngm-policy-warning">
						<span className="ngm-muted">
							This conversation counts as {CLASS_WORDS[countsAs].toLowerCase()}, as you said.
						</span>
						<Button
							variant="quiet"
							disabled={chat.busy}
							onClick={() => void chat.setCountsAs(undefined)}
						>
							Undo
						</Button>
					</div>
				)}
				{status && <output className="ngm-muted ngm-policy-status">{status}</output>}
				{(canLeave || keepHere) && (
					<div className="ngm-chip-line ngm-policy-warning">
						<label className="ngm-tool-switch">
							<Checkbox
								disabled={chat.busy}
								checked={keepHere}
								onChange={(event) => void chat.setKeepHere(event.target.checked)}
							/>
							<span>Keep this one on this computer</span>
						</label>
					</div>
				)}
				{voice.status.kind !== 'idle' && (
					<output className="ngm-voice-line">
						{voice.status.kind === 'listening' && <VoiceWave levels={voice.levels} />}
						{voice.status.kind === 'listening'
							? `Listening… ${clock(Date.now() - voice.status.since)}. Press the microphone again to write it down.`
							: voice.status.kind === 'writing'
								? 'Writing down what you said…'
								: voice.status.progress
									? `Getting voice ready: ${formatBytes(voice.status.progress.receivedBytes)} of ${formatBytes(voice.status.progress.totalBytes)}`
									: 'Getting voice ready…'}
					</output>
				)}
				{voice.problem && (
					<p className="ngm-error" role="alert">
						{voice.problem}
					</p>
				)}
				{voice.needsSetup && (
					<Dialog
						title="Speak instead of typing"
						onClose={voice.dismissSetup}
						actions={
							<>
								<Button onClick={voice.dismissSetup}>Cancel</Button>
								<Button
									variant="primary"
									onClick={() => voice.needsSetup && void voice.setUp(voice.needsSetup)}
								>
									Download {formatBytes(voice.needsSetup.sizeBytes)}
								</Button>
							</>
						}
					>
						<p>
							To turn what you say into text on this computer, NGOmate needs a voice model: a
							one-time download of {formatBytes(voice.needsSetup.sizeBytes)}. After that it works
							without the internet.
						</p>
						<p className="ngm-muted">
							What you say is turned into text here and then dropped. Nothing is recorded or sent
							anywhere. You can change or remove it under Built-in tools.
						</p>
					</Dialog>
				)}
				{/* One frame for the text and its actions, so no row of buttons sits under it. */}
				<div className="ngm-composer-box" ref={composerBox}>
					<TextArea
						aria-label="Message"
						value={text}
						rows={1}
						placeholder={task ? task.ask : 'Write a message'}
						onChange={(event) => setText(event.target.value)}
						onKeyDown={onKey}
					/>
					<div className="ngm-composer-actions">
						{voice.available && (
							<Button
								variant="quiet"
								className={`ngm-icon-button${voice.status.kind === 'listening' ? ' ngm-listening' : ''}`}
								aria-label={voice.status.kind === 'listening' ? 'Stop and write it down' : 'Speak'}
								aria-pressed={voice.status.kind === 'listening'}
								title={
									voice.status.kind === 'listening'
										? 'Stop and write it down'
										: 'Speak instead of typing'
								}
								disabled={voice.status.kind === 'writing' || voice.status.kind === 'getting-ready'}
								onClick={() => void voice.press()}
							>
								<Icon path={voice.status.kind === 'listening' ? ICONS.stop : ICONS.mic} />
							</Button>
						)}
						<Button
							variant="quiet"
							className="ngm-icon-button"
							aria-label="Attach document"
							title="Attach a document"
							onClick={attach}
							disabled={chat.busy}
						>
							<Icon path={ICONS.attach} />
						</Button>
						{chat.busy ? (
							<Button
								className="ngm-icon-button"
								aria-label="Stop"
								title="Stop"
								onClick={chat.stop}
							>
								<Icon path={ICONS.stop} />
							</Button>
						) : (
							<Button
								type="submit"
								variant="primary"
								className="ngm-icon-button"
								aria-label="Send"
								title="Send (Enter)"
							>
								<Icon path={ICONS.send} />
							</Button>
						)}
					</div>
				</div>
			</form>
		</div>
	)
}
