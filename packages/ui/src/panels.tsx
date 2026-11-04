import type { MemoryNote, ToolDefinition } from '@ngomate/core'
import { isDestructiveTool } from '@ngomate/core'
import { useCallback, useEffect, useState } from 'react'
import { formatBytes, makeId, recommendedModelId } from './format.js'
import type { Addon, DownloadProgress, ModelInfo, NgomateHost, Settings } from './host.js'
import { usePrimitives } from './primitives.js'

type PanelProps = { host: NgomateHost; settings: Settings; onChange: (settings: Settings) => void }

export function ModelPanel({ host, settings, onChange }: PanelProps) {
	const { Button, Chip } = usePrimitives()
	const [info, setInfo] = useState<ModelInfo | null>(null)
	const [progress, setProgress] = useState<DownloadProgress | null>(null)
	const [problem, setProblem] = useState<string | null>(null)
	const models = host.models

	const refresh = useCallback(async () => {
		if (models) setInfo(await models.info())
	}, [models])

	useEffect(() => {
		refresh().catch((err) => setProblem(String(err)))
	}, [refresh])

	const guarded = async (action: () => Promise<unknown>) => {
		setProblem(null)
		try {
			await action()
		} catch (err) {
			setProblem(err instanceof Error ? err.message : String(err))
		}
		await refresh().catch(() => {})
	}

	const server = settings.model?.kind === 'server' ? settings.model : null
	const recommended = info ? recommendedModelId(info.models, info.ramGb, info.freeDiskBytes) : null

	return (
		<section className="ngm-panel">
			<h2>Model</h2>
			{models && info && (
				<>
					<p className="ngm-muted">
						This computer has {info.ramGb} GB of memory and {formatBytes(info.freeDiskBytes)} of
						free disk. Models run here and nothing you type leaves this computer.
					</p>
					{info.freeRamGb > 0 && info.freeRamGb < 4 && !info.runningId && (
						<p className="ngm-notice">
							Only {info.freeRamGb} GB of memory is free right now. Close other programs if the
							model is slow to start.
						</p>
					)}
					{info.models.map((model) => {
						const downloading = progress?.id === model.id
						const selected = settings.model?.kind === 'local' && settings.model.id === model.id
						const tooBig = model.minRamGb > info.ramGb
						return (
							<div className="ngm-card" key={model.id}>
								<div className="ngm-row">
									<strong>{model.name}</strong>
									{model.id === recommended && <Chip>Recommended for this computer</Chip>}
									{selected && <Chip>In use</Chip>}
								</div>
								<p className="ngm-muted">
									{model.vendor} · {model.license} · {formatBytes(model.sizeBytes)} · needs{' '}
									{model.minRamGb} GB of memory
								</p>
								{tooBig && (
									<p className="ngm-notice">
										This computer has less memory than this model needs. It may be very slow.
									</p>
								)}
								{downloading && progress && (
									<>
										<progress max={progress.totalBytes} value={progress.receivedBytes} />
										<p className="ngm-muted">
											{progress.phase === 'verifying'
												? 'Checking the file…'
												: `${formatBytes(progress.receivedBytes)} of ${formatBytes(progress.totalBytes)}`}
										</p>
									</>
								)}
								<div className="ngm-row">
									{model.installed ? (
										<>
											<Button
												variant="primary"
												disabled={selected}
												onClick={() =>
													onChange({ ...settings, model: { kind: 'local', id: model.id } })
												}
											>
												Use this model
											</Button>
											<Button
												onClick={() =>
													guarded(async () => {
														await models.remove(model.id)
														if (selected) onChange({ ...settings, model: null })
													})
												}
											>
												Remove
											</Button>
										</>
									) : downloading ? (
										<Button onClick={() => models.cancelDownload(model.id)}>Pause</Button>
									) : (
										<>
											<Button
												variant="primary"
												disabled={Boolean(progress)}
												onClick={() =>
													guarded(async () => {
														try {
															await models.download(model.id, setProgress)
														} finally {
															setProgress(null)
														}
													})
												}
											>
												{model.partialBytes > 0
													? `Resume (${formatBytes(model.partialBytes)} done)`
													: 'Download'}
											</Button>
											<Button onClick={() => guarded(() => models.importFile(model.id))}>
												From a file
											</Button>
											{model.partialBytes > 0 && (
												<Button onClick={() => guarded(() => models.remove(model.id))}>
													Discard download
												</Button>
											)}
										</>
									)}
								</div>
							</div>
						)
					})}
				</>
			)}
			{problem && (
				<p className="ngm-error" role="alert">
					{problem}
				</p>
			)}

			<h3>Or use a model server you run</h3>
			<p className="ngm-muted">
				Anything that speaks the chat completions format, such as Ollama on this computer. If the
				address is not on this computer, what you type goes there.
			</p>
			<ServerForm host={host} settings={settings} onChange={onChange} initial={server} />
		</section>
	)
}

function ServerForm({
	host,
	settings,
	onChange,
	initial,
}: PanelProps & { initial: { baseUrl: string; model: string } | null }) {
	const { Button, Input, Chip } = usePrimitives()
	const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? 'http://127.0.0.1:11434/v1')
	const [model, setModel] = useState(initial?.model ?? '')
	const [key, setKey] = useState('')
	return (
		<form
			className="ngm-form"
			onSubmit={async (event) => {
				event.preventDefault()
				if (key) await host.setSecret('model-server', key)
				setKey('')
				onChange({
					...settings,
					model: { kind: 'server', baseUrl: baseUrl.trim(), model: model.trim() },
				})
			}}
		>
			<label>
				Address
				<Input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} required />
			</label>
			<label>
				Model name
				<Input value={model} onChange={(event) => setModel(event.target.value)} required />
			</label>
			<label>
				Key, if it needs one
				<Input
					type="password"
					value={key}
					onChange={(event) => setKey(event.target.value)}
					autoComplete="off"
				/>
			</label>
			<div className="ngm-row">
				<Button type="submit">{initial ? 'Update' : 'Use this server'}</Button>
				{initial && <Chip>In use</Chip>}
			</div>
		</form>
	)
}

/** Connectors known to work over the standard. None is required, and each brings its own account. */
const PRESETS: { name: string; url: string; note: string; keyHelp: string }[] = [
	{
		name: 'Action Network Worldwide',
		url: 'https://api.actionnetwork.world/v1/mcp',
		note: 'Funding opportunities, workspaces and wiki on the Action Network Worldwide platform.',
		keyHelp: 'An access token from your Action Network Worldwide account.',
	},
	{
		name: 'Apify',
		url: 'https://mcp.apify.com',
		note: 'Web search and scraping. Apify bills your account by use.',
		keyHelp: 'An API token from your Apify account.',
	},
]

function AddonRow({ addon, host, settings, onChange }: PanelProps & { addon: Addon }) {
	const { Button, Checkbox } = usePrimitives()
	const [state, setState] = useState<{
		checking: boolean
		tools?: ToolDefinition[]
		problem?: string
	}>({ checking: false })
	const update = (change: Partial<Addon>) =>
		onChange({
			...settings,
			addons: settings.addons.map((other) =>
				other.id === addon.id ? { ...other, ...change } : other,
			),
		})

	const check = async () => {
		setState({ checking: true })
		try {
			const source = await host.connectAddon(addon)
			try {
				setState({ checking: false, tools: await source.listTools() })
			} finally {
				await source.close()
			}
		} catch (err) {
			setState({ checking: false, problem: err instanceof Error ? err.message : String(err) })
		}
	}

	const hidden = state.tools?.filter(isDestructiveTool).length ?? 0
	return (
		<div className="ngm-card">
			<div className="ngm-row">
				<strong>{addon.name}</strong>
				<span className="ngm-grow" />
				<label className="ngm-inline">
					<Checkbox
						checked={addon.enabled}
						onChange={(event) => update({ enabled: event.target.checked })}
					/>{' '}
					On
				</label>
			</div>
			<p className="ngm-muted">
				{addon.connection.kind === 'http'
					? addon.connection.url
					: [addon.connection.command, ...addon.connection.args].join(' ')}
			</p>
			{addon.note && <p className="ngm-muted">{addon.note}</p>}
			<label className="ngm-inline">
				<Checkbox
					checked={addon.allowDestructive}
					onChange={(event) => update({ allowDestructive: event.target.checked })}
				/>{' '}
				Also offer tools that delete or archive
			</label>
			{state.tools && (
				<p className="ngm-muted">
					Connected: {state.tools.length} tools
					{hidden && !addon.allowDestructive
						? `, ${hidden} hidden because they delete or archive`
						: ''}
					.
				</p>
			)}
			{state.tools && (
				<details>
					<summary className="ngm-muted">Choose which tools it can use</summary>
					{state.tools
						.filter((tool) => addon.allowDestructive || !isDestructiveTool(tool))
						.map((tool) => (
							<label
								className="ngm-inline ngm-tool-switch"
								key={tool.name}
								title={tool.description}
							>
								<Checkbox
									checked={!addon.disabledTools?.includes(tool.name)}
									onChange={(event) =>
										update({
											disabledTools: event.target.checked
												? addon.disabledTools?.filter((name) => name !== tool.name)
												: [...(addon.disabledTools ?? []), tool.name],
										})
									}
								/>{' '}
								{tool.name}
							</label>
						))}
				</details>
			)}
			{state.problem && (
				<p className="ngm-error" role="alert">
					{state.problem}
				</p>
			)}
			<div className="ngm-row">
				<Button onClick={check} disabled={state.checking}>
					{state.checking ? 'Checking…' : 'Check connection'}
				</Button>
				<Button
					onClick={async () => {
						await host.deleteSecret(`addon:${addon.id}`)
						onChange({
							...settings,
							addons: settings.addons.filter((other) => other.id !== addon.id),
						})
					}}
				>
					Remove
				</Button>
			</div>
		</div>
	)
}

export function AddonsPanel({ host, settings, onChange }: PanelProps) {
	const { Button, Input, Select } = usePrimitives()
	const [kind, setKind] = useState<'http' | 'command'>('http')
	const [name, setName] = useState('')
	const [url, setUrl] = useState('')
	const [command, setCommand] = useState('')
	const [token, setToken] = useState('')
	const [note, setNote] = useState<string | undefined>()
	const [keyHelp, setKeyHelp] = useState<string | null>(null)

	const add = async () => {
		const id = makeId('addon')
		if (token) await host.setSecret(`addon:${id}`, token)
		const [program = '', ...args] = command.trim().split(/\s+/)
		const addon: Addon = {
			id,
			name: name.trim(),
			connection: kind === 'http' ? { kind, url: url.trim() } : { kind, command: program, args },
			enabled: true,
			allowDestructive: false,
			note,
		}
		onChange({ ...settings, addons: [...settings.addons, addon] })
		setName('')
		setUrl('')
		setCommand('')
		setToken('')
		setNote(undefined)
		setKeyHelp(null)
	}

	return (
		<section className="ngm-panel">
			<h2>Add-ons</h2>
			<p className="ngm-muted">
				Add-ons connect other tools through the Model Context Protocol. What the assistant sends to
				a tool goes to that tool's service. Anything that changes something asks you first.
			</p>
			{settings.addons.map((addon) => (
				<AddonRow
					key={addon.id}
					addon={addon}
					host={host}
					settings={settings}
					onChange={onChange}
				/>
			))}

			<h3>Add one</h3>
			<div className="ngm-row">
				{PRESETS.filter(
					(preset) => !settings.addons.some((addon) => addon.name === preset.name),
				).map((preset) => (
					<Button
						key={preset.name}
						onClick={() => {
							setKind('http')
							setName(preset.name)
							setUrl(preset.url)
							setNote(preset.note)
							setKeyHelp(preset.keyHelp)
						}}
					>
						{preset.name}
					</Button>
				))}
			</div>
			<form
				className="ngm-form"
				onSubmit={(event) => {
					event.preventDefault()
					add()
				}}
			>
				<label>
					Name
					<Input value={name} onChange={(event) => setName(event.target.value)} required />
				</label>
				<label>
					Type
					<Select
						value={kind}
						onChange={(event) => setKind(event.target.value as 'http' | 'command')}
					>
						<option value="http">A service on the web</option>
						<option value="command">A program on this computer</option>
					</Select>
				</label>
				{kind === 'http' ? (
					<>
						<label>
							Address
							<Input
								type="url"
								value={url}
								onChange={(event) => setUrl(event.target.value)}
								required
							/>
						</label>
						<label>
							Token, if it needs one
							<Input
								type="password"
								value={token}
								onChange={(event) => setToken(event.target.value)}
								autoComplete="off"
							/>
							{keyHelp && <span className="ngm-muted">{keyHelp}</span>}
						</label>
					</>
				) : (
					<>
						<label>
							Command
							<Input
								value={command}
								onChange={(event) => setCommand(event.target.value)}
								required
							/>
						</label>
						<p className="ngm-notice">
							This runs a program on your computer with your permissions. Only add one you trust.
							You will be asked to confirm the exact command before it first runs.
						</p>
					</>
				)}
				<Button type="submit">Add</Button>
			</form>
		</section>
	)
}

export function MemoryPanel({ host }: { host: NgomateHost }) {
	const { Button, TextArea } = usePrimitives()
	const [notes, setNotes] = useState<MemoryNote[]>([])
	const [open, setOpen] = useState<{ name: string; text: string } | null>(null)

	const refresh = useCallback(async () => setNotes(await host.memory.list()), [host])
	useEffect(() => {
		refresh()
	}, [refresh])

	return (
		<section className="ngm-panel">
			<h2>Memory</h2>
			<p className="ngm-muted">
				Notes the assistant reads at the start of a conversation. They are plain Markdown files on
				this computer, and it asks you before saving one.
			</p>
			{notes.length === 0 && <p className="ngm-muted">No notes yet.</p>}
			{notes.map((note) => (
				<div className="ngm-row" key={note.name}>
					<Button
						variant="quiet"
						onClick={async () =>
							setOpen({ name: note.name, text: (await host.memory.read(note.name)) ?? '' })
						}
					>
						{note.name}
					</Button>
					<span className="ngm-grow" />
					<Button
						onClick={async () => {
							await host.memory.remove(note.name)
							if (open?.name === note.name) setOpen(null)
							await refresh()
						}}
					>
						Delete
					</Button>
				</div>
			))}
			{open && (
				<form
					className="ngm-form"
					onSubmit={async (event) => {
						event.preventDefault()
						await host.memory.write(open.name, open.text)
						await refresh()
					}}
				>
					<label>
						{open.name}
						<TextArea
							rows={12}
							value={open.text}
							onChange={(event) => setOpen({ ...open, text: event.target.value })}
						/>
					</label>
					<div className="ngm-row">
						<Button type="submit">Save</Button>
						<Button onClick={() => setOpen(null)}>Close</Button>
					</div>
				</form>
			)}
		</section>
	)
}
