import { type JobOutcome, type JobRun, describeChange, describeSchedule } from '@ngomate/core'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { RowActions } from './ActionMenu.js'
import { startConversationDrag } from './TabBar.js'
import { ICONS, Icon } from './icons.js'
import { usePrimitives } from './primitives.js'
import type { ListedJob } from './useJobs.js'

export type WorkGroup = 'chats' | 'tasks' | 'jobs'

/** What Find turned up in the full text: conversations by id, and notes by name. */
export type FoundText = { chats: string[]; notes: { name: string; team: boolean }[] }

/** One ready-made task as the panel lists it. */
export type WorkTask = {
	key: string
	label: ReactNode
	text: string
	title?: string
	run: () => void
	/** Change, copy, delete and the like, beside the task. */
	actions?: { label: string; onClick: () => void; ai?: boolean }[]
}

/** A chat making a task or job that is not saved yet, listed with them so it can be found again. */
export type WorkDraft = { id: string; title: string; kind: 'task' | 'job' }

type Conversation = { id: string; title: string; updatedAt: string }

/** What the Jobs list needs, and what it can ask for. */
export type WorkJobs = {
	list: ListedJob[]
	/** The jobs have been read once: before that, no run can be told from a chat. */
	loaded: boolean
	running: string | null
	/** Why the last thing asked of the jobs did not happen. */
	problem: string | null
	onNew: () => void
	onRun: (id: string) => void
	onPause: (id: string, paused: boolean) => void
	/** Changes the job in the form. */
	onEdit: (id: string) => void
	/** Changes the job in words, in the chat it was made in. */
	onChangeInWords: (id: string) => void
	onDelete: (id: string) => void
	onOpenRun: (id: string, conversationId: string) => void
	/** A held run whose team task changed: the person reads the task before it runs again. */
	onReadTask: (id: string) => void
	/** Makes or declines a change a run asked for. */
	onDecide: (id: string, ranAt: string, index: number, allow: boolean) => void
}

/** What a run came to, in words: one waiting on another member says whose decision it is. */
function outcomeLabel(run: JobRun, decidable: boolean): string {
	const outcome = outcomeOf(run)
	return outcome === 'waiting' && !decidable
		? `Waiting for ${run.by ?? 'another member'}`
		: OUTCOME[outcome]
}

/** What a run came to, now: a run whose changes were all decided no longer waits. */
function outcomeOf(run: JobRun): JobOutcome {
	if (run.outcome === 'waiting' && !run.changes?.some((change) => change.decision === 'waiting'))
		return 'done'
	return run.outcome
}

const OUTCOME: Record<JobOutcome, string> = {
	done: 'Done',
	warnings: 'Check it',
	waiting: 'Needs you',
	held: 'On hold',
	failed: 'Failed',
}

const shortTime = (iso: string) =>
	new Date(iso).toLocaleString(undefined, {
		weekday: 'short',
		day: 'numeric',
		month: 'short',
		hour: '2-digit',
		minute: '2-digit',
	})

/** A team job made in another time zone says so; in this computer's own zone it says nothing. */
const zoneNote = (zone: string | undefined) =>
	zone && zone !== Intl.DateTimeFormat().resolvedOptions().timeZone ? ` (${zone} time)` : ''

/** A run's time, short enough for the panel's width. */
const runTime = (iso: string) =>
	new Date(iso).toLocaleString(undefined, {
		day: 'numeric',
		month: 'short',
		hour: '2-digit',
		minute: '2-digit',
	})

/** A job's run is kept as the conversation `job-<id>-run-<time>-<random>`: the id, or null for a chat. */
export function jobOfRun(conversationId: string): string | null {
	return conversationId.match(/^job-(.+)-run-[a-z0-9]+-[a-z0-9]+$/)?.[1] ?? null
}

/** A sentence that ends in a full stop, whatever it was given. */
const sentence = (text: string) => (/[.!?]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`)

/** Runs shown under a job. Older ones stay in its file and in Find. */
const RUNS_SHOWN = 5

const GROUPS: { id: WorkGroup; label: string }[] = [
	{ id: 'chats', label: 'Chats' },
	{ id: 'tasks', label: 'Tasks' },
	{ id: 'jobs', label: 'Jobs' },
]

/** Today, Yesterday, the last seven days, then everything before. */
export function byDay(
	conversations: Conversation[],
	now = new Date(),
): { label: string; items: Conversation[] }[] {
	const startOf = (days: number) => {
		const day = new Date(now)
		day.setHours(0, 0, 0, 0)
		day.setDate(day.getDate() - days)
		return day.getTime()
	}
	const bounds = [
		{ label: 'Today', from: startOf(0) },
		{ label: 'Yesterday', from: startOf(1) },
		{ label: 'Last 7 days', from: startOf(7) },
		{ label: 'Earlier', from: Number.NEGATIVE_INFINITY },
	]
	const groups = bounds.map((bound) => ({ label: bound.label, items: [] as Conversation[] }))
	for (const conversation of conversations) {
		const at = Date.parse(conversation.updatedAt)
		const index = bounds.findIndex((bound) => (Number.isNaN(at) ? false : at >= bound.from))
		groups[index === -1 ? groups.length - 1 : index]?.items.push(conversation)
	}
	return groups.filter((group) => group.items.length)
}

/** Every word of the query somewhere in the texts, in any case. */
export function matches(query: string, ...texts: string[]): boolean {
	const words = query.toLowerCase().split(/\s+/).filter(Boolean)
	const haystack = texts.join(' ').toLowerCase()
	return words.every((word) => haystack.includes(word))
}

/**
 * The work: every conversation, the ready-made tasks and, later, jobs that run on a schedule, with one
 * field to find any of them. Beside the conversation, on the right, apart from what is set up once.
 */
export function WorkPanel({
	conversations,
	shownId,
	pinned,
	taskGroups,
	group,
	onGroup,
	collapsed,
	onToggle,
	canSplit,
	onOpen,
	onTogglePin,
	onDelete,
	onFind,
	findIn,
	onOpenNotes,
	findRequest,
	jobs,
	drafts = [],
	onNewTask,
}: {
	conversations: Conversation[]
	shownId: string | null
	pinned: string[]
	taskGroups: { title: string; tasks: WorkTask[] }[]
	group: WorkGroup
	onGroup: (group: WorkGroup) => void
	collapsed: boolean
	onToggle: () => void
	canSplit: boolean
	onOpen: (id: string, beside?: boolean) => void
	onTogglePin: (id: string) => void
	onDelete: (id: string) => void
	/** Opens the panel if folded and puts the typing in its field, as ⌘K does. */
	onFind: () => void
	/** Searches what the conversations and notes say, beyond their titles. */
	findIn: (query: string) => Promise<FoundText>
	onOpenNotes: () => void
	/** Counts up each time the person asks to find something, from anywhere. */
	findRequest: number
	/** Left out when the host keeps no jobs. */
	jobs?: WorkJobs
	drafts?: WorkDraft[]
	/** Left out when the host keeps no tasks of the person's own. */
	onNewTask?: () => void
}) {
	const { Button, Input } = usePrimitives()
	const [query, setQuery] = useState('')
	const [found, setFound] = useState<{ query: string; text: FoundText } | null>(null)
	const finding = query.trim()
	// Typing settles first: each search reads the conversations and notes it has not read yet.
	useEffect(() => {
		if (!finding) return
		let current = true
		const timer = setTimeout(() => {
			findIn(finding).then(
				(text) => {
					if (current) setFound({ query: finding, text })
				},
				() => {},
			)
		}, 200)
		return () => {
			current = false
			clearTimeout(timer)
		}
	}, [finding, findIn])
	const field = useRef<HTMLDivElement>(null)
	// Each request once: opening the panel again later must not take the typing.
	const handled = useRef(0)
	useEffect(() => {
		if (findRequest > handled.current && !collapsed) {
			handled.current = findRequest
			field.current?.querySelector('input')?.focus()
		}
	}, [findRequest, collapsed])

	const iconButton = (label: string, path: string, onClick: () => void) => (
		<Button
			variant="quiet"
			className="ngm-icon-button"
			aria-label={label}
			title={label}
			onClick={onClick}
		>
			<Icon path={path} />
		</Button>
	)

	if (collapsed) {
		return (
			<aside className="ngm-work ngm-work-collapsed" aria-label="Your work">
				{iconButton('Show your work', ICONS.panelRight, onToggle)}
				{iconButton('Find (⌘K)', ICONS.search, onFind)}
			</aside>
		)
	}

	const chatRow = (conversation: Conversation) => {
		const isPinned = pinned.includes(conversation.id)
		return (
			<div
				className="ngm-side-item"
				key={conversation.id}
				draggable
				title="Drag onto a tab bar to open it there"
				onDragStart={(event) => startConversationDrag(event, conversation.id)}
			>
				<Button
					variant="nav"
					active={conversation.id === shownId}
					onClick={() => onOpen(conversation.id)}
				>
					{conversation.title}
				</Button>
				<RowActions
					label={`Actions for ${conversation.title}`}
					items={[
						{ label: isPinned ? 'Unpin' : 'Pin', onSelect: () => onTogglePin(conversation.id) },
						{
							label: 'Open side by side',
							disabled: !canSplit,
							onSelect: () => onOpen(conversation.id, true),
						},
						{ label: 'Delete', onSelect: () => onDelete(conversation.id) },
					]}
				/>
			</div>
		)
	}

	const taskRow = (task: WorkTask) =>
		task.actions?.length ? (
			<div className="ngm-side-item" key={task.key}>
				<Button variant="nav" title={task.title} onClick={task.run}>
					{task.label}
				</Button>
				<RowActions
					label={`Actions for ${task.text}`}
					items={task.actions.map((action) => ({
						label: action.label,
						onSelect: action.onClick,
						ai: action.ai,
					}))}
				/>
			</div>
		) : (
			<Button variant="nav" key={task.key} title={task.title} onClick={task.run}>
				{task.label}
			</Button>
		)

	/** Chats making something not saved yet, at the top of its list, so they are not lost. */
	const draftRows = (kind: WorkDraft['kind']) => {
		const mine = drafts.filter((draft) => draft.kind === kind)
		return mine.length
			? section(
					'Being made',
					mine.map((draft) => (
						<Button
							variant="nav"
							key={draft.id}
							active={draft.id === shownId}
							title="Open the chat where it is being made"
							onClick={() => onOpen(draft.id)}
						>
							{draft.title}
							<span className="ngm-muted"> · draft</span>
						</Button>
					)),
					`drafts-${kind}`,
				)
			: null
	}

	const section = (title: string, children: ReactNode, key = title) => (
		<section className="ngm-side-section" key={key}>
			<h3 className="ngm-side-title">{title}</h3>
			{children}
		</section>
	)

	const jobSection = (item: ListedJob, jobs: WorkJobs) => {
		const { job, state } = item
		const title = job?.title ?? item.id
		// A team job's run is kept as a conversation only on the computer that ran it; elsewhere its
		// result is the team note it wrote.
		const here = (run: JobRun) =>
			Boolean(run.conversationId) &&
			conversations.some((conversation) => conversation.id === run.conversationId)
		const latest = state?.runs.find(here)
		const latestNote = state?.runs.find((run) => run.note)
		// The rule the runner itself goes by, so the list never says one is running that would be taken over.
		const claimedBy = item.claimedBy
		// This person's own runs are decided anywhere; a team run's change only where it ran, through that
		// computer's connectors.
		const decidable = (run: JobRun) => !item.team || here(run)
		const name = item.team ? `${title} (team)` : title
		const status = !job
			? `This job's file cannot be used: ${sentence(item.problem ?? '')} Delete it to remove it.`
			: jobs.running === item.key
				? 'Running now…'
				: claimedBy
					? `Running on ${claimedBy}'s computer…`
					: state?.paused
						? `Paused. ${describeSchedule(job.schedule)}.`
						: state?.problem
							? `Could not run: ${sentence(state.problem)} Tries again ${shortTime(state.nextDue)}.`
							: `${describeSchedule(job.schedule)}${zoneNote(job.zone)}. Next: ${state ? shortTime(state.nextDue) : 'not known'}.`
		const held = state?.runs[0]?.outcome === 'held' ? state.runs[0] : null
		const by = (run: JobRun) => (item.team && run.by ? ` · ${run.by}` : '')
		return (
			<section className="ngm-side-section" key={item.key} aria-label={name}>
				<div className="ngm-side-item">
					<Button
						variant="nav"
						// Opens what it made. Starting a run is Run now's alone, so a click on a name never asks
						// the model anything.
						title={
							latest
								? 'Open its latest result'
								: latestNote
									? 'Open the notes it writes'
									: 'No result yet'
						}
						disabled={!latest && !latestNote}
						onClick={() =>
							latest?.conversationId
								? jobs.onOpenRun(item.key, latest.conversationId)
								: onOpenNotes()
						}
					>
						<strong>{title}</strong>
						{item.team && <span className="ngm-muted"> · team</span>}
					</Button>
					<RowActions
						label={`Actions for ${name}`}
						items={[
							// The assistant's route first: in NGOmate it is always the preferred one.
							...(job
								? [
										{
											label: 'Change in chat',
											ai: true,
											onSelect: () => jobs.onChangeInWords(item.key),
										},
									]
								: []),
							...(job && !state?.paused
								? [
										{
											// Why it cannot run now is said in its place.
											label:
												jobs.running !== null && jobs.running !== item.key
													? 'Run now (another job is running)'
													: jobs.running === item.key
														? 'Running now'
														: claimedBy
															? `Running on ${claimedBy}'s computer`
															: 'Run now',
											disabled: jobs.running !== null || claimedBy !== null,
											onSelect: () => jobs.onRun(item.key),
										},
									]
								: []),
							...(job && state
								? [
										{
											label: state.paused ? 'Resume' : 'Pause',
											onSelect: () => jobs.onPause(item.key, !state.paused),
										},
									]
								: []),
							...(job ? [{ label: 'Edit', onSelect: () => jobs.onEdit(item.key) }] : []),
							{
								label: item.team ? 'Delete for the whole team…' : 'Delete',
								onSelect: () => jobs.onDelete(item.key),
							},
						]}
					/>
				</div>
				<p className="ngm-side-note">{status}</p>
				{held?.reason && <p className="ngm-side-note">{held.reason}</p>}
				{held?.waitsFor === 'task' && (
					<Button variant="nav" onClick={() => jobs.onReadTask(item.key)}>
						Read the changed task
					</Button>
				)}
				{state?.runs.slice(0, RUNS_SHOWN).flatMap((run) =>
					(run.changes ?? []).map((change, index) =>
						change.decision !== 'waiting' ? null : decidable(run) ? (
							<div className="ngm-job-change" key={`${run.ranAt}/${index}`}>
								{/* In full: what is allowed here is made exactly as asked. */}
								<p className="ngm-side-note">
									Asked to change: {describeChange(change, Number.POSITIVE_INFINITY)}
								</p>
								{change.error && (
									<p className="ngm-error" role="alert">
										{change.error}
									</p>
								)}
								<div className="ngm-row">
									<Button
										variant="primary"
										aria-label={`Allow ${change.tool}`}
										onClick={() => jobs.onDecide(item.key, run.ranAt, index, true)}
									>
										Allow
									</Button>
									<Button
										aria-label={`Don't allow ${change.tool}`}
										onClick={() => jobs.onDecide(item.key, run.ranAt, index, false)}
									>
										Don't allow
									</Button>
								</div>
							</div>
						) : (
							// Made through the connectors of the computer that ran it, so decided there.
							<p className="ngm-side-note" key={`${run.ranAt}/${index}`}>
								Asked to change: {describeChange(change)}. Waiting for{' '}
								{run.by ?? 'the member who ran it'}.
							</p>
						),
					),
				)}
				{state?.runs
					.filter((run) => run.outcome !== 'held')
					.slice(0, RUNS_SHOWN)
					.map((run) =>
						here(run) ? (
							<Button
								variant="nav"
								key={run.ranAt}
								title={run.reason ?? (run.note ? `Written to the note ${run.note}` : undefined)}
								onClick={() => run.conversationId && jobs.onOpenRun(item.key, run.conversationId)}
							>
								{runTime(run.ranAt)} · {outcomeLabel(run, decidable(run))}
								{by(run)}
								{!item.team && !run.seen && <span className="ngm-muted"> · new</span>}
							</Button>
						) : run.note ? (
							<Button
								variant="nav"
								key={run.ranAt}
								title={`Written to the ${item.team || job?.destination.kind === 'team-note' ? 'team note' : 'note'} ${run.note}`}
								onClick={onOpenNotes}
							>
								{runTime(run.ranAt)} · {outcomeLabel(run, decidable(run))}
								{by(run)}
							</Button>
						) : (
							<p className="ngm-side-note" key={run.ranAt}>
								{runTime(run.ranAt)} · {outcomeLabel(run, decidable(run))}
								{by(run)}
								{run.reason ? `: ${run.reason}` : ''}
							</p>
						),
					)}
			</section>
		)
	}

	let list: ReactNode
	if (finding) {
		const text = found?.query === finding ? found.text : null
		const chats = conversations.filter(
			(conversation) =>
				matches(finding, conversation.title) || text?.chats.includes(conversation.id),
		)
		const tasks = taskGroups.flatMap((taskGroup) =>
			taskGroup.tasks.filter((task) => matches(finding, task.text, task.title ?? '')),
		)
		const notes = text?.notes ?? []
		list =
			chats.length || tasks.length || notes.length ? (
				<>
					{chats.length > 0 && section('Chats', chats.map(chatRow))}
					{tasks.length > 0 && section('Tasks', tasks.map(taskRow))}
					{notes.length > 0 &&
						section(
							'Notes',
							notes.map((note) => (
								<Button
									variant="nav"
									key={`${note.team ? 'team' : 'own'}/${note.name}`}
									onClick={onOpenNotes}
								>
									{note.name}
									{note.team && <span className="ngm-muted"> · team</span>}
								</Button>
							)),
						)}
				</>
			) : !text ? (
				<p className="ngm-work-empty">Looking…</p>
			) : (
				<p className="ngm-work-empty">Nothing found for “{finding}”.</p>
			)
	} else if (group === 'chats') {
		// A job's runs are listed under it; once the job is deleted they are chats like any other. Until
		// the jobs are read, a run is left out rather than shown for a moment and taken away again.
		const jobIds = new Set(jobs?.list.map((item) => item.id))
		const chats = conversations.filter((conversation) => {
			const job = jobOfRun(conversation.id)
			return job === null || (jobs?.loaded === true && !jobIds.has(job))
		})
		list = chats.length ? (
			byDay(chats).map((day) => section(day.label, day.items.map(chatRow)))
		) : (
			<p className="ngm-work-empty">Your conversations will be listed here.</p>
		)
	} else if (group === 'tasks') {
		list = (
			<>
				{onNewTask && <Button onClick={onNewTask}>New task…</Button>}
				{draftRows('task')}
				{taskGroups
					.filter((taskGroup) => taskGroup.tasks.length)
					.map((taskGroup) => section(taskGroup.title, taskGroup.tasks.map(taskRow)))}
			</>
		)
	} else if (!jobs) {
		list = (
			<p className="ngm-work-empty">
				Jobs are tasks that run on their own, such as a weekly status every Monday. This app cannot
				run jobs.
			</p>
		)
	} else {
		list = (
			<>
				<Button onClick={jobs.onNew}>New job…</Button>
				{draftRows('job')}
				{jobs.problem && (
					<p className="ngm-error" role="alert">
						{jobs.problem}
					</p>
				)}
				{jobs.list.length === 0 && (
					<p className="ngm-work-empty">
						A job runs a ready-made task on a schedule, such as new funding every Monday, while this
						app is open, and writes the result to a note.
					</p>
				)}
				{jobs.list.map((item) => jobSection(item, jobs))}
			</>
		)
	}

	return (
		<aside className="ngm-work" aria-label="Your work">
			<div className="ngm-work-head">
				<div className="ngm-work-find" ref={field}>
					<Input
						type="search"
						placeholder="Find…  ⌘K"
						aria-label="Find chats, tasks and notes"
						value={query}
						onChange={(event) => setQuery(event.target.value)}
						onKeyDown={(event) => {
							if (event.key === 'Escape') setQuery('')
						}}
					/>
				</div>
				{iconButton('Hide your work', ICONS.panelRight, onToggle)}
			</div>
			{!finding && (
				<div className="ngm-work-groups">
					{GROUPS.map((each) => (
						<Button
							variant="nav"
							key={each.id}
							active={each.id === group}
							aria-pressed={each.id === group}
							onClick={() => onGroup(each.id)}
						>
							{each.label}
						</Button>
					))}
				</div>
			)}
			<div className="ngm-side-scroll ngm-work-list">{list}</div>
		</aside>
	)
}
