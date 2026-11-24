import type { PromptDefinition, TaskFile } from '@ngomate/core'
import {
	type CSSProperties,
	type ReactNode,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from 'react'
import { AddonsPanel } from './AddonsPanel.js'
import { Chat, type ChatStart } from './Chat.js'
import { ProfileMenu } from './ProfileMenu.js'
import { SettingsPage, type SettingsSection } from './Settings.js'
import { TabBar, startConversationDrag } from './TabBar.js'
import { TeamPanel } from './TeamPanel.js'
import { UpdateNotice } from './UpdateNotice.js'
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
import { type TeamTask, useTeam } from './useTeam.js'

/** The conversations, the notes, or the settings. */
type View = 'chat' | 'memory' | 'settings'

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
	const [view, setView] = useState<View>('chat')
	const [section, setSection] = useState<SettingsSection>('model')
	const openSettings = (at: SettingsSection) => {
		setSection(at)
		setView('settings')
	}
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
	useEffect(
		() =>
			host.team?.onInvite?.((link) => {
				setIncomingInvite(link)
				setSection('team')
				setView('settings')
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
			const kept = restoreLayout(loaded.layout, (id) => listed.some((saved) => saved.id === id))
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
	const onBusyChange = useIdleUnload(models ? () => models.stop() : undefined)

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

	const saved = (id: string) => conversations.some((conversation) => conversation.id === id)
	/** A tab that holds nothing yet makes way, rather than staying open beside what comes next. */
	const showHere = (current: Layout, id: string) => {
		const shown = activeId(current)
		return shown && !saved(shown) ? replaceActive(current, id) : openTab(current, id)
	}

	const startNew = (begin: ChatStart | null = null, beside = false) => {
		const id = makeId('chat')
		setLayout((current) => (beside ? openBeside(current, id) : showHere(current, id)))
		setStart(begin ? { id, begin } : null)
		setView('chat')
	}

	const show = (id: string, beside = false) => {
		setLayout((current) => (beside ? openBeside(current, id) : showHere(current, id)))
		setView('chat')
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
	const titleOf = (id: string) =>
		conversations.find((conversation) => conversation.id === id)?.title ?? 'New conversation'
	const shown = activeId(layout)

	// Menu commands that a page or the conversation in front carries out: each new request counts up.
	const [requests, setRequests] = useState({ attach: 0, update: 0 })
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
	const onMenu = useRef<(command: MenuCommand) => void>(() => {})
	onMenu.current = (command) => {
		switch (command.type) {
			case 'new-conversation':
				return startNew(null, command.beside)
			case 'close-tab':
				return shown ? close(shown) : undefined
			case 'attach':
				setView('chat')
				return ask('attach')
			case 'show':
				if (command.page === 'chat' || command.page === 'memory') return setView(command.page)
				return openSettings(command.page)
			case 'switch-team':
				return void team.switchTo(command.id)
			case 'add-team':
				openSettings('team')
				return setTeamAction('add')
			case 'copy-invite':
				openSettings('team')
				return setTeamAction('copy-invite')
			case 'check-updates':
				return ask('update')
			case 'toggle-sidebar':
				return toggleSidebar()
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
		})
	}, [host, menuTeams, team.activeId, canInvite, sidebarCollapsed])
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
			onSettings={(at) => openSettings(at ?? section)}
			onAddTeam={() => {
				openSettings('team')
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

	const folded = new Set(settings.foldedSections ?? [])
	const toggleFold = (key: string) =>
		patchSettings((current) => {
			const now = current.foldedSections ?? []
			return {
				foldedSections: now.includes(key) ? now.filter((name) => name !== key) : [...now, key],
			}
		})
	/** A sidebar section whose title folds it away; which are folded is kept between launches. */
	const foldable = (key: string, title: string, children: ReactNode) => (
		<section className="ngm-side-section" key={key}>
			<h2 className="ngm-side-title">
				<Button
					variant="quiet"
					className="ngm-side-toggle"
					aria-expanded={!folded.has(key)}
					onClick={() => toggleFold(key)}
				>
					<span className="ngm-side-toggle-text">{title}</span>
					<Icon path={ICONS.chevron} size={12} />
				</Button>
			</h2>
			{!folded.has(key) && children}
		</section>
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
						{iconButton('Memory', ICONS.memory, () => setView('memory'), view === 'memory')}
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
							{iconButton('Memory', ICONS.memory, () => setView('memory'), view === 'memory')}
							{profile}
							{iconButton('Hide the sidebar', ICONS.sidebar, toggleSidebar)}
						</div>
						<Button variant="primary" onClick={() => startNew()}>
							New conversation
						</Button>

						{/* Tasks and conversations scroll together; each section folds away. */}
						<div className="ngm-side-scroll">
							{foldable(
								'tasks',
								'Ready-made tasks',
								<>
									{host.tasks.map((task: TaskFile) => (
										<Button
											variant="nav"
											key={task.id}
											title={task.description}
											onClick={() => startNew({ task })}
										>
											{task.title}
										</Button>
									))}
									{team.tasks.map((item) => (
										<Button
											variant="nav"
											key={item.task.id}
											title={`${item.task.description} (from your team)`}
											onClick={() => {
												if (
													item.version &&
													settings.teamTasksSeen?.[seenKey(item)] === item.version
												) {
													startNew({ task: item.task })
												} else {
													setCheckTask(item)
												}
											}}
										>
											{item.task.title} <span className="ngm-muted">· team</span>
										</Button>
									))}
								</>,
							)}
							{[...new Set(prompts.map((prompt) => prompt.source))].map((source) =>
								foldable(
									`connector:${source}`,
									`From ${source}`,
									prompts
										.filter((prompt) => prompt.source === source)
										.map((prompt) => (
											<Button
												variant="nav"
												key={prompt.name}
												title={prompt.description}
												onClick={() => {
													if (prompt.arguments.length) setOpenPrompt(prompt)
													else
														prompt
															.run({})
															.then((text) => startNew({ prompt: { definition: prompt, text } }))
															.catch(() => setOpenPrompt(prompt))
												}}
											>
												{promptLabel(prompt)}
											</Button>
										)),
								),
							)}
							{foldable(
								'conversations',
								'Conversations',
								<div className="ngm-side-list">
									{conversations.map((conversation) => (
										<div
											className="ngm-side-item"
											key={conversation.id}
											draggable
											title="Drag onto a tab bar to open it there"
											onDragStart={(event) => startConversationDrag(event, conversation.id)}
										>
											<Button
												variant="nav"
												active={view === 'chat' && conversation.id === shown}
												onClick={() => show(conversation.id)}
											>
												{conversation.title}
											</Button>
											<div className="ngm-side-actions">
												<Button
													variant="quiet"
													className="ngm-icon-button"
													aria-label={`Open ${conversation.title} side by side`}
													title="Open side by side"
													disabled={layout.panes.length >= MAX_PANES}
													onClick={() => show(conversation.id, true)}
												>
													<Icon path={ICONS.split} size={14} />
												</Button>
												<Button
													variant="quiet"
													className="ngm-icon-button"
													aria-label={`Delete ${conversation.title}`}
													title="Delete"
													onClick={async () => {
														await host.removeConversation(conversation.id)
														close(conversation.id)
														await refreshConversations()
													}}
												>
													<Icon path={ICONS.close} size={14} />
												</Button>
											</div>
										</div>
									))}
								</div>,
							)}
						</div>
					</>
				)}
				<UpdateNotice host={host} checkRequest={requests.update} />
			</aside>

			<main className="ngm-main">
				{openPrompt && view === 'chat' && (
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
					hidden={view !== 'chat'}
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
								<Chat
									deps={deps}
									conversationId={id}
									start={start?.id === id ? start.begin : null}
									attachRequest={id === shown ? requests.attach : 0}
									onStarted={clearStart}
								/>
							</div>
						)
					})}
				</div>
				{view === 'memory' && <MemoryPanel host={host} teamNotes={team.notes} />}
				{view === 'settings' && (
					<SettingsPage
						host={host}
						settings={settings}
						onChange={updateSettings}
						section={section}
						onSection={setSection}
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
									onOpenConnectors={() => setSection('addons')}
									incomingInvite={incomingInvite}
									onInviteSeen={() => setIncomingInvite(null)}
									action={teamAction}
									onActionDone={() => setTeamAction(null)}
								/>
							),
						}}
					/>
				)}
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
			</main>
		</>
	)
}
