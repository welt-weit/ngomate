import { useCallback, useEffect, useRef, useState } from 'react'
import type { DownloadProgress, ModelEntry, NgomateHost, Recording, VoiceInfo } from './host.js'

/** Whisper reads speech at this rate, in one channel. */
const SAMPLE_RATE = 16_000
/** The same limit the host keeps: a recording stops by itself after two minutes. */
export const MAX_SECONDS = 120

/** Starts recording from the microphone. Throws with a reason the person can act on. */
export type Recorder = () => Promise<Recording>

/** One channel at 16 kHz, whatever the microphone gave. */
async function toWhisperSamples(audio: ArrayBuffer): Promise<Float32Array> {
	const decoded = await new AudioContext().decodeAudioData(audio)
	const length = Math.ceil(decoded.duration * SAMPLE_RATE)
	if (!length) return new Float32Array()
	const offline = new OfflineAudioContext(1, length, SAMPLE_RATE)
	const source = offline.createBufferSource()
	source.buffer = decoded
	source.connect(offline.destination)
	source.start()
	return (await offline.startRendering()).getChannelData(0)
}

/** Recording in the window itself, as a browser does it. The sound is only kept until it is text. */
export const webRecorder: Recorder = async () => {
	if (!navigator.mediaDevices?.getUserMedia) throw new Error('This window cannot use a microphone.')
	let stream: MediaStream
	try {
		stream = await navigator.mediaDevices.getUserMedia({ audio: true })
	} catch (err) {
		throw new Error(
			err instanceof DOMException && err.name === 'NotAllowedError'
				? 'NGOmate may not use the microphone. Allow it under System Settings, Privacy & Security, Microphone.'
				: 'No microphone was found.',
		)
	}
	const chunks: Blob[] = []
	const recorder = new MediaRecorder(stream)
	recorder.ondataavailable = (event) => chunks.push(event.data)
	const ended = new Promise<void>((resolve) => {
		recorder.onstop = () => resolve()
	})
	recorder.start()
	const release = () => {
		for (const track of stream.getTracks()) track.stop()
	}
	return {
		async stop() {
			if (recorder.state !== 'inactive') recorder.stop()
			await ended
			release()
			return toWhisperSamples(await new Blob(chunks).arrayBuffer())
		},
		cancel() {
			if (recorder.state !== 'inactive') recorder.stop()
			release()
		},
	}
}

export type VoiceStatus =
	/** Ready to listen, or not set up yet. */
	| { kind: 'idle' }
	/** The voice model is being fetched. */
	| { kind: 'getting-ready'; progress: DownloadProgress | null }
	| { kind: 'listening'; since: number }
	/** The recording is being turned into text. */
	| { kind: 'writing' }

/** The voice model to use: the one chosen under Built-in tools, else the size that suits the computer. */
export function voiceModel(info: VoiceInfo, chosen: string | undefined): ModelEntry | undefined {
	return (
		info.models.find((model) => model.id === chosen && model.installed) ??
		info.models.find((model) => model.installed) ??
		info.models.find((model) => model.id === info.recommended)
	)
}

/**
 * Voice input for a message: press to listen, press again to have it written down. The words go to
 * `onText`, for the person to read and change before sending; nothing is sent on its own.
 */
export function useVoice(
	host: NgomateHost,
	chosen: string | undefined,
	onText: (text: string) => void,
) {
	const voice = host.voice
	const recorder: Recorder = voice?.record ? () => (voice.record as Recorder)() : webRecorder
	const [status, setStatus] = useState<VoiceStatus>({ kind: 'idle' })
	const [problem, setProblem] = useState<string | null>(null)
	// Asked before the first download: a model the person has not agreed to fetch yet.
	const [needsSetup, setNeedsSetup] = useState<ModelEntry | null>(null)
	const recording = useRef<Recording | null>(null)
	const limit = useRef<ReturnType<typeof setTimeout> | null>(null)
	const onTextRef = useRef(onText)
	onTextRef.current = onText

	// A recording never outlives the chat it was started in.
	useEffect(
		() => () => {
			if (limit.current) clearTimeout(limit.current)
			recording.current?.cancel()
		},
		[],
	)

	const finish = useCallback(async () => {
		const current = recording.current
		if (!current || !voice) return
		recording.current = null
		if (limit.current) clearTimeout(limit.current)
		setStatus({ kind: 'writing' })
		try {
			const samples = await current.stop()
			const info = await voice.info()
			const model = voiceModel(info, chosen)
			if (!model?.installed) throw new Error('The voice model is not downloaded yet.')
			const text = await voice.transcribe(model.id, samples)
			if (text) onTextRef.current(text)
			else setProblem('Nothing was heard. Speak a little closer to the microphone.')
		} catch (err) {
			setProblem(err instanceof Error ? err.message : String(err))
		} finally {
			setStatus({ kind: 'idle' })
		}
	}, [voice, chosen])

	const listen = useCallback(async () => {
		if (!voice) return
		setProblem(null)
		try {
			const model = voiceModel(await voice.info(), chosen)
			if (!model) throw new Error('No voice model is offered for this computer.')
			if (!model.installed) {
				setNeedsSetup(model)
				return
			}
			recording.current = await recorder()
			setStatus({ kind: 'listening', since: Date.now() })
			limit.current = setTimeout(() => void finish(), MAX_SECONDS * 1000)
		} catch (err) {
			recording.current = null
			setStatus({ kind: 'idle' })
			setProblem(err instanceof Error ? err.message : String(err))
		}
	}, [voice, chosen, recorder, finish])

	/** Fetches the voice model the person agreed to; they press the microphone again once it is ready. */
	const setUp = useCallback(
		async (model: ModelEntry) => {
			if (!voice) return
			setNeedsSetup(null)
			setProblem(null)
			setStatus({ kind: 'getting-ready', progress: null })
			try {
				await voice.download(model.id, (progress) => setStatus({ kind: 'getting-ready', progress }))
			} catch (err) {
				setProblem(err instanceof Error ? err.message : String(err))
			} finally {
				setStatus({ kind: 'idle' })
			}
		},
		[voice],
	)

	return {
		available: Boolean(voice),
		status,
		problem,
		needsSetup,
		/** The microphone button: listen, or finish listening. */
		press: () => (status.kind === 'listening' ? finish() : listen()),
		setUp,
		dismissSetup: () => setNeedsSetup(null),
	}
}
