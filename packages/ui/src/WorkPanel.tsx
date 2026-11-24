import { type ReactNode, useEffect, useRef, useState } from 'react'
import { ICONS, Icon } from './icons.js'
import { startConversationDrag } from './TabBar.js'
import { usePrimitives } from './primitives.js'

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
}

type Conversation = { id: string; title: string; updatedAt: string }

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
				<div className="ngm-side-actions">
					<Button
						variant="quiet"
						className="ngm-icon-button"
						aria-label={`${isPinned ? 'Unpin' : 'Pin'} ${conversation.title}`}
						title={isPinned ? 'Unpin' : 'Pin'}
						aria-pressed={isPinned}
						onClick={() => onTogglePin(conversation.id)}
					>
						<Icon path={ICONS.pin} size={14} />
					</Button>
					<Button
						variant="quiet"
						className="ngm-icon-button"
						aria-label={`Open ${conversation.title} side by side`}
						title="Open side by side"
						disabled={!canSplit}
						onClick={() => onOpen(conversation.id, true)}
					>
						<Icon path={ICONS.split} size={14} />
					</Button>
					<Button
						variant="quiet"
						className="ngm-icon-button"
						aria-label={`Delete ${conversation.title}`}
						title="Delete"
						onClick={() => onDelete(conversation.id)}
					>
						<Icon path={ICONS.close} size={14} />
					</Button>
				</div>
			</div>
		)
	}

	const taskRow = (task: WorkTask) => (
		<Button variant="nav" key={task.key} title={task.title} onClick={task.run}>
			{task.label}
		</Button>
	)

	const section = (title: string, children: ReactNode, key = title) => (
		<section className="ngm-side-section" key={key}>
			<h3 className="ngm-side-title">{title}</h3>
			{children}
		</section>
	)

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
		list = conversations.length ? (
			byDay(conversations).map((day) => section(day.label, day.items.map(chatRow)))
		) : (
			<p className="ngm-work-empty">Your conversations will be listed here.</p>
		)
	} else if (group === 'tasks') {
		list = taskGroups
			.filter((taskGroup) => taskGroup.tasks.length)
			.map((taskGroup) => section(taskGroup.title, taskGroup.tasks.map(taskRow)))
	} else {
		list = (
			<p className="ngm-work-empty">
				Jobs are tasks that run on their own, such as a weekly status every Monday. They will be
				listed here.
			</p>
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
