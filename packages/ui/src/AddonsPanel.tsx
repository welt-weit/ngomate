import { type ToolDefinition, isDestructiveTool, isKnowledgeTool } from '@ngomate/core'
import { type FormEvent, useCallback, useEffect, useRef, useState } from 'react'
import { makeId } from './format.js'
import type { Addon, AddonConnection, NgomateHost, Settings } from './host.js'
import { usePrimitives } from './primitives.js'

type PanelProps = { host: NgomateHost; settings: Settings; onChange: (settings: Settings) => void }

/** Known to work over the standard. None is required, and each brings its own account. */
const SUGGESTED: { name: string; url: string; about: string; note?: string; tokenHelp: string }[] =
	[
		{
			name: 'Action Network Worldwide',
			url: 'https://api.actionnetwork.world/v1/mcp',
			about: 'Find funding opportunities, and work with your workspaces and wiki.',
			tokenHelp: 'An access token from your Action Network Worldwide account.',
		},
		{
			name: 'Apify',
			url: 'https://mcp.apify.com',
			about: 'Search the web and read pages.',
			note: 'Apify bills your account by use.',
			tokenHelp: 'An API token from your Apify account.',
		},
	]

/** A command line as words, keeping a quoted path with spaces in one piece. No shell ever sees it. */
export function splitCommand(line: string): string[] {
	return (line.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((word) =>
		word.replace(/^(["'])(.*)\1$/, '$2'),
	)
}

/** What went wrong, in words a person can act on. The technical text stays out of the way. */
export function connectionProblem(err: unknown): string {
	const text = err instanceof Error ? err.message : String(err)
	// The protocol library keeps the HTTP status in `code`. Its message can be empty of any detail.
	const status = (err as { code?: unknown } | null)?.code
	if (status === 401 || status === 403 || /\b40[13]\b|unauthori[sz]ed|forbidden/i.test(text)) {
		return 'The token was not accepted. Check that you copied all of it and that it has not expired.'
	}
	if (status === 404 || /\b404\b/.test(text))
		return 'Nothing answered at that address. Check that it is right.'
	if (/not to run this program/i.test(text)) return text
	if (/could not start/i.test(text)) return `The program could not start. ${text}`
	if (/fetch|network|load failed|timed? ?out|dns|connect/i.test(text)) {
		return 'Could not reach it. Check your internet connection and the address.'
	}
	return `It could not connect: ${text}`
}

const readable = (name: string) => {
	const words = name.replace(/[_-]+/g, ' ').trim()
	return words.charAt(0).toUpperCase() + words.slice(1)
}

const count = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`

function describeTools(reading: number, changing: number): string {
	const read = `${count(reading, 'tool')} to read`
	return changing
		? `${read}, ${count(changing, 'tool')} to change things after asking you.`
		: `${read}.`
}

type Status =
	| { state: 'checking' }
	| { state: 'connected'; tools: ToolDefinition[] }
	| { state: 'problem'; message: string }
	| { state: 'unchecked' }

function ToolGroup({
	title,
	help,
	tools,
	addon,
	update,
}: {
	title: string
	help: string
	tools: ToolDefinition[]
	addon: Addon
	update: (change: Partial<Addon>) => void
}) {
	const { Checkbox } = usePrimitives()
	if (!tools.length) return null
	return (
		<div className="ngm-tool-group">
			<h4>{title}</h4>
			<p className="ngm-muted">{help}</p>
			{tools.map((tool) => (
				<label className="ngm-tool-switch" key={tool.name}>
					<Checkbox
						checked={!addon.disabledTools?.includes(tool.name)}
						onChange={(event) =>
							update({
								disabledTools: event.target.checked
									? addon.disabledTools?.filter((name) => name !== tool.name)
									: [...(addon.disabledTools ?? []), tool.name],
							})
						}
					/>
					<span>
						{readable(tool.name)}
						{tool.description && (
							<span className="ngm-muted ngm-tool-about">{tool.description}</span>
						)}
					</span>
				</label>
			))}
		</div>
	)
}

function ConnectedAddon({ addon, host, settings, onChange }: PanelProps & { addon: Addon }) {
	const { Button, Checkbox, Chip, Dialog, Input } = usePrimitives()
	const isProgram = addon.connection.kind === 'command'
	// A program is not started just because this screen opened.
	const [status, setStatus] = useState<Status>(
		isProgram ? { state: 'unchecked' } : { state: 'checking' },
	)
	const [open, setOpen] = useState(false)
	const [token, setToken] = useState('')

	const update = (change: Partial<Addon>) =>
		onChange({
			...settings,
			addons: settings.addons.map((other) =>
				other.id === addon.id ? { ...other, ...change } : other,
			),
		})

	// A slow check must not overwrite the result of a newer one, or a switch made since.
	const latestCheck = useRef(0)
	const check = useCallback(async () => {
		const thisCheck = ++latestCheck.current
		setStatus({ state: 'checking' })
		try {
			const source = await host.connectAddon(addon)
			try {
				const tools = await source.listTools()
				if (thisCheck === latestCheck.current) setStatus({ state: 'connected', tools })
			} finally {
				await source.close()
			}
		} catch (err) {
			if (thisCheck === latestCheck.current)
				setStatus({ state: 'problem', message: connectionProblem(err) })
		}
	}, [host, addon])

	const url = addon.connection.kind === 'http' ? addon.connection.url : null
	// biome-ignore lint/correctness/useExhaustiveDependencies: checks once, and again for a new address
	useEffect(() => {
		if (!isProgram && addon.enabled) check()
		else if (!addon.enabled) {
			latestCheck.current++
			setStatus({ state: 'unchecked' })
		}
	}, [url, addon.enabled])

	const tools = status.state === 'connected' ? status.tools : []
	const deleting = tools.filter(isDestructiveTool)
	const others = tools.filter((tool) => !isDestructiveTool(tool))
	const reading = others.filter((tool) => tool.annotations?.readOnly === true)
	const changing = others.filter((tool) => tool.annotations?.readOnly !== true)
	const offered = (list: ToolDefinition[]) =>
		list.filter((tool) => !addon.disabledTools?.includes(tool.name)).length
	const searchesKnowledge = tools.some(
		(tool) => isKnowledgeTool(tool) && !addon.disabledTools?.includes(tool.name),
	)

	const summary =
		status.state === 'checking'
			? 'Checking the connection…'
			: status.state === 'problem'
				? status.message
				: status.state === 'connected'
					? describeTools(offered(reading), changing.length ? offered(changing) : 0)
					: addon.enabled
						? 'A program on this computer. It starts when a message needs it.'
						: 'Turned off.'

	const about = SUGGESTED.find((item) => item.url === url)?.about

	return (
		<div className="ngm-card ngm-addon-card">
			<div className="ngm-row">
				<strong>{addon.name}</strong>
				{status.state === 'connected' && <Chip>Connected</Chip>}
				{status.state === 'problem' && <Chip>Not connected</Chip>}
				{!addon.enabled && <Chip>Off</Chip>}
			</div>
			{status.state === 'problem' ? (
				<p className="ngm-error" role="alert">
					{summary}
				</p>
			) : (
				<p className="ngm-muted">{about ?? addon.note ?? summary}</p>
			)}
			{about && status.state !== 'problem' && <p className="ngm-muted">{summary}</p>}
			<div className="ngm-addon-card-action">
				<Button aria-label={`Manage ${addon.name}`} onClick={() => setOpen(true)}>
					Manage
				</Button>
			</div>

			{open && (
				<Dialog title={addon.name} onClose={() => setOpen(false)}>
					<div className="ngm-addon-details">
						<label className="ngm-inline">
							<Checkbox
								checked={addon.enabled}
								onChange={(event) => update({ enabled: event.target.checked })}
							/>{' '}
							Let the assistant use this
						</label>
						{status.state === 'problem' ? (
							<div className="ngm-row">
								<p className="ngm-error ngm-grow">{status.message}</p>
								<Button onClick={check}>Try again</Button>
							</div>
						) : (
							<p className="ngm-muted">{summary}</p>
						)}
						{addon.note && <p className="ngm-muted">{addon.note}</p>}
						{isProgram && status.state !== 'connected' && (
							<div>
								<Button onClick={check}>See what it can do</Button>
							</div>
						)}
						<ToolGroup
							title="It can read"
							help="Used without asking. What it reads goes to your model."
							tools={reading}
							addon={addon}
							update={update}
						/>
						<ToolGroup
							title="It can change, after asking you"
							help="You see exactly what it will do, every time, and can say no."
							tools={changing}
							addon={addon}
							update={update}
						/>
						{deleting.length > 0 && (
							<div className="ngm-tool-group">
								<h4>It could delete or archive</h4>
								<p className="ngm-muted">
									{deleting.length} {deleting.length === 1 ? 'tool' : 'tools'} kept off, because
									they cannot be undone.
								</p>
								<label className="ngm-inline">
									<Checkbox
										checked={addon.allowDestructive}
										onChange={(event) => update({ allowDestructive: event.target.checked })}
									/>{' '}
									Allow these too, still asking first
								</label>
							</div>
						)}
						{addon.enabled && searchesKnowledge && (
							<p className="ngm-muted">
								Each question you ask in chat is also sent to its knowledge search, so answers can
								draw on it. Your documents are not sent. Turn off the knowledge search tool to stop
								this.
							</p>
						)}
						{status.state === 'connected' && (
							<p className="ngm-muted">
								Turning off what you do not use leaves the assistant fewer tools to choose from,
								which can make it faster.
							</p>
						)}
						<dl className="ngm-addon-facts">
							<dt>{isProgram ? 'Program' : 'Address'}</dt>
							<dd>
								{addon.connection.kind === 'http'
									? addon.connection.url
									: [addon.connection.command, ...addon.connection.args].join(' ')}
							</dd>
						</dl>
						{!isProgram && (
							<form
								className="ngm-row"
								onSubmit={async (event) => {
									event.preventDefault()
									if (!token) return
									await host.setSecret(`addon:${addon.id}`, token)
									setToken('')
									await check()
								}}
							>
								<Input
									aria-label={`New token for ${addon.name}`}
									type="password"
									placeholder="Replace the token"
									autoComplete="off"
									value={token}
									onChange={(event) => setToken(event.target.value)}
									style={{ flex: 1 }}
								/>
								<Button type="submit" disabled={!token}>
									Save
								</Button>
							</form>
						)}
						<div>
							<Button
								onClick={async () => {
									await host.deleteSecret(`addon:${addon.id}`)
									onChange({
										...settings,
										addons: settings.addons.filter((other) => other.id !== addon.id),
									})
								}}
							>
								Remove {addon.name}
							</Button>
						</div>
					</div>
				</Dialog>
			)}
		</div>
	)
}

type Draft =
	| { kind: 'suggested'; name: string; url: string; note?: string; tokenHelp: string }
	| { kind: 'own' }

function ConnectForm({
	draft,
	host,
	settings,
	onChange,
	onDone,
	onBusy,
}: PanelProps & {
	draft: Draft
	onDone: () => void
	onBusy: (busy: boolean) => void
}) {
	const { Button, Input, Select } = usePrimitives()
	const [ownKind, setOwnKind] = useState<'http' | 'command'>('http')
	const [name, setName] = useState('')
	const [url, setUrl] = useState('')
	const [command, setCommand] = useState('')
	const [token, setToken] = useState('')
	const [connecting, setConnecting] = useState(false)
	const [problem, setProblem] = useState<string | null>(null)

	const suggested = draft.kind === 'suggested' ? draft : null
	const isProgram = !suggested && ownKind === 'command'

	const connect = async (event: FormEvent) => {
		event.preventDefault()
		setConnecting(true)
		onBusy(true)
		setProblem(null)
		const id = makeId('addon')
		const [program = '', ...args] = splitCommand(command)
		const connection: AddonConnection = isProgram
			? { kind: 'command', command: program, args }
			: { kind: 'http', url: suggested?.url ?? url.trim() }
		const addon: Addon = {
			id,
			name: suggested?.name ?? name.trim(),
			connection,
			enabled: true,
			allowDestructive: false,
			note: suggested?.note,
		}
		try {
			if (token && !isProgram) await host.setSecret(`addon:${id}`, token)
			// Checked before it is kept, so a wrong token is found here and not on a later message.
			const source = await host.connectAddon(addon)
			await source.close()
			onChange({ ...settings, addons: [...settings.addons, addon] })
			onDone()
		} catch (err) {
			await host.deleteSecret(`addon:${id}`).catch(() => {})
			setProblem(connectionProblem(err))
		} finally {
			setConnecting(false)
			onBusy(false)
		}
	}

	return (
		<form className="ngm-form" onSubmit={connect}>
			{!suggested && (
				<>
					<label>
						What should it be called?
						<Input value={name} onChange={(event) => setName(event.target.value)} required />
					</label>
					<label>
						Where does it run?
						<Select
							value={ownKind}
							onChange={(event) => setOwnKind(event.target.value as 'http' | 'command')}
						>
							<option value="http">A service on the web</option>
							<option value="command">A program on this computer</option>
						</Select>
					</label>
				</>
			)}
			{!suggested && !isProgram && (
				<label>
					Its MCP address
					<Input type="url" value={url} onChange={(event) => setUrl(event.target.value)} required />
				</label>
			)}
			{isProgram ? (
				<>
					<label>
						The command that starts it
						<Input value={command} onChange={(event) => setCommand(event.target.value)} required />
					</label>
					<p className="ngm-notice">
						This runs a program on your computer with your permissions, so only add one you trust.
						You will be asked to confirm the exact command first.
					</p>
				</>
			) : (
				<label>
					{suggested ? 'Paste your token' : 'Token, if it needs one'}
					<Input
						data-autofocus
						type="password"
						autoComplete="off"
						value={token}
						required={Boolean(suggested)}
						onChange={(event) => setToken(event.target.value)}
					/>
					<span className="ngm-muted">
						{suggested?.tokenHelp ?? 'From the service you are connecting.'} It is kept in this
						computer's keychain.
					</span>
				</label>
			)}
			{problem && (
				<p className="ngm-error" role="alert">
					{problem}
				</p>
			)}
			<div className="ngm-row">
				<Button type="submit" variant="primary" disabled={connecting}>
					{connecting ? 'Connecting…' : 'Connect'}
				</Button>
				<Button onClick={onDone} disabled={connecting}>
					Cancel
				</Button>
			</div>
		</form>
	)
}

export function AddonsPanel({ host, settings, onChange }: PanelProps) {
	const { Button, Dialog } = usePrimitives()
	const [draft, setDraft] = useState<Draft | null>(null)
	const [busy, setBusy] = useState(false)
	const available = SUGGESTED.filter(
		(item) =>
			!settings.addons.some(
				(addon) => addon.connection.kind === 'http' && addon.connection.url === item.url,
			),
	)

	return (
		<section className="ngm-panel">
			<h2>Connectors</h2>
			<p className="ngm-muted">
				Connect the tools you already use, so the assistant can look things up and do work in them.
				What it sends to a tool goes to that tool's service, and anything that would change
				something asks you first.
			</p>

			<div className="ngm-addon-grid">
				{settings.addons.map((addon) => (
					<ConnectedAddon
						key={addon.id}
						addon={addon}
						host={host}
						settings={settings}
						onChange={onChange}
					/>
				))}
				{available.map((item) => (
					<div className="ngm-card ngm-addon-card" key={item.name}>
						<strong>{item.name}</strong>
						<p className="ngm-muted">{item.about}</p>
						{item.note && <p className="ngm-muted">{item.note}</p>}
						<div className="ngm-addon-card-action">
							<Button
								variant="primary"
								aria-label={`Connect ${item.name}`}
								onClick={() => setDraft({ kind: 'suggested', ...item })}
							>
								Connect
							</Button>
						</div>
					</div>
				))}
				<div className="ngm-card ngm-addon-card">
					<strong>Something else</strong>
					<p className="ngm-muted">
						Any tool that speaks the Model Context Protocol, on the web or on this computer.
					</p>
					<div className="ngm-addon-card-action">
						<Button aria-label="Connect your own" onClick={() => setDraft({ kind: 'own' })}>
							Connect
						</Button>
					</div>
				</div>
			</div>

			{draft && (
				<Dialog
					title={draft.kind === 'suggested' ? `Connect ${draft.name}` : 'Connect your own'}
					onClose={() => !busy && setDraft(null)}
				>
					<ConnectForm
						draft={draft}
						host={host}
						settings={settings}
						onChange={onChange}
						onDone={() => setDraft(null)}
						onBusy={setBusy}
					/>
				</Dialog>
			)}
		</section>
	)
}
