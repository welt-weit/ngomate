import { useCallback, useEffect, useState } from 'react'
import { formatBytes } from './format.js'
import type { DownloadProgress, NgomateHost, Settings, VoiceInfo } from './host.js'
import { usePrimitives } from './primitives.js'
import { voiceModel } from './useVoice.js'

/** Plain words for each voice model, smallest first in what it asks of the computer. */
const ABOUT: Record<string, string> = {
	'whisper-tiny-q5':
		'Quickest, and fine for short, clear messages. For a computer with little memory.',
	'whisper-base-q5': 'Good for most computers and most voices.',
	'whisper-small-q5': 'Hears accents and noisy rooms best. Slower, for a newer computer.',
}

/**
 * Built-in tools: what the app adds on this computer, beside the model and the connectors. For now,
 * voice input, whose model is fetched on the first press of the microphone and managed here.
 */
export function ToolsPanel({
	host,
	settings,
	onChange,
}: {
	host: NgomateHost
	settings: Settings
	onChange: (settings: Settings) => void
}) {
	const { Button, Chip } = usePrimitives()
	const voice = host.voice
	const [info, setInfo] = useState<VoiceInfo | null>(null)
	const [progress, setProgress] = useState<Record<string, DownloadProgress>>({})
	const [problem, setProblem] = useState<string | null>(null)

	const refresh = useCallback(async () => {
		if (!voice) return
		try {
			setInfo(await voice.info())
		} catch (err) {
			setProblem(err instanceof Error ? err.message : String(err))
		}
	}, [voice])
	useEffect(() => {
		void refresh()
	}, [refresh])

	const act = async (work: () => Promise<void>) => {
		setProblem(null)
		try {
			await work()
		} catch (err) {
			setProblem(err instanceof Error ? err.message : String(err))
		} finally {
			await refresh()
		}
	}

	if (!voice) {
		return (
			<section className="ngm-panel">
				<h2>Built-in tools</h2>
				<p className="ngm-muted">This app has no built-in tools.</p>
			</section>
		)
	}

	const inUse = info ? voiceModel(info, settings.voiceModel) : undefined
	return (
		<section className="ngm-panel">
			<h2>Built-in tools</h2>
			<p className="ngm-muted">
				What NGOmate adds on this computer. Each works without the internet once it is set up.
			</p>
			<section className="ngm-tool-card" aria-label="Voice">
				<h3>Voice</h3>
				<p>
					Speak instead of typing: press the microphone in the message field, and what you say is
					written into it for you to read before sending.
				</p>
				<p className="ngm-muted">
					It is turned into text on this computer and then dropped. Nothing is recorded or sent
					anywhere.
				</p>
				{problem && (
					<p className="ngm-error" role="alert">
						{problem}
					</p>
				)}
				{!info ? (
					<p className="ngm-muted">Looking…</p>
				) : (
					<ul className="ngm-tool-options">
						{info.models.map((model) => {
							const running = progress[model.id] ?? model.download
							const used = inUse?.id === model.id && model.installed
							return (
								<li key={model.id}>
									<div className="ngm-tool-option-head">
										<strong>{model.name}</strong>
										<span className="ngm-muted">{formatBytes(model.sizeBytes)}</span>
										{used && <Chip>In use</Chip>}
										{!model.installed && model.id === info.recommended && (
											<Chip>Suits this computer</Chip>
										)}
									</div>
									<p className="ngm-muted">{ABOUT[model.id] ?? ''}</p>
									<div className="ngm-row">
										{running ? (
											<>
												<span className="ngm-muted">
													{running.phase === 'verifying'
														? 'Checking the download…'
														: `${formatBytes(running.receivedBytes)} of ${formatBytes(running.totalBytes)}`}
												</span>
												<Button onClick={() => void act(() => voice.cancelDownload(model.id))}>
													Pause
												</Button>
											</>
										) : model.installed ? (
											<>
												{!used && (
													<Button
														variant="primary"
														onClick={() => onChange({ ...settings, voiceModel: model.id })}
													>
														Use this
													</Button>
												)}
												<Button
													variant="quiet"
													onClick={() =>
														void act(async () => {
															await voice.remove(model.id)
															if (settings.voiceModel === model.id)
																onChange({ ...settings, voiceModel: undefined })
														})
													}
												>
													Remove
												</Button>
											</>
										) : (
											<Button
												onClick={() =>
													void act(async () => {
														try {
															await voice.download(model.id, (next) =>
																setProgress((all) => ({ ...all, [model.id]: next })),
															)
														} finally {
															// Finished, paused or failed: the row shows what the computer has now.
															setProgress(({ [model.id]: _done, ...rest }) => rest)
														}
														if (!inUse?.installed) onChange({ ...settings, voiceModel: model.id })
													})
												}
											>
												{model.partialBytes ? 'Go on downloading' : 'Download'}
											</Button>
										)}
									</div>
								</li>
							)
						})}
					</ul>
				)}
			</section>
		</section>
	)
}
