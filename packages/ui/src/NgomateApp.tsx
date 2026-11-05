import type { PromptDefinition, TaskFile } from '@ngomate/core'
import { type CSSProperties, useCallback, useEffect, useMemo, useState } from 'react'
import { AddonsPanel } from './AddonsPanel.js'
import { Chat, type ChatStart } from './Chat.js'
import { makeId } from './format.js'
import { DEFAULT_SETTINGS, type NgomateHost, type Settings } from './host.js'
import { MemoryPanel, ModelPanel } from './panels.js'
import {
	DEFAULT_PRIMITIVES,
	type NgomatePrimitives,
	type NgomateTheme,
	PrimitivesProvider,
	themeVariables,
	usePrimitives,
} from './primitives.js'
import { useIdleUnload } from './useIdleUnload.js'

type View = 'chat' | 'model' | 'addons' | 'memory'

type ConnectorPrompt = PromptDefinition & { run: (args: Record<string, string>) => Promise<string> }

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
			<strong>{prompt.name}</strong>
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
	return (
		<PrimitivesProvider value={merged}>
			<div className="ngm-app" style={themeVariables(theme) as CSSProperties}>
				<AppContent {...props} />
			</div>
		</PrimitivesProvider>
	)
}

function AppContent({ host, embedded = false }: Pick<NgomateAppProps, 'host' | 'embedded'>) {
	const { Button } = usePrimitives()
	const [settings, setSettings] = useState<Settings | null>(null)
	const [view, setView] = useState<View>('chat')
	const [conversationId, setConversationId] = useState(() => makeId('chat'))
	const [conversations, setConversations] = useState<
		{ id: string; title: string; updatedAt: string }[]
	>([])
	const [start, setStart] = useState<ChatStart | null>(null)
	const [prompts, setPrompts] = useState<ConnectorPrompt[]>([])
	const [openPrompt, setOpenPrompt] = useState<ConnectorPrompt | null>(null)

	const refreshConversations = useCallback(async () => {
		const listed = await host.listConversations()
		setConversations([...listed].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)))
	}, [host])

	useEffect(() => {
		host.loadSettings().then(setSettings)
		refreshConversations()
	}, [host, refreshConversations])

	const updateSettings = useCallback(
		(next: Settings) => {
			setSettings(next)
			host.saveSettings(next)
		},
		[host],
	)

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
		const { baseUrl, apiKey, contextTokens } = await host.models.start(choice.id)
		return { client: host.createModelClient(baseUrl, choice.id, apiKey), contextTokens }
	}, [host, settings?.model])

	const deps = useMemo(
		() => ({
			host,
			settings: settings ?? DEFAULT_SETTINGS,
			getModel,
			onSaved: refreshConversations,
			onBusyChange,
		}),
		[host, settings, getModel, refreshConversations, onBusyChange],
	)

	const startNew = (begin: ChatStart | null = null) => {
		setConversationId(makeId('chat'))
		setStart(begin)
		setView('chat')
	}

	const clearStart = useCallback(() => setStart(null), [])

	if (!settings) return <div className="ngm-loading">Loading…</div>

	const nav = (target: View, label: string) => (
		<Button
			variant="nav"
			active={view === target}
			aria-current={view === target ? 'page' : undefined}
			onClick={() => setView(target)}
		>
			{label}
		</Button>
	)

	return (
		<>
			<aside className="ngm-sidebar">
				{!embedded && <h1 className="ngm-brand">{host.appName}</h1>}
				<Button variant="primary" onClick={() => startNew()}>
					New conversation
				</Button>

				<h2 className="ngm-side-title">Ready-made tasks</h2>
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
				{prompts.map((prompt) => (
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
						{prompt.name}
					</Button>
				))}

				<h2 className="ngm-side-title">Conversations</h2>
				<div className="ngm-side-list">
					{conversations.map((conversation) => (
						<div className="ngm-side-item" key={conversation.id}>
							<Button
								variant="nav"
								active={view === 'chat' && conversation.id === conversationId}
								onClick={() => {
									setConversationId(conversation.id)
									setView('chat')
								}}
							>
								{conversation.title}
							</Button>
							<Button
								variant="quiet"
								aria-label={`Delete ${conversation.title}`}
								onClick={async () => {
									await host.removeConversation(conversation.id)
									if (conversation.id === conversationId) startNew()
									await refreshConversations()
								}}
							>
								×
							</Button>
						</div>
					))}
				</div>

				<div className="ngm-side-bottom">
					{nav('model', 'Model')}
					{nav('addons', 'Connectors')}
					{nav('memory', 'Memory')}
				</div>
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
				{/* Stays on the page behind the settings, so opening them does not stop an answer being written. */}
				<div className="ngm-chat-holder" hidden={view !== 'chat'}>
					<Chat
						key={conversationId}
						deps={deps}
						conversationId={conversationId}
						start={start}
						onStarted={clearStart}
					/>
				</div>
				{view === 'model' && (
					<ModelPanel host={host} settings={settings} onChange={updateSettings} />
				)}
				{view === 'addons' && (
					<AddonsPanel host={host} settings={settings} onChange={updateSettings} />
				)}
				{view === 'memory' && <MemoryPanel host={host} />}
			</main>
		</>
	)
}
