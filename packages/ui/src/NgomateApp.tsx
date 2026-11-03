import type { ModelClient, PromptDefinition, TaskFile } from '@ngomate/core'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Chat, type ChatStart } from './Chat.js'
import { makeId } from './format.js'
import { DEFAULT_SETTINGS, type NgomateHost, type Settings } from './host.js'
import { AddonsPanel, MemoryPanel, ModelPanel } from './panels.js'

type View = 'chat' | 'model' | 'addons' | 'memory'

type ConnectorPrompt = PromptDefinition & { run: (args: Record<string, string>) => Promise<string> }

function PromptForm({
	prompt,
	onCancel,
	onReady,
}: { prompt: ConnectorPrompt; onCancel: () => void; onReady: (text: string) => void }) {
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
					<input
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
				<button type="submit" className="ngm-primary">
					Use
				</button>
				<button type="button" onClick={onCancel}>
					Cancel
				</button>
			</div>
		</form>
	)
}

export function NgomateApp({ host }: { host: NgomateHost }) {
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
	// biome-ignore lint/correctness/useExhaustiveDependencies: asks again when add-ons change
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

	const getModel = useCallback(async (): Promise<ModelClient> => {
		const choice = settings?.model
		if (!choice) throw new Error('Choose a model first, under Model.')
		if (choice.kind === 'server') {
			const key = await host.getSecret('model-server')
			return host.createModelClient(choice.baseUrl, choice.model, key ?? undefined)
		}
		if (!host.models)
			throw new Error('This app cannot run a local model. Choose a model server under Model.')
		// Asked every time: the host reuses a running model, and restarts one that has died.
		const { baseUrl, apiKey } = await host.models.start(choice.id)
		return host.createModelClient(baseUrl, choice.id, apiKey)
	}, [host, settings?.model])

	const deps = useMemo(
		() => ({
			host,
			settings: settings ?? DEFAULT_SETTINGS,
			getModel,
			onSaved: refreshConversations,
		}),
		[host, settings, getModel, refreshConversations],
	)

	const startNew = (begin: ChatStart | null = null) => {
		setConversationId(makeId('chat'))
		setStart(begin)
		setView('chat')
	}

	const clearStart = useCallback(() => setStart(null), [])

	if (!settings) return <div className="ngm-app ngm-loading">Loading…</div>

	const nav = (target: View, label: string) => (
		<button
			type="button"
			className={view === target ? 'ngm-nav ngm-nav-active' : 'ngm-nav'}
			aria-current={view === target ? 'page' : undefined}
			onClick={() => setView(target)}
		>
			{label}
		</button>
	)

	return (
		<div className="ngm-app">
			<aside className="ngm-sidebar">
				<h1 className="ngm-brand">{host.appName}</h1>
				<button type="button" className="ngm-primary" onClick={() => startNew()}>
					New conversation
				</button>

				<h2 className="ngm-side-title">Ready-made tasks</h2>
				{host.tasks.map((task: TaskFile) => (
					<button
						type="button"
						className="ngm-nav"
						key={task.id}
						title={task.description}
						onClick={() => startNew({ task })}
					>
						{task.title}
					</button>
				))}
				{prompts.map((prompt) => (
					<button
						type="button"
						className="ngm-nav"
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
					</button>
				))}

				<h2 className="ngm-side-title">Conversations</h2>
				<div className="ngm-side-list">
					{conversations.map((conversation) => (
						<div className="ngm-side-item" key={conversation.id}>
							<button
								type="button"
								className={
									view === 'chat' && conversation.id === conversationId
										? 'ngm-nav ngm-nav-active'
										: 'ngm-nav'
								}
								onClick={() => {
									setConversationId(conversation.id)
									setView('chat')
								}}
							>
								{conversation.title}
							</button>
							<button
								type="button"
								className="ngm-quiet"
								aria-label={`Delete ${conversation.title}`}
								onClick={async () => {
									await host.removeConversation(conversation.id)
									if (conversation.id === conversationId) startNew()
									await refreshConversations()
								}}
							>
								×
							</button>
						</div>
					))}
				</div>

				<div className="ngm-side-bottom">
					{nav('model', 'Model')}
					{nav('addons', 'Add-ons')}
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
				{view === 'chat' && (
					<Chat
						key={conversationId}
						deps={deps}
						conversationId={conversationId}
						start={start}
						onStarted={clearStart}
					/>
				)}
				{view === 'model' && (
					<ModelPanel host={host} settings={settings} onChange={updateSettings} />
				)}
				{view === 'addons' && (
					<AddonsPanel host={host} settings={settings} onChange={updateSettings} />
				)}
				{view === 'memory' && <MemoryPanel host={host} />}
			</main>
		</div>
	)
}
