import type { MemoryNote } from '@ngomate/core'
import { useCallback, useEffect, useState } from 'react'
import { formatBytes, recommendedModelId } from './format.js'
import type { DownloadProgress, ModelInfo, NgomateHost, Settings } from './host.js'
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
					{!info.folderAvailable && (
						<p className="ngm-notice">
							The model folder is not available, so its models cannot be used. Connect its drive, or
							choose another folder.
						</p>
					)}
					<div className="ngm-row">
						<span className="ngm-muted ngm-grow">Kept in {info.folder}</span>
						<Button
							onClick={() => guarded(() => models.chooseFolder())}
							disabled={Boolean(progress)}
						>
							Change folder
						</Button>
						{!info.folderIsDefault && (
							<Button
								onClick={() => guarded(() => models.resetFolder())}
								disabled={Boolean(progress)}
							>
								Use the usual folder
							</Button>
						)}
					</div>
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
