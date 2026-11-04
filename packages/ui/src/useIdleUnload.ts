import { useCallback, useEffect, useRef } from 'react'

/** A loaded model holds gigabytes the person may want for other things, so it does not stay for long. */
export const IDLE_UNLOAD_MS = 10 * 60 * 1000

/**
 * Unloads the model once nothing has used it for a while, and when the interface goes away, which
 * inside another app is not when that app closes. The next message loads it again.
 */
export function useIdleUnload(unload: (() => Promise<void>) | undefined, idleMs = IDLE_UNLOAD_MS) {
	const running = useRef(0)
	const used = useRef(false)
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
	const unloadRef = useRef(unload)
	unloadRef.current = unload

	const clear = useCallback(() => {
		if (timer.current) clearTimeout(timer.current)
		timer.current = null
	}, [])

	const stop = useCallback(() => {
		used.current = false
		unloadRef.current?.().catch(() => {})
	}, [])

	const onBusyChange = useCallback(
		(busy: boolean) => {
			clear()
			running.current += busy ? 1 : -1
			if (busy) used.current = true
			else if (running.current === 0) timer.current = setTimeout(stop, idleMs)
		},
		[clear, stop, idleMs],
	)

	useEffect(
		() => () => {
			clear()
			if (used.current) stop()
		},
		[clear, stop],
	)

	return onBusyChange
}
