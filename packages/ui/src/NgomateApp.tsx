import {
	DEFAULT_TEAM_LIMITS,
	type PromptDefinition,
	type TaskFile,
	TeamConflict,
	createTeamJobStore,
	destinationNote,
	isTimeZone,
	jobId,
	saveTeamTask,
	serializeTaskFile,
} from '@ngomate/core'
import {
	type CSSProperties,
	Fragment,
	type ReactNode,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from 'react'
import { RowActions } from './ActionMenu.js'
import { AddonsPanel } from './AddonsPanel.js'
import { Chat, type ChatMaking, type ChatStart } from './Chat.js'
import { MakeChooser } from './DraftCard.js'
import { JobDialog, noteNameProblem } from './JobDialog.js'
import { ProfileMenu } from './ProfileMenu.js'
import { SettingsPage, type SettingsSection } from './Settings.js'
import { TabBar, startConversationDrag } from './TabBar.js'
import { TaskDialog, type TaskForm } from './TaskDialog.js'
import { TeamPanel } from './TeamPanel.js'
import { ToolsPanel } from './ToolsPanel.js'
import { UpdateNotice } from './UpdateNotice.js'
import { type FoundText, type WorkDraft, WorkPanel, type WorkTask, matches } from './WorkPanel.js'
import {
	type Draft,
	type JobDraft,
	NEW_TASK,
	type TaskDraft,
	draftFromJob,
	draftFromTask,
	emptyDraft,
	jobFromDraft,
	taskFromDraft,
} from './drafts.js'
import { makeId, promptLabel } from './format.js'
import { DEFAULT_SETTINGS, type MenuCommand, type NgomateHost, type Settings } from './host.js'
import { ICONS, Icon } from './icons.js'
import {
	type Layout,
	MAX_PANES,
	activeId,
	closeTab,
	focusTab,
	openBeside,
	openTab,
	placeTab,
	replaceActive,
	restoreLayout,
	singleLayout,
	storeLayout,
} from './layout.js'
import { MemoryPanel, ModelPanel } from './panels.js'
import {
	DEFAULT_PRIMITIVES,
	type NgomatePrimitives,
	type NgomateTheme,
	PrimitivesProvider,
	themeVariables,
	usePrimitives,
} from './primitives.js'
import { selectAllInConversation } from './select-all.js'
import { useIdleUnload } from './useIdleUnload.js'
import { useJobs } from './useJobs.js'
import { OWN_TASK_PREFIX, isOwnTask, useOwnTasks } from './useOwnTasks.js'
import { type TeamTask, useTeam } from './useTeam.js'

/** The conversations, the notes, or the settings. */
/** A page of what is set up once, open in a tab like a conversation. */
type Page = SettingsSection | 'memory'
const PAGE_PREFIX = 'page:'
/** Below this, both panels open leave the conversation too little room. */
const NARROW_WINDOW = '(max-width: 1000px)'
const PAGE_TITLES: Record<Page, string> = {
	you: 'You',
	model: 'Model',
	addons: 'Connectors',
	tools: 'Built-in tools',
	memory: 'Notes',
	team: 'Teams',
	about: 'About',
}
const pageTab = (page: Page) => `${PAGE_PREFIX}${page}`
function pageOf(id: string | undefined): Page | null {
	const page = id?.startsWith(PAGE_PREFIX) ? id.slice(PAGE_PREFIX.length) : null
	return page && page in PAGE_TITLES ? (page as Page) : null
}

const newestFirst = <T extends { updatedAt: string }>(listed: T[]) =>
	[...listed].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))

type ConnectorPrompt = PromptDefinition & {
	/** The connector it comes from, as named under Connectors. */
	source: string
	run: (args: Record<string, string>) => Promise<string>
}

function PromptForm({
	prompt,
	onCancel,
	onReady,
}: { prompt: ConnectorPrompt; onCancel: () => void; onReady: (text: string) => void }) {
	const { Button, Input } = usePrimitives()
	const [values, setValues] = useState<Record<string, string>>({})
	const [problem, setProblem] = useState<string | null>(null)
	return (
		<form
			className="ngm-form ngm-card"
			onSubmit={async (event) => {
				event.preventDefault()
				try {
					onReady(await prompt.run(values))
				} catch (err) {
					setProblem(err instanceof Error ? err.message : String(err))
				}
			}}
		>
			<strong>{promptLabel(prompt)}</strong>
			{prompt.arguments.map((argument) => (
				<label key={argument.name}>
					{argument.description || argument.name}
					<Input
						required={argument.required}
						value={values[argument.name] ?? ''}
						onChange={(event) => setValues({ ...values, [argument.name]: event.target.value })}
					/>
				</label>
			))}
			{problem && (
				<p className="ngm-error" role="alert">
					{problem}
				</p>
			)}
			<div className="ngm-row">
				<Button type="submit" variant="primary">
					Use
				</Button>
				<Button onClick={onCancel}>Cancel</Button>
			</div>
		</form>
	)
}

export type NgomateAppProps = {
	host: NgomateHost
	/** Inside another app, which already shows its own name. */
	embedded?: boolean
	/** Colors and fonts. Anything left out comes from a parent element. */
	theme?: NgomateTheme
	/** The host's own controls, for any it wants to replace. */
	primitives?: Partial<NgomatePrimitives>
}

export function NgomateApp({ theme, primitives, ...props }: NgomateAppProps) {
	const merged = useMemo(() => ({ ...DEFAULT_PRIMITIVES, ...primitives }), [primitives])
	const root = useRef<HTMLDivElement>(null)
	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if (root.current) selectAllInConversation(event, root.current)
		}
		document.addEventListener('keydown', onKey)
		return () => document.removeEventListener('keydown', onKey)
	}, [])
	return (
		<PrimitivesProvider value={merged}>
			<div ref={root} className="ngm-app" style={themeVariables(theme) as CSSProperties}>
				<AppContent {...props} />
			</div>
		</PrimitivesProvider>
	)
}

function AppContent({ host, embedded = false }: Pick<NgomateAppProps, 'host' | 'embedded'>) {
	const { Button, Dialog } = usePrimitives()
	const [settings, setSettings] = useState<Settings | null>(null)
	const [layout, setLayout] = useState<Layout>(() => singleLayout(makeId('chat')))
	const [conversations, setConversations] = useState<
		{ id: string; title: string; updatedAt: string }[]
	>([])
	// For the conversation it was meant for only: other tabs stay as they are.
	const [start, setStart] = useState<{ id: string; begin: ChatStart } | null>(null)
	const [prompts, setPrompts] = useState<ConnectorPrompt[]>([])
	const [openPrompt, setOpenPrompt] = useState<ConnectorPrompt | null>(null)
	// A team task anyone in the team can change is shown before it runs for the first time after a change.
	const [checkTask, setCheckTask] = useState<TeamTask | null>(null)
	// An invite link opened from outside, waiting for the person on the Team page.
	const [incomingInvite, setIncomingInvite] = useState<string | null>(null)
	const openPageRef = useRef<(page: Page) => void>(() => {})
	useEffect(
		() =>
			host.team?.onInvite?.((link) => {
				setIncomingInvite(link)
				openPageRef.current('team')
			}),
		[host],
	)

	// The kept layout is saved again only once it has been read, or the fresh one would replace it.
	const [restored, setRestored] = useState(false)

	const refreshConversations = useCallback(async () => {
		setConversations(newestFirst(await host.listConversations()))
	}, [host])

	useEffect(() => {
		let current = true
		Promise.all([host.loadSettings(), host.listConversations()]).then(([loaded, listed]) => {
			if (!current) return
			setSettings(loaded)
			setConversations(newestFirst(listed))
			const kept = restoreLayout(
				loaded.layout,
				(id) => pageOf(id) !== null || listed.some((saved) => saved.id === id),
			)
			if (kept) setLayout(kept)
			setRestored(true)
		})
		return () => {
			current = false
		}
	}, [host])

	const updateSettings = useCallback(
		(next: Settings) => {
			setSettings(next)
			host.saveSettings(next)
		},
		[host],
	)

	// Saved when the person changes it, not for what was just opened.
	const settingsRef = useRef(settings)
	settingsRef.current = settings
	const keptLayout = useRef<string | null>(null)
	useEffect(() => {
		const current = settingsRef.current
		if (!restored || !current) return
		const layoutNow = storeLayout(layout)
		const json = JSON.stringify(layoutNow)
		const before = keptLayout.current
		keptLayout.current = json
		if (before !== null && before !== json) updateSettings({ ...current, layout: layoutNow })
	}, [layout, restored, updateSettings])

	const addons = settings?.addons
	// biome-ignore lint/correctness/useExhaustiveDependencies: asks again when connectors change
	useEffect(() => {
		const enabled = addons?.filter((addon) => addon.enabled) ?? []
		if (!enabled.length) {
			setPrompts([])
			return
		}
		let current = true
		;(async () => {
			const found: ConnectorPrompt[] = []
			for (const addon of enabled) {
				try {
					const source = await host.connectAddon(addon)
					try {
						for (const prompt of (await source.listPrompts?.()) ?? []) {
							found.push({
								...prompt,
								source: addon.name,
								run: async (args) => {
									const connected = await host.connectAddon(addon)
									try {
										return (await connected.getPrompt?.(prompt.name, args)) ?? ''
									} finally {
										await connected.close()
									}
								},
							})
						}
					} finally {
						await source.close()
					}
				} catch {
					// A connector that is down is reported when a message uses it.
				}
			}
			if (current) setPrompts(found)
		})()
		return () => {
			current = false
		}
	}, [host, JSON.stringify(addons)])

	const models = host.models
	// Whatever is chosen now: a local model used earlier still has to go.
	const idleBusy = useIdleUnload(models ? () => models.stop() : undefined)
	// Conversations being answered now: a job waits until none is.
	const chatsBusy = useRef(0)
	const onBusyChange = useCallback(
		(busy: boolean) => {
			chatsBusy.current = Math.max(0, chatsBusy.current + (busy ? 1 : -1))
			idleBusy(busy)
		},
		[idleBusy],
	)

	const getModel = useCallback(async () => {
		const choice = settings?.model
		if (!choice) throw new Error('Choose a model first, under Model.')
		if (choice.kind === 'server') {
			const key = await host.getSecret('model-server')
			return { client: host.createModelClient(choice.baseUrl, choice.model, key ?? undefined) }
		}
		if (!host.models)
			throw new Error('This app cannot run a local model. Choose a model server under Model.')
		// Asked every time: the host reuses a running model, and restarts one that has died.
		const { baseUrl, apiKey, contextTokens, searchKnowledgeFirst } = await host.models.start(
			choice.id,
		)
		return {
			client: host.createModelClient(baseUrl, choice.id, apiKey),
			contextTokens,
			searchKnowledgeFirst,
		}
	}, [host, settings?.model])

	const team = useTeam(host, settings?.addons)
	const teamNotes = team.notes

	// What each conversation and note says, read for Find the first time it searches and again only
	// once it changed. Kept in this window only.
	const readForFind = useRef(new Map<string, { version: string; text: string }>())
	const findIn = useCallback(
		async (query: string): Promise<FoundText> => {
			const cache = readForFind.current
			const textOf = async (key: string, version: string, read: () => Promise<string>) => {
				const kept = cache.get(key)
				if (kept?.version === version) return kept.text
				const text = await read().catch(() => '')
				cache.set(key, { version, text })
				return text
			}
			const chats: string[] = []
			for (const conversation of conversations) {
				const text = await textOf(`chat:${conversation.id}`, conversation.updatedAt, async () => {
					const full = await host.readConversation(conversation.id)
					return (full?.messages ?? [])
						.filter((message) => message.role === 'user' || message.role === 'assistant')
						.map((message) => message.content ?? '')
						.join('\n')
				})
				if (matches(query, conversation.title, text)) chats.push(conversation.id)
			}
			const notes: FoundText['notes'] = []
			for (const note of await host.memory.list().catch(() => [])) {
				const text = await textOf(
					`note:${note.name}`,
					`${note.updatedAt}/${note.chars}`,
					async () => (await host.memory.read(note.name)) ?? '',
				)
				if (matches(query, note.name, text)) notes.push({ name: note.name, team: false })
			}
			// Team notes through the read a conversation uses: kept copies, only changed notes fetched.
			for (const note of (await teamNotes?.readAll().catch(() => [])) ?? []) {
				if (matches(query, note.name, note.text)) notes.push({ name: note.name, team: true })
			}
			return { chats, notes }
		},
		[host, conversations, teamNotes],
	)
	// Two teams can each have a task file of the same name.
	const seenKey = (item: TeamTask) => `${team.activeId}/${item.task.id}`
	const teamAddonId = team.location?.type === 'connector' ? team.location.addonId : undefined
	const teamTasks = useMemo(() => team.tasks.map((item) => item.task), [team.tasks])
	const deps = useMemo(
		() => ({
			host,
			settings: settings ?? DEFAULT_SETTINGS,
			getModel,
			onSaved: refreshConversations,
			onBusyChange,
			team: teamNotes ? { notes: teamNotes, tasks: teamTasks, addonId: teamAddonId } : undefined,
		}),
		[
			host,
			settings,
			getModel,
			refreshConversations,
			onBusyChange,
			teamNotes,
			teamTasks,
			teamAddonId,
		],
	)

	// A job keeps the model loaded while it runs, without counting as a conversation it would wait for.
	const own = useOwnTasks(host)
	// The built-in tasks and the person's own: what a chat or a job can run, beside the team's.
	const allTasks = useMemo(() => [...host.tasks, ...own.tasks], [host.tasks, own.tasks])
	// Set once the conversation list's own delete is defined, further down.
	const removeRunRef = useRef<(id: string) => Promise<void>>(async () => {})
	const teamConnectors = useMemo(
		() => (team.file?.connectors ?? []).map((item) => item.url),
		[team.file?.connectors],
	)
	const jobDeps = useMemo(
		() =>
			settings
				? {
						chat: { ...deps, onBusyChange: idleBusy },
						tasks: allTasks,
						teamTasks: team.tasks,
						teamId: team.activeId ?? undefined,
						teamConnectors,
					}
				: null,
		[settings, deps, idleBusy, allTasks, team.tasks, team.activeId, teamConnectors],
	)
	// A team shares jobs only on S3 or WebDAV, where a write over a changed file is refused at the
	// storage itself: that is what lets one member's computer claim a run. A synced folder only refuses
	// on this computer's copy, which the others' sync apps see minutes later, and a connector's team tools
	// hold notes and tasks only.
	const teamLimits = useRef(DEFAULT_TEAM_LIMITS)
	teamLimits.current = team.file?.limits ?? DEFAULT_TEAM_LIMITS
	const sharedStorage = team.location?.type === 's3' || team.location?.type === 'webdav'
	// biome-ignore lint/correctness/useExhaustiveDependencies: the active team decides which jobs these are
	const teamJobStore = useMemo(
		() =>
			team.store && team.refusesOverwrites && sharedStorage
				? createTeamJobStore(team.store, () => teamLimits.current)
				: null,
		// Made again only for another team: the host's store is one object for every team, and the team
		// file, read anew on every refresh, must not restart a run.
		[team.store, team.refusesOverwrites, sharedStorage, team.activeId],
	)
	const jobs = useJobs(
		host,
		jobDeps,
		() => chatsBusy.current > 0,
		teamJobStore,
		settings?.yourName?.trim() || 'Someone',
		(ids) => {
			// Deleted one by one, as from the list, so a tab or pin of one goes with it.
			for (const id of ids) void removeRunRef.current(id).catch(() => {})
		},
	)
	// New task or New job: say it in words, or fill in the form.
	const [chooser, setChooser] = useState<Draft['kind'] | null>(null)
	// The two forms, filled in or empty, and who waits for what was saved in them.
	type Saved = { key: string; title: string }
	const [taskForm, setTaskForm] = useState<{
		title: string
		initial?: TaskDraft
		forTeam?: boolean
		editing?: string
		editingVersion?: string | null
		done?: (saved: Saved | null) => void
	} | null>(null)
	const [jobForm, setJobForm] = useState<{
		initial?: JobDraft
		editing?: string
		done?: (saved: Saved | null) => void
	} | null>(null)
	const formSaved = useRef<Saved | null>(null)
	// A task of the person's own about to be deleted, and a job that still runs it.
	const [deleteTask, setDeleteTask] = useState<string | null>(null)
	const [deleteProblem, setDeleteProblem] = useState<string | null>(null)
	// A job held because its team task changed, waiting for the person to read the task.
	const [readJobTask, setReadJobTask] = useState<string | null>(null)
	// A team job about to be deleted for everyone, waiting for the person to confirm.
	const [deleteJob, setDeleteJob] = useState<string | null>(null)

	const saved = (id: string) => conversations.some((conversation) => conversation.id === id)
	/** A tab that holds nothing yet makes way, rather than staying open beside what comes next. */
	const showHere = (current: Layout, id: string) => {
		const shown = activeId(current)
		const blank =
			shown &&
			!saved(shown) &&
			!pageOf(shown) &&
			!current.panes.some((pane) => pane.tabs.includes(id))
		return blank ? replaceActive(current, id) : openTab(current, id)
	}
	/** A page opens once: asked again, its tab comes to the front wherever it is. */
	const openPage = (page: Page) => setLayout((current) => showHere(current, pageTab(page)))
	openPageRef.current = openPage

	const startNew = (begin: ChatStart | null = null, beside = false) => {
		const id = makeId('chat')
		setLayout((current) => (beside ? openBeside(current, id) : showHere(current, id)))
		setStart(begin ? { id, begin } : null)
	}

	const show = (id: string, beside = false) => {
		setLayout((current) => (beside ? openBeside(current, id) : showHere(current, id)))
	}

	const focusPane = (index: number) =>
		setLayout((current) =>
			index === current.focused
				? current
				: focusTab(current, index, current.panes[index]?.active ?? ''),
		)

	const close = (id: string) =>
		setLayout((current) => closeTab(current, id) ?? singleLayout(makeId('chat')))

	const clearStart = useCallback(() => setStart(null), [])
	const titleOf = (id: string) => {
		const page = pageOf(id)
		if (page) return PAGE_TITLES[page]
		return conversations.find((conversation) => conversation.id === id)?.title ?? 'New conversation'
	}
	const shown = activeId(layout)

	// Menu commands that a page or the conversation in front carries out: each new request counts up.
	const [requests, setRequests] = useState({ attach: 0, update: 0 })
	// On a narrow window the work panel folds by itself; opened there, it stays open until the width
	// changes. What the person chose for a wide window is kept as it was.
	const [narrow, setNarrow] = useState(
		() => typeof window.matchMedia === 'function' && window.matchMedia(NARROW_WINDOW).matches,
	)
	const [openedNarrow, setOpenedNarrow] = useState(false)
	useEffect(() => {
		if (typeof window.matchMedia !== 'function') return
		const query = window.matchMedia(NARROW_WINDOW)
		const onChange = () => {
			setNarrow(query.matches)
			setOpenedNarrow(false)
		}
		query.addEventListener('change', onChange)
		return () => query.removeEventListener('change', onChange)
	}, [])
	const workFolded = settings?.workCollapsed === true || (narrow && !openedNarrow)

	// ⌘K or Ctrl+K from anywhere: the panel opens if folded and its field takes the typing.
	const [findRequest, setFindRequest] = useState(0)
	const requestFind = useCallback(() => {
		const current = settingsRef.current
		if (current?.workCollapsed) updateSettings({ ...current, workCollapsed: false })
		setOpenedNarrow(true)
		setFindRequest((count) => count + 1)
	}, [updateSettings])
	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
				event.preventDefault()
				requestFind()
			}
		}
		window.addEventListener('keydown', onKey)
		return () => window.removeEventListener('keydown', onKey)
	}, [requestFind])
	// For the Team page, which may only open because of it: carried out once there, then cleared.
	const [teamAction, setTeamAction] = useState<'add' | 'copy-invite' | null>(null)
	const ask = (what: keyof typeof requests) =>
		setRequests((current) => ({ ...current, [what]: current[what] + 1 }))
	/** Changes a setting on top of the newest ones, so a menu command or a quick second click loses nothing. */
	const patchSettings = useCallback(
		(change: (current: Settings) => Partial<Settings>) => {
			const current = settingsRef.current
			if (current) updateSettings({ ...current, ...change(current) })
		},
		[updateSettings],
	)
	const toggleSidebar = useCallback(
		() => patchSettings((current) => ({ sidebarCollapsed: !current.sidebarCollapsed })),
		[patchSettings],
	)
	const toggleWork = () => {
		if (!narrow) return patchSettings((current) => ({ workCollapsed: !current.workCollapsed }))
		if (!workFolded) return setOpenedNarrow(false)
		setOpenedNarrow(true)
		if (settingsRef.current?.workCollapsed) patchSettings(() => ({ workCollapsed: false }))
	}
	const onMenu = useRef<(command: MenuCommand) => void>(() => {})
	onMenu.current = (command) => {
		switch (command.type) {
			case 'new-conversation':
				return startNew(null, command.beside)
			case 'close-tab':
				return shown ? close(shown) : undefined
			case 'attach':
				return ask('attach')
			case 'show':
				if (command.page === 'chat') {
					// The newest conversation open, or a new one.
					const chat = [...opened.current].reverse().find((id) => !pageOf(id))
					return chat ? show(chat) : startNew()
				}
				return openPage(command.page)
			case 'switch-team':
				return void team.switchTo(command.id)
			case 'add-team':
				openPage('team')
				return setTeamAction('add')
			case 'copy-invite':
				openPage('team')
				return setTeamAction('copy-invite')
			case 'check-updates':
				return ask('update')
			case 'toggle-sidebar':
				return toggleSidebar()
			case 'toggle-work':
				return toggleWork()
			case 'find':
				return requestFind()
		}
	}
	useEffect(() => host.menu?.onCommand((command) => onMenu.current(command)), [host])
	const menuTeams = JSON.stringify(
		team.memberships.map((membership) => ({ id: membership.id, name: membership.name })),
	)
	const canInvite = Boolean(team.file && team.location)
	const sidebarCollapsed = settings?.sidebarCollapsed === true
	useEffect(() => {
		host.menu?.update({
			teams: JSON.parse(menuTeams),
			activeId: team.activeId,
			canInvite,
			sidebarCollapsed,
			workCollapsed: workFolded,
		})
	}, [host, menuTeams, team.activeId, canInvite, sidebarCollapsed, workFolded])
	// Kept in first-opened order, so a tab moving between panes never moves its chat on the page.
	const opened = useRef<string[]>([])
	const openIds = layout.panes.flatMap((pane) => pane.tabs)
	opened.current = [
		...opened.current.filter((id) => openIds.includes(id)),
		...openIds.filter((id) => !opened.current.includes(id)),
	]
	const chatOrder = opened.current

	if (!settings) return <div className="ngm-loading">Loading…</div>

	const mark = !embedded && host.logo && (
		<picture>
			<source srcSet={host.logo.dark} media="(prefers-color-scheme: dark)" />
			<img src={host.logo.light} alt="" />
		</picture>
	)
	const profile = (
		<ProfileMenu
			host={host}
			settings={settings}
			team={team}
			onSettings={openPage}
			onAddTeam={() => {
				openPage('team')
				setTeamAction('add')
			}}
			onCheckUpdates={() => ask('update')}
		/>
	)

	/** A button that is only an icon. Its label is what a screen reader says and the tooltip shows. */
	const iconButton = (label: string, path: string, onClick: () => void, active = false) => (
		<Button
			variant="quiet"
			className="ngm-icon-button"
			aria-label={label}
			title={label}
			active={active}
			aria-current={active ? 'page' : undefined}
			onClick={onClick}
		>
			<Icon path={path} />
		</Button>
	)

	const pinned = (settings.pinned ?? []).filter((id) => saved(id))
	const togglePin = (id: string) =>
		patchSettings((current) => {
			const now = current.pinned ?? []
			return { pinned: now.includes(id) ? now.filter((each) => each !== id) : [...now, id] }
		})
	const removeConversation = async (id: string) => {
		await host.removeConversation(id)
		// A draft made there goes with it, and nothing is changed in words there again.
		patchSettings((current) => {
			const { [id]: _gone, ...drafts } = current.drafts ?? {}
			return {
				drafts,
				madeIn: Object.fromEntries(
					Object.entries(current.madeIn ?? {}).filter(([, chat]) => chat !== id),
				),
			}
		})
		close(id)
		if (settings.pinned?.includes(id)) togglePin(id)
		await refreshConversations()
	}
	removeRunRef.current = removeConversation

	const runTeamTask = (item: TeamTask) => {
		if (item.version && settings.teamTasksSeen?.[seenKey(item)] === item.version) {
			startNew({ task: item.task })
		} else {
			setCheckTask(item)
		}
	}
	const runPrompt = (prompt: ConnectorPrompt) => {
		if (prompt.arguments.length) setOpenPrompt(prompt)
		else
			prompt
				.run({})
				.then((text) => startNew({ prompt: { definition: prompt, text } }))
				.catch(() => setOpenPrompt(prompt))
	}
	// ---- Making tasks and jobs, by form or in words ----

	const ownZone = Intl.DateTimeFormat().resolvedOptions().timeZone
	const everyTask = [...allTasks, ...team.tasks.map((item) => item.task)]
	const taskTitle = (id: string) => everyTask.find((task) => task.id === id)?.title
	const TEAM_TASK = 'team:'
	/**
	 * Where the chat an item was made in is remembered. A team's items carry the team, so two teams'
	 * tasks or jobs of one name never share a chat.
	 */
	const madeInKey = (kind: Draft['kind'], key: string) =>
		key.startsWith('team:') ? `${kind}:${team.activeId ?? ''}:${key}` : `${kind}:${key}`
	const forgetMadeIn = (kind: Draft['kind'], key: string) =>
		patchSettings((current) => {
			const { [madeInKey(kind, key)]: _gone, ...madeIn } = current.madeIn ?? {}
			return { madeIn }
		})
	const removeJob = (key: string) => {
		forgetMadeIn('job', key)
		return jobs.remove(key)
	}

	/** Saves a task from the form or a draft: the person's own, or the team's. */
	const saveTask = async (
		form: TaskForm,
		forTeam: boolean,
		editing?: string,
		/** For a team task: its version when the change began, so a newer one is not overwritten. */
		editingVersion?: string | null,
	): Promise<Saved> => {
		const toTeam = editing ? editing.startsWith(TEAM_TASK) : forTeam
		if (toTeam) {
			const store = team.store
			if (!store) throw new Error('No team is open now, so the task cannot be saved for it.')
			const existing = editing ? team.tasks.find((item) => item.task.id === editing) : undefined
			if (editing && !existing)
				throw new Error(
					'This task is not in the open team any more. Open that team, or make it again as a new task.',
				)
			const name = existing
				? existing.task.id.slice(TEAM_TASK.length)
				: jobId(
						form.title,
						team.tasks.map((item) => item.task.id.slice(TEAM_TASK.length)),
					)
			const task = taskFromDraft(form, name)
			try {
				await saveTeamTask(
					store,
					team.file?.limits ?? DEFAULT_TEAM_LIMITS,
					name,
					serializeTaskFile(task),
					editingVersion !== undefined ? editingVersion : (existing?.version ?? null),
				)
			} catch (err) {
				if (err instanceof TeamConflict)
					throw new Error(
						existing
							? 'Someone in the team changed this task meanwhile. Open it again and redo the change.'
							: 'Someone in the team has just made a task of that name. Give this one another name.',
					)
				throw err
			}
			await team.refresh()
			return { key: `${TEAM_TASK}${name}`, title: task.title }
		}
		// Read anew, broken files included: a new task never takes the name of a file already there.
		const taken = await own.takenIds()
		const id =
			editing && isOwnTask(editing)
				? editing.slice(OWN_TASK_PREFIX.length)
				: jobId(form.title, taken)
		// Deleted meanwhile, from the list: a change must not quietly make it again.
		if (editing && !taken.includes(id)) throw new Error('This task is not there any more.')
		await own.save(taskFromDraft(form, id))
		return { key: `${OWN_TASK_PREFIX}${id}`, title: form.title }
	}

	/** Saves a job from a draft or the form: a new one, or a change to one there is. */
	const saveJob = async (draft: JobDraft, taskId: string, editing?: string): Promise<Saved> => {
		const item = editing ? jobs.list.find((each) => each.key === editing) : undefined
		if (editing && !item) throw new Error('This job is not there any more.')
		const forTeam = item ? item.team : Boolean(draft.forTeam) && jobs.teamAvailable
		if (!draft.inputs?.trim()) throw new Error('Say what the task needs.')
		jobTaskProblem(taskId, forTeam)
		const job = jobFromDraft(
			{ ...draft, forTeam },
			{
				taskId,
				taken: jobs.list.filter((each) => each.team === forTeam).map((each) => each.id),
				keepId: item?.id,
				zone: item?.job?.zone ?? (isTimeZone(ownZone) ? ownZone : 'UTC'),
				// A change keeps the team the job was made for, whichever team is open now.
				teamId: item?.job?.team ?? team.activeId,
				fromTeamTask: taskId.startsWith(TEAM_TASK),
			},
		)
		const noteProblem = noteNameProblem(destinationNote(job.destination, new Date()))
		if (noteProblem) throw new Error(noteProblem)
		if (item) {
			await jobs.edit(item.key, job, teamTaskVersion(taskId))
			return { key: item.key, title: job.title }
		}
		await jobs.create(job, { team: forTeam, taskVersion: teamTaskVersion(taskId) })
		return { key: `${forTeam ? 'team' : 'own'}:${job.id}`, title: job.title }
	}

	const teamTaskVersion = (taskId: string) =>
		team.tasks.find((each) => each.task.id === taskId)?.version ?? undefined

	/**
	 * Throws when a job cannot run this task: one that is not there, or, for a team job, one of this
	 * person's own, which the other members' computers do not have.
	 */
	const jobTaskProblem = (taskId: string, forTeam: boolean) => {
		if (!everyTask.some((task) => task.id === taskId))
			throw new Error('The task this job runs is not there. Pick another.')
		if (forTeam && isOwnTask(taskId))
			throw new Error(
				"A job for the team cannot run one of your own tasks: the others' computers do not have it. Save the task for the team first.",
			)
	}

	const completeTask = (draft: TaskDraft): TaskForm => ({
		title: draft.title ?? '',
		description: draft.description ?? '',
		ask: draft.ask ?? '',
		instructions: draft.instructions ?? '',
		tools: draft.tools ?? 'none',
	})

	const making: ChatMaking | undefined =
		jobs.available || own.available
			? {
					context: {
						tasks: everyTask.map((task) => ({ id: task.id, title: task.title, ask: task.ask })),
						teamNotes: Boolean(team.notes),
						teamJobs: jobs.teamAvailable && Boolean(team.notes),
					},
					taskTitle,
					save: async (draft, onStep) => {
						if (draft.kind === 'task')
							return saveTask(completeTask(draft.task), false, draft.editing, draft.editingVersion)
						let taskId = draft.job.task ?? ''
						if (taskId === NEW_TASK) {
							// Kept in the draft at once, so trying the job again does not make the task twice.
							taskId = (await saveTask(completeTask(draft.task), false)).key
							await onStep({ ...draft, task: {}, job: { ...draft.job, task: taskId } })
						}
						return saveJob(draft.job, taskId, draft.editing)
					},
					openForm: (draft, onStep) =>
						new Promise((resolve) => {
							if (draft.kind === 'task')
								setTaskForm({
									title: draft.editing
										? `Change ${taskTitle(draft.editing) ?? 'the task'}`
										: 'New task',
									initial: draft.task,
									editing: draft.editing,
									editingVersion: draft.editingVersion,
									forTeam: draft.editing ? draft.editing.startsWith(TEAM_TASK) : undefined,
									done: resolve,
								})
							else if (draft.job.task === NEW_TASK)
								// The job's new task first, then the job that runs it.
								setTaskForm({
									title: 'The task for this job',
									initial: draft.task,
									done: (task) => {
										if (!task) return resolve(null)
										// Kept in the draft at once: cancelling the job form must not leave a second
										// copy of the task to be made by Make it later.
										const next = { ...draft, task: {}, job: { ...draft.job, task: task.key } }
										void onStep(next).finally(() =>
											setJobForm({ initial: next.job, editing: draft.editing, done: resolve }),
										)
									},
								})
							else setJobForm({ initial: draft.job, editing: draft.editing, done: resolve })
						}),
					draftOf: (kind, key) => {
						if (kind === 'task') {
							const task = everyTask.find((each) => each.id === key)
							return task ? draftFromTask(task, { key, version: teamVersionOf(key) }) : undefined
						}
						const item = jobs.list.find((each) => each.key === key)
						return item?.job ? draftFromJob(item.job, item.team, key) : undefined
					},
					open: (draft) =>
						patchSettings(() => ({
							workGroup: draft.kind === 'job' ? 'jobs' : 'tasks',
							workCollapsed: false,
						})),
					titleOf: (draft) =>
						!draft.saved
							? undefined
							: draft.kind === 'task'
								? taskTitle(draft.saved)
								: jobs.list.find((each) => each.key === draft.saved)?.job?.title,
					onDraft: (conversationId, kind, saved) =>
						patchSettings((current) => {
							const { [conversationId]: was, ...rest } = current.drafts ?? {}
							return {
								drafts: kind ? { ...rest, [conversationId]: kind } : rest,
								...(saved && was
									? { madeIn: { ...current.madeIn, [madeInKey(was, saved)]: conversationId } }
									: {}),
							}
						}),
				}
			: undefined

	/** Opens a chat to make something: a new one, or the one it was made in when it is changed. */
	const makeInChat = (begin: NonNullable<ChatStart['making']>, conversationId?: string) => {
		const id = conversationId ?? makeId('chat')
		setLayout((current) => showHere(current, id))
		setStart({ id, begin: { making: begin } })
	}
	const changeInWords = (kind: Draft['kind'], key: string, draft: Draft, title: string) => {
		const madeIn = settings.madeIn?.[madeInKey(kind, key)]
		const kept = madeIn && conversations.some((conversation) => conversation.id === madeIn)
		makeInChat({ draft, title: `Changing ${title}` }, kept ? madeIn : undefined)
	}
	/** A team task's version now, or undefined for a task of another kind. */
	const teamVersionOf = (id: string) =>
		id.startsWith(TEAM_TASK)
			? (team.tasks.find((item) => item.task.id === id)?.version ?? null)
			: undefined
	const changeTaskInWords = (task: TaskFile) =>
		changeInWords(
			'task',
			task.id,
			draftFromTask(task, { key: task.id, version: teamVersionOf(task.id) }),
			task.title,
		)
	const changeJobInWords = (key: string) => {
		const item = jobs.list.find((each) => each.key === key)
		if (item?.job) changeInWords('job', key, draftFromJob(item.job, item.team, key), item.job.title)
	}

	const copyTask = (task: TaskFile) =>
		setTaskForm({
			title: `Copy of ${task.title}`,
			initial: { ...draftFromTask(task).task, title: `${task.title} (copy)` },
		})
	const editTask = (task: TaskFile) =>
		setTaskForm({
			title: `Change ${task.title}`,
			initial: draftFromTask(task).task,
			editing: task.id,
			editingVersion: teamVersionOf(task.id),
			forTeam: task.id.startsWith(TEAM_TASK),
		})
	const taskActions = (task: TaskFile, mine: boolean, ofTeam: boolean) => [
		...(mine || ofTeam
			? [
					{
						label: 'Change in chat',
						ai: true,
						onClick: () => changeTaskInWords(task),
					},
					{
						label: 'Edit',
						onClick: () => editTask(task),
					},
				]
			: []),
		...(own.available
			? [
					{
						label: 'Copy and change',
						onClick: () => copyTask(task),
					},
				]
			: []),
		...(mine
			? [
					{
						label: 'Delete',
						onClick: () => setDeleteTask(task.id),
					},
				]
			: []),
	]

	const draftRows: WorkDraft[] = Object.entries(settings.drafts ?? {}).flatMap(([id, kind]) => {
		const conversation = conversations.find((each) => each.id === id)
		// Read from a settings file anyone can edit: only what this app writes is listed.
		return conversation && (kind === 'task' || kind === 'job')
			? [{ id, kind, title: conversation.title }]
			: []
	})

	const taskGroups: { title: string; tasks: WorkTask[] }[] = [
		{
			title: 'Yours',
			tasks: own.tasks.map((task) => ({
				key: task.id,
				label: task.title,
				text: task.title,
				title: task.description,
				run: () => startNew({ task }),
				actions: taskActions(task, true, false),
			})),
		},
		{
			title: 'Ready-made',
			tasks: host.tasks.map((task: TaskFile) => ({
				key: task.id,
				label: task.title,
				text: task.title,
				title: task.description,
				run: () => startNew({ task }),
				actions: taskActions(task, false, false),
			})),
		},
		{
			title: 'From your team',
			tasks: team.tasks.map((item) => ({
				key: item.task.id,
				label: item.task.title,
				text: item.task.title,
				title: item.task.description,
				run: () => runTeamTask(item),
				actions: taskActions(item.task, false, Boolean(team.store)),
			})),
		},
		...[...new Set(prompts.map((prompt) => prompt.source))].map((source) => ({
			title: `From ${source}`,
			tasks: prompts
				.filter((prompt) => prompt.source === source)
				.map((prompt) => ({
					key: `${source}/${prompt.name}`,
					label: promptLabel(prompt),
					text: `${promptLabel(prompt)} ${source}`,
					title: prompt.description,
					run: () => runPrompt(prompt),
				})),
		})),
	]

	/** What is set up once: each opens in the middle, beside the work. */
	const places = [
		{
			key: 'model',
			label: 'Model',
			icon: ICONS.model,
			open: () => openPage('model'),
			active: shown === pageTab('model'),
		},
		{
			key: 'addons',
			label: 'Connectors',
			icon: ICONS.plug,
			open: () => openPage('addons'),
			active: shown === pageTab('addons'),
		},
		...(host.voice
			? [
					{
						key: 'tools',
						label: 'Built-in tools',
						icon: ICONS.mic,
						open: () => openPage('tools'),
						active: shown === pageTab('tools'),
					},
				]
			: []),
		{
			key: 'memory',
			label: 'Notes',
			icon: ICONS.memory,
			open: () => openPage('memory'),
			active: shown === pageTab('memory'),
		},
		...(host.team
			? [
					{
						key: 'team',
						label: 'Teams',
						icon: ICONS.team,
						open: () => openPage('team'),
						active: shown === pageTab('team'),
					},
				]
			: []),
		{
			key: 'about',
			label: 'About',
			icon: ICONS.info,
			open: () => openPage('about'),
			active: shown === pageTab('about'),
		},
	]

	/** A page of what is set up once, in its tab. */
	const pageContent = (page: Page) =>
		page === 'memory' ? (
			<div className="ngm-settings-content">
				<MemoryPanel host={host} teamNotes={team.notes} />
			</div>
		) : (
			<SettingsPage
				host={host}
				settings={settings}
				onChange={updateSettings}
				section={page}
				onCheckUpdates={() => ask('update')}
				sections={{
					model: <ModelPanel host={host} settings={settings} onChange={updateSettings} />,
					tools: <ToolsPanel host={host} settings={settings} onChange={updateSettings} />,
					addons: (
						<AddonsPanel
							host={host}
							settings={settings}
							onChange={updateSettings}
							teamSuggests={team.file?.connectors}
						/>
					),
					team: host.team && (
						<TeamPanel
							host={{ ...host, team: host.team }}
							settings={settings}
							onChange={updateSettings}
							team={team}
							onOpenConnectors={() => openPage('addons')}
							incomingInvite={incomingInvite}
							onInviteSeen={() => setIncomingInvite(null)}
							action={teamAction}
							onActionDone={() => setTeamAction(null)}
						/>
					),
				}}
			/>
		)

	return (
		<>
			{/* One element either way, so the update notice at its end stays as it is when it collapses. */}
			<aside
				className={`ngm-sidebar${sidebarCollapsed ? ' ngm-sidebar-collapsed' : ''}`}
				aria-label="Sidebar"
			>
				{sidebarCollapsed ? (
					<>
						{iconButton('Show the sidebar', ICONS.sidebar, toggleSidebar)}
						{iconButton('New conversation', ICONS.plus, () => startNew())}
						{places.map((place) => (
							<Fragment key={place.key}>
								{iconButton(place.label, place.icon, place.open, place.active)}
							</Fragment>
						))}
						{profile}
					</>
				) : (
					<>
						<div className="ngm-side-head">
							{!embedded && (
								<h1 className="ngm-brand">
									{mark}
									{host.appName}
								</h1>
							)}
							{iconButton('New conversation', ICONS.plus, () => startNew())}
							{profile}
							{iconButton('Hide the sidebar', ICONS.sidebar, toggleSidebar)}
						</div>
						<div className="ngm-side-scroll">
							<section className="ngm-side-section">
								<h2 className="ngm-side-title">Pinned</h2>
								{pinned.length ? (
									<div className="ngm-side-list">
										{pinned.map((id) => (
											<div className="ngm-side-item" key={id}>
												<Button variant="nav" active={id === shown} onClick={() => show(id)}>
													{titleOf(id)}
												</Button>
												<RowActions
													label={`Actions for ${titleOf(id)}`}
													items={[{ label: 'Unpin', onSelect: () => togglePin(id) }]}
												/>
											</div>
										))}
									</div>
								) : (
									<p className="ngm-side-note">Pin a chat to keep it here.</p>
								)}
							</section>
							<nav className="ngm-side-section ngm-places" aria-label="Set up">
								<h2 className="ngm-side-title">Set up</h2>
								{places.map((place) => (
									<Button
										variant="nav"
										key={place.key}
										active={place.active}
										aria-current={place.active ? 'page' : undefined}
										onClick={place.open}
									>
										<Icon path={place.icon} size={14} />
										{place.label}
									</Button>
								))}
							</nav>
						</div>
					</>
				)}
				<UpdateNotice host={host} checkRequest={requests.update} />
			</aside>

			<main className="ngm-main">
				{openPrompt && (
					<PromptForm
						prompt={openPrompt}
						onCancel={() => setOpenPrompt(null)}
						onReady={(text) => {
							startNew({ prompt: { definition: openPrompt, text } })
							setOpenPrompt(null)
						}}
					/>
				)}
				{/*
				 * Every open tab stays on the page, hidden when not shown, and so do they all behind the
				 * settings: switching away never stops an answer being written.
				 */}
				<div
					className="ngm-panes"
					style={{ gridTemplateColumns: `repeat(${layout.panes.length}, minmax(280px, 1fr))` }}
				>
					{layout.panes.map((pane, paneIndex) => (
						<section
							key={pane.id}
							className={`ngm-pane${paneIndex === layout.focused ? ' ngm-pane-focused' : ''}${paneIndex ? ' ngm-pane-follows' : ''}`}
							style={{ gridColumn: paneIndex + 1 }}
							aria-label={`Pane ${paneIndex + 1}`}
							onFocusCapture={() => focusPane(paneIndex)}
							onMouseDownCapture={() => focusPane(paneIndex)}
						>
							<TabBar
								pane={pane}
								titleOf={titleOf}
								onSelect={(id) => setLayout((current) => focusTab(current, paneIndex, id))}
								onClose={close}
								onNew={() => startNew()}
								onSplit={() => startNew(null, true)}
								canSplit={layout.panes.length < MAX_PANES}
								onDrop={(id, before) => {
									// Only a conversation this window has: an id carried in from elsewhere opens nothing.
									const known =
										conversations.some((conversation) => conversation.id === id) ||
										layout.panes.some((open) => open.tabs.includes(id))
									if (known) setLayout((current) => placeTab(current, pane.id, id, before))
								}}
							/>
						</section>
					))}
					{/*
					 * One list for every pane, in the order tabs were first opened, each placed in its pane's
					 * column: moving a tab to another pane changes only where it is shown, so an answer being
					 * written carries on. Closing a tab still stops it.
					 */}
					{chatOrder.map((id) => {
						const paneIndex = layout.panes.findIndex((pane) => pane.tabs.includes(id))
						const pane = layout.panes[paneIndex]
						if (!pane) return null
						return (
							<div
								className={`ngm-chat-holder${paneIndex ? ' ngm-pane-follows' : ''}`}
								style={{ gridColumn: paneIndex + 1 }}
								hidden={id !== pane.active}
								key={id}
								role="tabpanel"
								onFocusCapture={() => focusPane(paneIndex)}
								onMouseDownCapture={() => focusPane(paneIndex)}
							>
								{pageOf(id) ? (
									pageContent(pageOf(id) as Page)
								) : (
									<Chat
										deps={deps}
										conversationId={id}
										start={start?.id === id ? start.begin : null}
										attachRequest={id === shown ? requests.attach : 0}
										onStarted={clearStart}
										making={making}
									/>
								)}
							</div>
						)
					})}
				</div>
				{checkTask && (
					<Dialog
						actions={
							<>
								<Button onClick={() => setCheckTask(null)}>Cancel</Button>
								<Button
									variant="primary"
									onClick={() => {
										if (checkTask.version) {
											updateSettings({
												...settings,
												teamTasksSeen: {
													...settings.teamTasksSeen,
													[seenKey(checkTask)]: checkTask.version,
												},
											})
										}
										startNew({ task: checkTask.task })
										setCheckTask(null)
									}}
								>
									Run it
								</Button>
							</>
						}
						title={checkTask.task.title}
						onClose={() => setCheckTask(null)}
					>
						<p>
							{settings.teamTasksSeen?.[seenKey(checkTask)]
								? 'Someone in your team changed this task since you last ran it.'
								: 'This task comes from your team. Anyone in the team can change it.'}{' '}
							Read what it tells the assistant to do before running it.
						</p>
						<pre className="ngm-pre">{checkTask.text}</pre>
					</Dialog>
				)}
				{chooser && (
					<MakeChooser
						kind={chooser}
						onWords={(text) => {
							makeInChat({ draft: emptyDraft(chooser), text })
							setChooser(null)
						}}
						onForm={() => {
							if (chooser === 'task') setTaskForm({ title: 'New task' })
							else setJobForm({})
							setChooser(null)
						}}
						onClose={() => setChooser(null)}
					/>
				)}
				{taskForm && (
					<TaskDialog
						title={taskForm.title}
						initial={taskForm.initial}
						canSaveForTeam={Boolean(team.store)}
						forTeam={taskForm.forTeam}
						onSave={async (form, forTeam) => {
							formSaved.current = await saveTask(
								form,
								forTeam,
								taskForm.editing,
								taskForm.editingVersion,
							)
						}}
						onClose={() => {
							const saved = formSaved.current
							formSaved.current = null
							setTaskForm(null)
							taskForm.done?.(saved)
						}}
					/>
				)}
				{jobForm && (
					<JobDialog
						tasks={[
							...allTasks.map((task) => ({ task, fromTeam: false, version: null })),
							...team.tasks
								.filter((item) => !allTasks.some((task) => task.id === item.task.id))
								.map((item) => ({ task: item.task, fromTeam: true, version: item.version })),
						]}
						takenIds={{
							own: jobs.list.filter((item) => !item.team).map((item) => item.id),
							team: jobs.list.filter((item) => item.team).map((item) => item.id),
						}}
						teamId={team.activeId}
						canWriteTeamNotes={Boolean(team.notes)}
						canShareWithTeam={jobs.teamAvailable && Boolean(team.notes)}
						initial={jobForm.initial}
						editing={Boolean(jobForm.editing)}
						zone={jobs.list.find((item) => item.key === jobForm.editing)?.job?.zone}
						onCreate={async (job, options) => {
							const item = jobs.list.find((each) => each.key === jobForm.editing)
							jobTaskProblem(job.task, item ? item.team : options.team)
							if (jobForm.editing) {
								if (!item?.job) throw new Error('This job is not there any more.')
								// A change keeps the job's zone and, while it still uses a team, the team it was made
								// for, whichever team is open now.
								const usesTeam =
									!item.team &&
									(job.destination.kind === 'team-note' || job.task.startsWith(TEAM_TASK))
								const { team: _open, ...rest } = job
								const changed = {
									...rest,
									...(item.job.zone ? { zone: item.job.zone } : {}),
									...(usesTeam && (item.job.team ?? job.team)
										? { team: item.job.team ?? job.team }
										: {}),
								}
								await jobs.edit(jobForm.editing, changed, teamTaskVersion(job.task))
								formSaved.current = { key: jobForm.editing, title: job.title }
								return
							}
							await jobs.create(job, {
								team: options.team,
								taskVersion: options.taskVersion ?? undefined,
							})
							formSaved.current = {
								key: `${options.team ? 'team' : 'own'}:${job.id}`,
								title: job.title,
							}
						}}
						onClose={() => {
							const saved = formSaved.current
							formSaved.current = null
							setJobForm(null)
							jobForm.done?.(saved)
						}}
					/>
				)}
				{deleteTask &&
					(() => {
						const task = own.tasks.find((each) => each.id === deleteTask)
						const users = jobs.list.filter((item) => item.job?.task === deleteTask)
						return (
							<Dialog
								actions={
									<>
										<Button onClick={() => setDeleteTask(null)}>Cancel</Button>
										{!users.length && (
											<Button
												variant="danger"
												onClick={async () => {
													try {
														await own.remove(deleteTask.slice(OWN_TASK_PREFIX.length))
														forgetMadeIn('task', deleteTask)
														setDeleteTask(null)
														setDeleteProblem(null)
													} catch (err) {
														setDeleteProblem(err instanceof Error ? err.message : String(err))
													}
												}}
											>
												Delete it
											</Button>
										)}
									</>
								}
								title={`Delete ${task?.title ?? 'this task'}?`}
								problem={deleteProblem}
								onClose={() => {
									setDeleteTask(null)
									setDeleteProblem(null)
								}}
							>
								{users.length ? (
									<p>
										{users.map((item) => item.job?.title).join(', ')}{' '}
										{users.length === 1 ? 'runs' : 'run'} this task. Delete or change{' '}
										{users.length === 1 ? 'that job' : 'those jobs'} first.
									</p>
								) : (
									<p>
										It is deleted from this computer and cannot be brought back. Chats that used it
										stay.
									</p>
								)}
							</Dialog>
						)
					})()}
				{readJobTask &&
					(() => {
						const item = jobs.list.find((each) => each.key === readJobTask)
						const teamTask = team.tasks.find((each) => each.task.id === item?.job?.task)
						return (
							<Dialog
								actions={
									<>
										<Button onClick={() => setReadJobTask(null)}>Cancel</Button>
										<Button
											variant="primary"
											disabled={!teamTask || !item}
											onClick={async () => {
												if (!teamTask || !item) return
												// Read here, so it is not asked again when the task is run as a chat.
												const version = teamTask.version
												if (version) {
													patchSettings((latest) => ({
														teamTasksSeen: {
															...latest.teamTasksSeen,
															[seenKey(teamTask)]: version,
														},
													}))
												}
												// Run only once the new version is recorded, or it would be held again.
												if (await jobs.acceptTask(item.key, version)) jobs.runNow(item.key)
												setReadJobTask(null)
											}}
										>
											Run the job with it
										</Button>
									</>
								}
								title={teamTask?.task.title ?? 'Task'}
								onClose={() => setReadJobTask(null)}
							>
								<p>
									Someone in your team changed the task{' '}
									{item?.job ? `the job "${item.job.title}"` : 'this job'} runs. Read what it tells
									the assistant to do before the job runs it.
								</p>
								{teamTask ? (
									<pre className="ngm-pre">{teamTask.text}</pre>
								) : (
									<p>The task is not in this team any more.</p>
								)}
							</Dialog>
						)
					})()}
				{deleteJob &&
					(() => {
						const item = jobs.list.find((each) => each.key === deleteJob)
						const title = item?.job?.title ?? item?.id ?? 'this job'
						return (
							<Dialog
								actions={
									<>
										<Button onClick={() => setDeleteJob(null)}>Cancel</Button>
										<Button
											variant="danger"
											onClick={() => {
												void removeJob(deleteJob)
												setDeleteJob(null)
											}}
										>
											Delete it for the team
										</Button>
									</>
								}
								title={`Delete ${title}?`}
								onClose={() => setDeleteJob(null)}
							>
								<p>
									It is deleted for everyone in the team, with the list of its runs and the chats of
									the runs this computer made, and cannot be brought back. The notes it wrote stay.
								</p>
							</Dialog>
						)
					})()}
			</main>
			<WorkPanel
				conversations={conversations}
				shownId={shown ?? null}
				pinned={settings.pinned ?? []}
				taskGroups={taskGroups}
				group={settings.workGroup ?? 'chats'}
				onGroup={(group) => patchSettings(() => ({ workGroup: group }))}
				collapsed={workFolded}
				onToggle={toggleWork}
				canSplit={layout.panes.length < MAX_PANES}
				onOpen={show}
				onTogglePin={togglePin}
				onDelete={removeConversation}
				onFind={requestFind}
				findIn={findIn}
				onOpenNotes={() => openPage('memory')}
				findRequest={findRequest}
				drafts={draftRows}
				onNewTask={own.available ? () => setChooser('task') : undefined}
				jobs={
					jobs.available
						? {
								list: jobs.list,
								loaded: jobs.loaded,
								running: jobs.running,
								problem: jobs.problem,
								onNew: () => setChooser('job'),
								onEdit: (key) => {
									const item = jobs.list.find((each) => each.key === key)
									if (item?.job)
										setJobForm({ initial: draftFromJob(item.job, item.team).job, editing: key })
								},
								onChangeInWords: changeJobInWords,
								onRun: jobs.runNow,
								onPause: (key, paused) => void jobs.setPaused(key, paused),
								onDelete: (key) =>
									jobs.list.find((each) => each.key === key)?.team
										? setDeleteJob(key)
										: void removeJob(key),
								onOpenRun: (key, conversationId) => {
									show(conversationId)
									void jobs.markSeen(key, conversationId)
								},
								onReadTask: setReadJobTask,
								onDecide: (key, ranAt, index, allow) =>
									void jobs.decideChange(key, ranAt, index, allow),
							}
						: undefined
				}
			/>
		</>
	)
}
