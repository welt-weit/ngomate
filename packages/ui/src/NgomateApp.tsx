import {
	DEFAULT_TEAM_LIMITS,
	type PromptDefinition,
	type TaskFile,
	createTeamJobStore,
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
import { AddonsPanel } from './AddonsPanel.js'
import { Chat, type ChatStart } from './Chat.js'
import { JobDialog } from './JobDialog.js'
import { ProfileMenu } from './ProfileMenu.js'
import { SettingsPage, type SettingsSection } from './Settings.js'
import { TabBar, startConversationDrag } from './TabBar.js'
import { TeamPanel } from './TeamPanel.js'
import { UpdateNotice } from './UpdateNotice.js'
import { type FoundText, WorkPanel, type WorkTask, matches } from './WorkPanel.js'
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
						tasks: host.tasks,
						teamTasks: team.tasks,
						teamId: team.activeId ?? undefined,
						teamConnectors,
					}
				: null,
		[settings, deps, idleBusy, host, team.tasks, team.activeId, teamConnectors],
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
	const [newJob, setNewJob] = useState(false)
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
	const taskGroups: { title: string; tasks: WorkTask[] }[] = [
		{
			title: 'Ready-made',
			tasks: host.tasks.map((task: TaskFile) => ({
				key: task.id,
				label: task.title,
				text: task.title,
				title: task.description,
				run: () => startNew({ task }),
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
												<div className="ngm-side-actions">
													<Button
														variant="quiet"
														className="ngm-icon-button"
														aria-label={`Unpin ${titleOf(id)}`}
														title="Unpin"
														onClick={() => togglePin(id)}
													>
														<Icon path={ICONS.close} size={14} />
													</Button>
												</div>
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
									/>
								)}
							</div>
						)
					})}
				</div>
				{checkTask && (
					<Dialog title={checkTask.task.title} onClose={() => setCheckTask(null)}>
						<p>
							{settings.teamTasksSeen?.[seenKey(checkTask)]
								? 'Someone in your team changed this task since you last ran it.'
								: 'This task comes from your team. Anyone in the team can change it.'}{' '}
							Read what it tells the assistant to do before running it.
						</p>
						<pre className="ngm-pre">{checkTask.text}</pre>
						<div className="ngm-row">
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
							<Button onClick={() => setCheckTask(null)}>Cancel</Button>
						</div>
					</Dialog>
				)}
				{newJob && (
					<JobDialog
						tasks={[
							...host.tasks.map((task) => ({ task, fromTeam: false, version: null })),
							...team.tasks
								.filter((item) => !host.tasks.some((task) => task.id === item.task.id))
								.map((item) => ({ task: item.task, fromTeam: true, version: item.version })),
						]}
						takenIds={{
							own: jobs.list.filter((item) => !item.team).map((item) => item.id),
							team: jobs.list.filter((item) => item.team).map((item) => item.id),
						}}
						teamId={team.activeId}
						canWriteTeamNotes={Boolean(team.notes)}
						canShareWithTeam={jobs.teamAvailable && Boolean(team.notes)}
						onCreate={(job, options) =>
							jobs.create(job, {
								team: options.team,
								taskVersion: options.taskVersion ?? undefined,
							})
						}
						onClose={() => setNewJob(false)}
					/>
				)}
				{readJobTask &&
					(() => {
						const item = jobs.list.find((each) => each.key === readJobTask)
						const teamTask = team.tasks.find((each) => each.task.id === item?.job?.task)
						return (
							<Dialog title={teamTask?.task.title ?? 'Task'} onClose={() => setReadJobTask(null)}>
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
								<div className="ngm-row">
									<Button
										variant="primary"
										disabled={!teamTask || !item}
										onClick={async () => {
											if (!teamTask || !item) return
											// Read here, so it is not asked again when the task is run as a chat.
											const version = teamTask.version
											if (version) {
												patchSettings((latest) => ({
													teamTasksSeen: { ...latest.teamTasksSeen, [seenKey(teamTask)]: version },
												}))
											}
											// Run only once the new version is recorded, or it would be held again.
											if (await jobs.acceptTask(item.key, version)) jobs.runNow(item.key)
											setReadJobTask(null)
										}}
									>
										Run the job with it
									</Button>
									<Button onClick={() => setReadJobTask(null)}>Cancel</Button>
								</div>
							</Dialog>
						)
					})()}
				{deleteJob &&
					(() => {
						const item = jobs.list.find((each) => each.key === deleteJob)
						const title = item?.job?.title ?? item?.id ?? 'this job'
						return (
							<Dialog title={`Delete ${title}?`} onClose={() => setDeleteJob(null)}>
								<p>
									It is deleted for everyone in the team, with the list of its runs and the chats of
									the runs this computer made. The notes it wrote stay.
								</p>
								<div className="ngm-row">
									<Button
										variant="primary"
										onClick={() => {
											void jobs.remove(deleteJob)
											setDeleteJob(null)
										}}
									>
										Delete it for the team
									</Button>
									<Button onClick={() => setDeleteJob(null)}>Cancel</Button>
								</div>
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
				jobs={
					jobs.available
						? {
								list: jobs.list,
								loaded: jobs.loaded,
								running: jobs.running,
								problem: jobs.problem,
								onNew: () => setNewJob(true),
								onRun: jobs.runNow,
								onPause: (key, paused) => void jobs.setPaused(key, paused),
								onDelete: (key) =>
									jobs.list.find((each) => each.key === key)?.team
										? setDeleteJob(key)
										: void jobs.remove(key),
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
