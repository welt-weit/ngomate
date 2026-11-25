import {
	type JobChange,
	type JobFile,
	type JobRun,
	type JobState,
	type JobStore,
	KEPT_RUNS,
	afterFailure,
	claimRun,
	claimWatch,
	isDue,
	newJobState,
	nextOccurrence,
	parseJobFile,
	serializeJobFile,
} from '@ngomate/core'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { NgomateHost } from './host.js'
import { type JobRunDeps, forTeamRun, runJob } from './runJob.js'
import { makeChange } from './useChat.js'

/** How often due jobs are looked for while the app is open; also right after the computer wakes. */
const CHECK_EVERY_MS = 60_000
/**
 * How often the team's jobs are read again for the list: each read is a request per job on S3 or
 * WebDAV. Whether one is due is read again anyway when it is claimed.
 */
const TEAM_RELOAD_MS = 5 * 60_000
/**
 * How long after claiming a team run the claim is read back before running. Some storage keeps a
 * file's version for two writes within one second (Nextcloud does), so two computers could both
 * think they took it; the one whose claim is not there afterwards stands down.
 */
const CLAIM_SETTLE_MS = 1500
/**
 * Longest a run may take. Below the hour after which another computer may take over a team run, so a
 * run that hangs never overlaps one that replaces it, and never stops every other job here for good.
 */
const RUN_LIMIT_MS = 30 * 60_000
/**
 * A job whose run could not be recorded is left alone a while, rather than run again at once: a minute,
 * then twice as long each time, up to half an hour.
 */
const BACK_OFF_MS = 60_000
const BACK_OFF_MAX_MS = 30 * 60_000

/** One job as listed: its file read, or why it could not be. */
export type ListedJob = {
	/** Unique across this person's jobs and the team's, which can share an id. */
	key: string
	id: string
	/** Kept in the team's storage and run by whichever member's computer is on. */
	team: boolean
	job: JobFile | null
	/** Why the file could not be read, so the person can fix it. */
	problem: string | null
	state: JobState | null
	/** Another member's computer is running this team job now: who. */
	claimedBy: string | null
}

export type Jobs = {
	/** False when the host keeps no jobs. */
	available: boolean
	/** True when the active team can share jobs: its storage refuses to write over a change. */
	teamAvailable: boolean
	/** The jobs have been read once, so what is not among them is not a job's. */
	loaded: boolean
	list: ListedJob[]
	/** The job running now on this computer, by key. */
	running: string | null
	/** Why the last thing asked of the jobs did not happen, for the person to read. */
	problem: string | null
	create(job: JobFile, options: { team: boolean; taskVersion?: string }): Promise<void>
	remove(key: string): Promise<void>
	runNow(key: string): void
	setPaused(key: string, paused: boolean): Promise<void>
	/**
	 * A team task changed since the job was made: the person read it and runs the job with it. False
	 * when it could not be recorded, so the job is not run with the old version.
	 */
	acceptTask(key: string, taskVersion: string | null): Promise<boolean>
	/** The person opened a run's result. */
	markSeen(key: string, conversationId: string): Promise<void>
	/** Makes a change a run asked for, or declines it. */
	decideChange(key: string, ranAt: string, index: number, allow: boolean): Promise<void>
}

const keyOf = (team: boolean, id: string) => `${team ? 'team' : 'own'}:${id}`

const message = (err: unknown) => (err instanceof Error ? err.message : String(err))

/**
 * What a run left, applied over the state as it is now: someone in the team may have paused the job or
 * decided a change meanwhile, and that stays. Null when the job was deleted during the run.
 */
function withRun(current: JobState | null, before: JobState, after: JobState): JobState | null {
	if (!current) return null
	const added = after.runs[0] && after.runs[0] !== before.runs[0] ? after.runs[0] : null
	return {
		...current,
		nextDue: after.nextDue,
		tries: after.tries,
		problem: after.problem,
		claim: undefined,
		runs: added ? [added, ...current.runs].slice(0, KEPT_RUNS) : current.runs,
	}
}

/**
 * The conversations of runs a job listed before and lists no longer, to delete. Only runs older than
 * every run still listed: a state started again from nothing, or read back damaged, deletes none.
 */
export function droppedRuns(before: ListedJob[], after: ListedJob[], sameTeam: boolean): string[] {
	const dropped: string[] = []
	for (const item of after) {
		const runs = item.state?.runs ?? []
		const previous = before.find((each) => each.key === item.key)?.state?.runs
		if (!runs.length || !previous || (item.team && !sameTeam)) continue
		const oldest = runs.reduce((at, run) => (run.ranAt < at ? run.ranAt : at), runs[0]?.ranAt ?? '')
		const kept = new Set(runs.map((run) => run.conversationId))
		for (const run of previous) {
			if (run.conversationId && !kept.has(run.conversationId) && run.ranAt < oldest)
				dropped.push(run.conversationId)
		}
	}
	return dropped
}

/** Why a run was stopped before it ended. Only `limit` is recorded: the others are not a try. */
type StopReason = 'limit' | 'closed' | 'team' | 'removed'

/** Resolves when the signal is aborted, so a run that hangs before it reads the signal still ends. */
const whenStopped = (signal: AbortSignal) =>
	new Promise<void>((resolve) => {
		if (signal.aborted) resolve()
		else signal.addEventListener('abort', () => resolve(), { once: true })
	})

/**
 * The jobs, and running them when due: one at a time, never while a conversation is being answered,
 * and only while the app is open. A date missed while the computer was off is run once when it is back.
 * A team job is run by the first member's computer to claim it.
 */
export function useJobs(
	host: NgomateHost,
	runDeps: JobRunDeps | null,
	/** True while a conversation is being answered: a job waits for it rather than slowing it down. */
	chatBusy: () => boolean,
	/** The active team's jobs, when its storage can share them. Changes when the active team does. */
	teamStore: JobStore | null,
	/** The name this person goes by in the team, for "run by". */
	yourName: string,
	/**
	 * Deletes the conversations of runs a job no longer lists: older than its last `KEPT_RUNS`, or of a
	 * job deleted here.
	 */
	forgetRuns: (conversationIds: string[]) => void,
): Jobs {
	const own = host.jobs
	const [list, setList] = useState<ListedJob[]>([])
	const [loaded, setLoaded] = useState(false)
	const [running, setRunning] = useState<string | null>(null)
	const [problem, setProblem] = useState<string | null>(null)
	const listRef = useRef(list)
	listRef.current = list
	const depsRef = useRef(runDeps)
	depsRef.current = runDeps
	const chatBusyRef = useRef(chatBusy)
	chatBusyRef.current = chatBusy
	const nameRef = useRef(yourName)
	nameRef.current = yourName
	const forgetRef = useRef(forgetRuns)
	forgetRef.current = forgetRuns
	// Claims are aged on this computer's clock, from when it first saw them.
	const claims = useRef(claimWatch())
	const teamStoreRef = useRef(teamStore)
	teamStoreRef.current = teamStore
	// The team store the listed team jobs came from: another team's are never shown as this one's.
	const listedTeam = useRef<JobStore | null>(null)
	// Asked to run now, ahead of their dates.
	const asked = useRef(new Set<string>())
	// Jobs whose last run could not be recorded: how often in a row, and until when they wait.
	const backedOff = useRef(new Map<string, { times: number; until: number }>())
	// Changes being made now, and made in this session, so no click makes one twice.
	const deciding = useRef(new Set<string>())
	const made = useRef(new Set<string>())
	const active = useRef(false)
	const stopped = useRef(new AbortController())
	// The run going on now, so a team switch or a delete can stop just that one.
	const current = useRef<{ key: string; team: boolean; stop: AbortController } | null>(null)
	const teamRead = useRef(0)
	// Each reload of either store counts up: a slower, older read never replaces a newer one.
	const reads = useRef({ own: 0, team: 0 })

	const storeOf = useCallback((team: boolean) => (team ? teamStoreRef.current : own) ?? null, [own])

	const readStore = useCallback(async (store: JobStore, team: boolean): Promise<ListedJob[]> => {
		const listed: ListedJob[] = []
		for (const entry of await store.list()) {
			const key = keyOf(team, entry.id)
			const base = { key, id: entry.id, team }
			const claimedBy = (state: JobState | null) =>
				team && state?.claim && claims.current.held(key, state, new Date()) ? state.claim.by : null
			try {
				const job = parseJobFile(entry.text)
				// A sync app's conflicted copy carries the original's id: run as a job of its own, it would
				// run every date twice.
				if (job.id !== entry.id)
					throw new Error(
						`its file is named ${entry.id} but holds the job ${job.id}, perhaps a copy a sync app made`,
					)
				let state = entry.state
				// A file someone just wrote by hand has no state yet: it starts from its schedule.
				if (!state) {
					// With the team task's version now, so a job made by hand is not held for it at once.
					const version = depsRef.current?.teamTasks.find(
						(item) => item.task.id === job.task,
					)?.version
					const fresh = newJobState(job, new Date(), version ?? undefined)
					state =
						(await store
							.update(entry.id, (existing) => (existing ? null : fresh))
							.catch(() => null)) ?? fresh
				}
				listed.push({ ...base, job, problem: null, state, claimedBy: claimedBy(state) })
			} catch (err) {
				listed.push({
					...base,
					job: null,
					problem: message(err),
					state: entry.state,
					claimedBy: claimedBy(entry.state),
				})
			}
		}
		return listed
	}, [])

	const reload = useCallback(
		async (withTeam = true) => {
			const read = reads.current
			const ownRead = ++read.own
			const teamBefore = listedTeam.current
			let mine: ListedJob[] | null = []
			let failed: unknown = null
			if (own) {
				try {
					mine = await readStore(own, false)
				} catch (err) {
					mine = null
					failed = err
				}
			}
			const store = teamStoreRef.current
			let theirs: ListedJob[] | null = null
			if (!store) theirs = []
			else if (
				withTeam ||
				listedTeam.current !== store ||
				Date.now() - teamRead.current > TEAM_RELOAD_MS
			) {
				const teamReadNow = ++read.team
				let fresh: ListedJob[] | null = null
				try {
					fresh = await readStore(store, true)
				} catch (err) {
					failed ??= err
				}
				if (fresh && teamReadNow === read.team && teamStoreRef.current === store) {
					theirs = fresh
					listedTeam.current = store
					teamRead.current = Date.now()
				}
			}
			// Built from the list as it is now, so a newer reload that finished first is kept.
			const now = listRef.current
			const ownPart = mine && ownRead === read.own ? mine : now.filter((item) => !item.team)
			const teamPart =
				theirs ??
				(listedTeam.current === teamStoreRef.current ? now.filter((item) => item.team) : [])
			// By title, then id, so two jobs of one title keep their places between reads.
			const listed = [...ownPart, ...teamPart].sort(
				(a, b) =>
					(a.job?.title ?? a.id).localeCompare(b.job?.title ?? b.id) || a.key.localeCompare(b.key),
			)
			const dropped = droppedRuns(now, listed, teamBefore === listedTeam.current)
			if (dropped.length) forgetRef.current(dropped)
			setList(listed)
			listRef.current = listed
			if (failed) setProblem(`The jobs could not all be read: ${message(failed)}`)
			// Only once this person's own jobs were read: before that, no run can be told from a chat.
			else if (mine) setLoaded(true)
		},
		[own, readStore],
	)

	const check = useCallback(async () => {
		const deps = depsRef.current
		const stop = stopped.current.signal
		// Taken at once, before anything is awaited: two checks close together must not both start one.
		if (!deps || active.current || stop.aborted || chatBusyRef.current()) return
		active.current = true
		let next: ListedJob | undefined
		let goOn = false
		let claim: { by: string; at: string } | null = null
		let busy = false
		try {
			await reload(false)
			if (stop.aborted) return
			const now = new Date()
			// A team job another computer is running is passed over, not waited on: the jobs after it run.
			next = listRef.current.find(
				(item) =>
					item.job &&
					item.state &&
					!(item.team && claims.current.held(item.key, item.state, now)) &&
					(backedOff.current.get(item.key)?.until ?? 0) <= now.getTime() &&
					(asked.current.has(item.key) || isDue(item.state, now)),
			)
			const store = next && storeOf(next.team)
			if (!next?.job || !next.state || !store) return
			const { job, id, team, key } = next
			const wasAsked = asked.current.has(key)
			const ready = (state: JobState | null) =>
				state && !state.paused && (wasAsked || isDue(state, now)) ? state : null
			let before: JobState
			if (team) {
				// Read again and taken over the version read, so two computers never run one date.
				const claimed = await store.update(id, (state) =>
					ready(state)
						? claimRun(
								state as JobState,
								nameRef.current,
								now,
								claims.current.held(key, state as JobState, now),
							)
						: null,
				)
				if (!claimed?.claim) {
					if (wasAsked) setProblem(`${job.title} is running on another computer, or is not due.`)
					asked.current.delete(key)
					goOn = true
					return
				}
				claim = claimed.claim
				await new Promise((resolve) => setTimeout(resolve, CLAIM_SETTLE_MS))
				let readBack: JobState | null = null
				await store.update(id, (state) => {
					readBack = state
					return null
				})
				const kept = (readBack as JobState | null)?.claim
				if (kept?.by !== claim.by || kept.at !== claim.at) {
					claim = null
					goOn = true
					return
				}
				before = claimed
			} else {
				// Read again too: a Pause clicked a moment ago must hold.
				let fresh: JobState | null = null
				await store.update(id, (state) => {
					fresh = state
					return null
				})
				const readyNow = ready(fresh)
				if (!readyNow) {
					asked.current.delete(key)
					goOn = true
					return
				}
				before = readyNow
			}
			asked.current.delete(key)
			setRunning(key)
			// Keeps a local model loaded for the run, as a conversation does.
			deps.chat.onBusyChange?.(true)
			busy = true
			const run = new AbortController()
			current.current = { key, team, stop: run }
			const onClose = () => run.abort('closed' satisfies StopReason)
			stop.addEventListener('abort', onClose, { once: true })
			const timer = setTimeout(() => run.abort('limit' satisfies StopReason), RUN_LIMIT_MS)
			let after: JobState
			try {
				// Raced with the stop, so a run that hangs before it reads the signal ends all the same.
				after = await Promise.race([
					runJob({ ...deps, by: team ? nameRef.current : undefined }, job, before, run.signal),
					whenStopped(run.signal).then(() => before),
				])
			} finally {
				clearTimeout(timer)
				stop.removeEventListener('abort', onClose)
				current.current = null
			}
			if (after === before) {
				// Stopped because the app closed, the team changed or the job was deleted: not a try, and
				// nothing is recorded. Too long is a try like any failure, or it would run again at once.
				if (run.signal.reason !== 'limit') return
				const ranAt = new Date()
				const failedRun: JobRun = {
					dueAt: before.nextDue,
					ranAt: ranAt.toISOString(),
					outcome: 'failed',
					reason: 'It took longer than 30 minutes and was stopped.',
					seen: false,
					...(team ? { by: nameRef.current } : {}),
				}
				after = afterFailure(before, job, failedRun, ranAt)
			}
			await store.update(id, (state) => withRun(state, before, after))
			claim = null
			backedOff.current.delete(key)
			goOn = true
			const last = after.runs[0]
			if (last && last !== before.runs[0]) {
				try {
					host.notify?.(
						job.title,
						last.outcome === 'failed'
							? `Could not run: ${last.reason ?? 'no reason given.'}`
							: last.outcome === 'held'
								? (last.reason ?? 'Waiting for you.')
								: last.outcome === 'waiting'
									? team
										? 'Done. It asked to change something, which waits for you on this computer.'
										: 'Done. It asked to change something, which waits for you.'
									: last.outcome === 'warnings'
										? 'Done. The checks found something to look at.'
										: 'Done.',
					)
				} catch {
					// A notification is a courtesy: the result is in the list either way.
				}
			}
		} catch (err) {
			// Mostly the team's storage out of reach. Left alone a while, longer each time: a run whose
			// record cannot be written would otherwise run over and over.
			if (next) {
				const times = (backedOff.current.get(next.key)?.times ?? 0) + 1
				const wait = Math.min(BACK_OFF_MAX_MS, BACK_OFF_MS * 2 ** (times - 1))
				backedOff.current.set(next.key, { times, until: Date.now() + wait })
			}
			console.error(`The job ${next?.id ?? ''} could not run:`, err)
		} finally {
			const store = next && storeOf(next.team)
			const held = claim
			// A claim this computer still holds is let go, or the job would wait an hour for it.
			if (held && next && store) {
				await store
					.update(next.id, (state) =>
						state?.claim?.at === held.at && state.claim.by === held.by
							? { ...state, claim: undefined }
							: null,
					)
					.catch(() => {})
			}
			if (busy) deps.chat.onBusyChange?.(false)
			active.current = false
			setRunning(null)
			if (next && !stop.aborted) await reload(next.team).catch(() => {})
		}
		// The next due job, if any, without waiting a minute.
		if (goOn && !stop.aborted) setTimeout(() => void check(), 0)
	}, [host, reload, storeOf])

	useEffect(() => {
		// Without a place of its own for jobs the host shows none, so none run here, the team's included.
		if (!own) return
		const controller = new AbortController()
		stopped.current = controller
		void reload().then(() => check())
		const timer = setInterval(() => void check(), CHECK_EVERY_MS)
		// A computer coming back from sleep: timers may not have fired, so look at once.
		const onVisible = () => {
			if (!document.hidden) void check()
		}
		document.addEventListener('visibilitychange', onVisible)
		return () => {
			controller.abort()
			clearInterval(timer)
			document.removeEventListener('visibilitychange', onVisible)
		}
	}, [own, reload, check])

	// Another team, or none: a run of the old team's job stops, and its jobs leave the list.
	// biome-ignore lint/correctness/useExhaustiveDependencies: runs when the active team's store changes
	useEffect(() => {
		if (current.current?.team) current.current.stop.abort('team' satisfies StopReason)
		teamRead.current = 0
		void reload(true)
	}, [teamStore, reload])

	/**
	 * Does something asked of the jobs, and says so when it cannot. `rethrow` for a form that shows the
	 * reason itself; everything else is said in the list. True when it went through.
	 */
	const attempt = useCallback(async (work: () => Promise<void>, rethrow = false) => {
		setProblem(null)
		try {
			await work()
			return true
		} catch (err) {
			if (rethrow) throw err
			setProblem(message(err))
			return false
		}
	}, [])

	const update = useCallback(
		(key: string, change: (state: JobState) => JobState | null) =>
			attempt(async () => {
				const item = listRef.current.find((each) => each.key === key)
				const store = item && storeOf(item.team)
				if (!item || !store) return
				await store.update(item.id, (state) => (state ? change(state) : null))
				await reload(item.team)
			}),
		[attempt, storeOf, reload],
	)

	return {
		available: Boolean(own),
		teamAvailable: Boolean(own && teamStore),
		loaded,
		list,
		running,
		problem,
		create: async (job, { team, taskVersion }) => {
			await attempt(async () => {
				const store = storeOf(team)
				if (!store) return
				await store.write(job.id, serializeJobFile(job))
				// The file is what makes the job: a state not written now is made on the next read.
				const fresh = newJobState(job, new Date(), taskVersion)
				await store.update(job.id, () => fresh).catch(() => {})
				await reload(team)
			}, true)
		},
		remove: async (key) => {
			await attempt(async () => {
				const item = listRef.current.find((each) => each.key === key)
				if (!item) return
				if (current.current?.key === key) current.current.stop.abort('removed' satisfies StopReason)
				await storeOf(item.team)?.remove(item.id)
				// Only those kept on this computer exist here; a team member's are on theirs.
				const ids = (item.state?.runs ?? []).flatMap((run) => run.conversationId ?? [])
				if (ids.length) forgetRef.current(ids)
				asked.current.delete(key)
				backedOff.current.delete(key)
				await reload(item.team)
			})
		},
		runNow: (key) => {
			asked.current.add(key)
			backedOff.current.delete(key)
			void check()
		},
		setPaused: async (key, paused) => {
			// Resumed after its date passed, it waits for its next date rather than running at once.
			await update(key, (state) => {
				const job = listRef.current.find((each) => each.key === key)?.job
				const now = new Date()
				return !paused && job && isDue(state, now) && state.paused
					? { ...state, paused, nextDue: nextOccurrence(job.schedule, now, job.zone).toISOString() }
					: { ...state, paused }
			})
		},
		acceptTask: (key, taskVersion) =>
			update(key, (state) => ({ ...state, taskVersion: taskVersion ?? undefined })),
		decideChange: async (key, ranAt, index, allow) => {
			const item = listRef.current.find((each) => each.key === key)
			const change = item?.state?.runs.find((run) => run.ranAt === ranAt)?.changes?.[index]
			const deps = depsRef.current
			const id = `${key}/${ranAt}/${index}`
			if (!change || change.decision !== 'waiting' || !deps || deciding.current.has(id)) return
			deciding.current.add(id)
			try {
				let decided: JobChange = { ...change, decision: allow ? 'made' : 'declined' }
				// Made once: if recording it failed before, only the record is tried again.
				if (allow && !made.current.has(id)) {
					try {
						await makeChange(
							item?.team ? forTeamRun(deps.chat, deps.teamConnectors ?? []) : deps.chat,
							change,
						)
						made.current.add(id)
						decided = { ...decided, error: undefined }
					} catch (err) {
						// Still waiting: the person can try again, or decline it.
						decided = { ...change, error: message(err) }
					}
				}
				await update(key, (state) => ({
					...state,
					runs: state.runs.map((run) =>
						run.ranAt === ranAt
							? {
									...run,
									changes: run.changes?.map((each, at) =>
										at === index && each.decision === 'waiting' ? decided : each,
									),
								}
							: run,
					),
				}))
			} finally {
				deciding.current.delete(id)
			}
		},
		markSeen: async (key, conversationId) => {
			// A team run's "seen" would be one flag for the whole team, so only this person's runs keep it.
			const item = listRef.current.find((each) => each.key === key)
			const run = item?.state?.runs.find((each) => each.conversationId === conversationId)
			if (!item || item.team || !run || run.seen) return
			await update(key, (state) => ({
				...state,
				runs: state.runs.map((each) =>
					each.conversationId === conversationId ? { ...each, seen: true } : each,
				),
			}))
		},
	}
}
