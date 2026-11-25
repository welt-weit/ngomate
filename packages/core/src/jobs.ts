import {
	READS_AT_ONCE,
	TeamConflict,
	type TeamLimits,
	type TeamStore,
	eachAtMost,
	teamLimitProblem,
} from './team.js'

/**
 * Jobs: ready-made tasks that run on a schedule, on this computer, while the app is open. A job is a plain
 * text file like a task file, so a person can read and change it; when it last ran and when it runs next
 * are kept apart from it, so editing a job never collides with a run.
 */

export const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const
export type Weekday = (typeof WEEKDAYS)[number]

/**
 * Times are `HH:MM`, in the job's zone or else the computer's own. A month day stops at 28, so every
 * month has it.
 */
export type Schedule =
	| { every: 'day'; time: string }
	| { every: 'week'; day: Weekday; time: string }
	| { every: 'month'; day: number; time: string }

/** Where a run's result is written: one of this person's notes, or the team's. */
export type JobDestination = { kind: 'note' | 'team-note'; name: string }

export type JobFile = {
	id: string
	title: string
	/** The ready-made task it runs, by id. */
	task: string
	schedule: Schedule
	destination: JobDestination
	/** What the task asks for before it runs, given once. */
	inputs: string
	/**
	 * The time zone its times are in, such as Europe/Berlin. A team job carries the zone of whoever made
	 * it, so 09:00 is the same moment for every member. Without one, the computer's own.
	 */
	zone?: string
	/**
	 * For a job of this person's own that writes to a team's notes or runs a team's task: which team, by
	 * this computer's id for it. Run while another team is open, it is held rather than written there.
	 */
	team?: string
}

/**
 * - `done`: written where it goes, and the checks found nothing.
 * - `warnings`: written, with something the checks found at the top.
 * - `waiting`: written, but it wanted to change something, which waits for the person.
 * - `held`: not run, because something has to be looked at first, such as a task the team changed.
 * - `failed`: not written, with the reason.
 */
export type JobOutcome = 'done' | 'warnings' | 'waiting' | 'held' | 'failed'

export type JobRun = {
	/** When it was due. Earlier than `ranAt` when the computer was off or the app closed. */
	dueAt: string
	ranAt: string
	outcome: JobOutcome
	/** The conversation the run is kept as. */
	conversationId?: string
	/** The note it wrote. */
	note?: string
	/** Why it failed or was held. */
	reason?: string
	/** Changes the model asked for, which a run never makes on its own: each waits for the person. */
	changes?: JobChange[]
	/** Opened since it ran. */
	seen: boolean
	/** Who it ran for, by the name they go by in the team: a team job runs on whichever computer is on. */
	by?: string
	/** A held run waits for this: `task`, someone in the team changed the task it runs. */
	waitsFor?: 'task'
}

/** A change a run asked for: a connector's tool and what it was given, and what the person decided. */
export type JobChange = {
	tool: string
	args: Record<string, unknown>
	decision: 'waiting' | 'made' | 'declined'
	/** Why making it failed, when it did. */
	error?: string
}

/**
 * A change said in a line: the tool and what it was given, cut at `max` characters for a list. Where
 * the person decides on it, it is shown in full.
 */
export function describeChange(change: Pick<JobChange, 'tool' | 'args'>, max = 200): string {
	const shown = Object.entries(change.args)
		.map(([key, value]) => `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`)
		.join(', ')
	return shown.length > max
		? `${change.tool} (${shown.slice(0, max - 3)}…)`
		: `${change.tool} (${shown})`
}

export type JobState = {
	/** When it runs next, as an ISO time. */
	nextDue: string
	paused?: boolean
	/** Newest first, the last `KEPT_RUNS`. */
	runs: JobRun[]
	/** Tries since the last run that went through, so a failure is retried a few times, then left. */
	tries?: number
	/** Why the last try failed, while it is tried again: shown, so a retry is not mistaken for a date. */
	problem?: string
	/** The version of a team task when the job was made, so a change to it is looked at first. */
	taskVersion?: string
	/**
	 * A team job being run now, and by whom. Taken by writing the state over the version read, so two
	 * computers cannot both take it; one seen for `CLAIM_STALE_MS` was left by a computer that stopped.
	 */
	claim?: { by: string; at: string }
}

/**
 * Where a host keeps jobs: each job's file, readable by a person, and its state beside it. A file that
 * cannot be read is listed with its text, so the person can see and fix it.
 */
export interface JobStore {
	list(): Promise<{ id: string; text: string; state: JobState | null }[]>
	/** Makes a job. A shared store refuses one someone else made under the same id meanwhile. */
	write(id: string, text: string): Promise<void>
	/** Writes a changed job file over the one there. Its state, and so its runs, stay. */
	replace(id: string, text: string): Promise<void>
	/**
	 * Changes a job's state from the newest there is. A shared store reads it again and tries once more
	 * when someone else changed it meanwhile. `change` returning null leaves it as it is. Returns the
	 * state written, or null when nothing was written: `change` declined, or the job is gone.
	 */
	update(id: string, change: (state: JobState | null) => JobState | null): Promise<JobState | null>
	/** The file and its state. The conversations its runs are kept as stay. */
	remove(id: string): Promise<void>
}

/** A claim on a team run this old was left by a computer that stopped mid-run, and may be taken over. */
export const CLAIM_STALE_MS = 60 * 60_000

/**
 * Tells, on this computer's clock, whether another computer holds a team run: a claim is aged from when
 * this computer first saw it, never from the time the claiming computer wrote in it, since that clock
 * may be wrong by hours either way. A claim a computer left behind when it stopped is taken over an hour
 * after it was first seen here.
 */
export function claimWatch() {
	const seen = new Map<string, number>()
	return {
		held(key: string, state: JobState, now: Date): boolean {
			const claim = state.claim
			if (!claim) return false
			const id = `${key}\n${claim.by}\n${claim.at}`
			const first = seen.get(id) ?? now.getTime()
			seen.set(id, first)
			// Sightings older than a day are of claims long gone.
			for (const [other, at] of seen) if (now.getTime() - at > 24 * 60 * 60_000) seen.delete(other)
			return now.getTime() - first < CLAIM_STALE_MS
		},
	}
}

export type ClaimWatch = ReturnType<typeof claimWatch>

/**
 * Takes a team run for `by`, unless another computer holds it. Null when it does. Whether the job is
 * due or paused is for the caller to check, on the state it claims.
 */
export function claimRun(
	state: JobState,
	by: string,
	now: Date,
	heldElsewhere: boolean,
): JobState | null {
	if (heldElsewhere) return null
	return { ...state, claim: { by, at: now.toISOString() } }
}

export const KEPT_RUNS = 20
/** A run that failed is tried again after this long, a few times, before its next date. */
export const RETRY_MS = 15 * 60_000
export const MAX_TRIES = 4
/** Later than this, a run's result says it ran late and why. */
export const LATE_MS = 10 * 60_000

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/

export function parseSchedule(text: string): Schedule {
	const parts = text.trim().toLowerCase().split(/\s+/)
	const [every, a, b] = parts
	const time = (value: string | undefined) => {
		if (!value || !TIME.test(value)) throw new Error(`A schedule needs a time like 09:00: ${text}`)
		return value
	}
	if (every === 'daily' && parts.length === 2) return { every: 'day', time: time(a) }
	if (every === 'weekly' && parts.length === 3) {
		if (!WEEKDAYS.includes(a as Weekday)) throw new Error(`Not a day of the week: ${a}`)
		return { every: 'week', day: a as Weekday, time: time(b) }
	}
	if (every === 'monthly' && parts.length === 3) {
		const day = Number(a)
		if (!Number.isInteger(day) || day < 1 || day > 28)
			throw new Error('A monthly job runs on a day from 1 to 28, which every month has')
		return { every: 'month', day, time: time(b) }
	}
	throw new Error(
		`Not a schedule: ${text}. Write daily 09:00, weekly mon 09:00 or monthly 1 09:00.`,
	)
}

export function formatSchedule(schedule: Schedule): string {
	if (schedule.every === 'day') return `daily ${schedule.time}`
	if (schedule.every === 'week') return `weekly ${schedule.day} ${schedule.time}`
	return `monthly ${schedule.day} ${schedule.time}`
}

const DAY_NAMES: Record<Weekday, string> = {
	mon: 'Monday',
	tue: 'Tuesday',
	wed: 'Wednesday',
	thu: 'Thursday',
	fri: 'Friday',
	sat: 'Saturday',
	sun: 'Sunday',
}

export function describeSchedule(schedule: Schedule): string {
	if (schedule.every === 'day') return `Every day at ${schedule.time}`
	if (schedule.every === 'week') return `Every ${DAY_NAMES[schedule.day]} at ${schedule.time}`
	return `On day ${schedule.day} of every month at ${schedule.time}`
}

const clocks = new Map<string, Intl.DateTimeFormat>()

/** The fields of a moment as a clock in `zone` shows them. */
function wallClock(moment: Date, zone: string) {
	let clock = clocks.get(zone)
	if (!clock) {
		clock = new Intl.DateTimeFormat('en-US', {
			timeZone: zone,
			year: 'numeric',
			month: 'numeric',
			day: 'numeric',
			hour: 'numeric',
			minute: 'numeric',
			hourCycle: 'h23',
		})
		clocks.set(zone, clock)
	}
	const parts = clock.formatToParts(moment)
	const get = (type: string) => Number(parts.find((part) => part.type === type)?.value)
	return {
		year: get('year'),
		month: get('month'),
		day: get('day'),
		hour: get('hour'),
		minute: get('minute'),
	}
}

/**
 * The moment a clock in `zone` shows this date and time. A time the clock skips when it goes forward,
 * such as 02:30 on that night, is taken as the moment after the skip (03:30), as a local clock does; a
 * time it shows twice when it goes back is the first of the two.
 */
function fromWallClock(
	zone: string,
	year: number,
	month: number,
	day: number,
	hour: number,
	minute: number,
): Date {
	const wanted = Date.UTC(year, month - 1, day, hour, minute)
	const offsetAt = (moment: number) => {
		const shown = wallClock(new Date(moment), zone)
		return Date.UTC(shown.year, shown.month - 1, shown.day, shown.hour, shown.minute) - moment
	}
	const shows = (moment: number) => {
		const shown = wallClock(new Date(moment), zone)
		return shown.day === day && shown.hour === hour && shown.minute === minute
	}
	// Fifteen hours either side reach past any change of the clock that night: an offset is at most 14
	// hours, and with 12 (Auckland, Chatham) both samples landed after the change.
	const before = wanted - offsetAt(wanted - 15 * 3_600_000)
	const after = wanted - offsetAt(wanted + 15 * 3_600_000)
	const fits = [before, after].filter(shows)
	if (fits.length) return new Date(Math.min(...fits))
	// Skipped: the offset from before the change puts it the length of the skip later.
	return new Date(before)
}

/**
 * True when `zone` is a named time zone this computer knows, such as Europe/Berlin, or UTC. Names only:
 * an offset or an abbreviation some systems accept, others do not, and a team job is read on all of them.
 */
export function isTimeZone(zone: string): boolean {
	if (zone !== 'UTC' && !/^[A-Za-z]+(?:\/[A-Za-z0-9_+-]+)+$/.test(zone)) return false
	try {
		new Intl.DateTimeFormat('en-US', { timeZone: zone })
		return true
	} catch {
		return false
	}
}

/**
 * The first time the schedule falls strictly after `after`: in `zone` when given, so a team's job means
 * the same moment on every member's computer, else in this computer's time zone.
 */
export function nextOccurrence(schedule: Schedule, after: Date, zone?: string): Date {
	if (zone) return zonedNextOccurrence(schedule, after, zone)
	const [hours, minutes] = schedule.time.split(':').map(Number) as [number, number]
	const at = (date: Date) => {
		const copy = new Date(date)
		copy.setHours(hours, minutes, 0, 0)
		return copy
	}
	if (schedule.every === 'month') {
		for (let ahead = 0; ahead < 3; ahead++) {
			const candidate = at(new Date(after.getFullYear(), after.getMonth() + ahead, schedule.day))
			if (candidate > after) return candidate
		}
		throw new Error('No next time for this schedule')
	}
	const wanted = schedule.every === 'week' ? (WEEKDAYS.indexOf(schedule.day) + 1) % 7 : null
	for (let ahead = 0; ahead <= 7; ahead++) {
		const day = new Date(after.getFullYear(), after.getMonth(), after.getDate() + ahead)
		const candidate = at(day)
		if (candidate > after && (wanted === null || candidate.getDay() === wanted)) return candidate
	}
	throw new Error('No next time for this schedule')
}

function zonedNextOccurrence(schedule: Schedule, after: Date, zone: string): Date {
	const [hours, minutes] = schedule.time.split(':').map(Number) as [number, number]
	const today = wallClock(after, zone)
	// Calendar arithmetic on the date alone, which has no time zone.
	const civil = (year: number, month: number, day: number) => {
		const date = new Date(Date.UTC(year, month - 1, day))
		return {
			year: date.getUTCFullYear(),
			month: date.getUTCMonth() + 1,
			day: date.getUTCDate(),
			weekday: date.getUTCDay(),
		}
	}
	const at = (date: ReturnType<typeof civil>) =>
		fromWallClock(zone, date.year, date.month, date.day, hours, minutes)
	if (schedule.every === 'month') {
		for (let ahead = 0; ahead < 3; ahead++) {
			const candidate = at(civil(today.year, today.month + ahead, schedule.day))
			if (candidate > after) return candidate
		}
		throw new Error('No next time for this schedule')
	}
	const wanted = schedule.every === 'week' ? (WEEKDAYS.indexOf(schedule.day) + 1) % 7 : null
	for (let ahead = 0; ahead <= 7; ahead++) {
		const date = civil(today.year, today.month, today.day + ahead)
		const candidate = at(date)
		if (candidate > after && (wanted === null || date.weekday === wanted)) return candidate
	}
	throw new Error('No next time for this schedule')
}

export function parseJobFile(source: string): JobFile {
	const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
	if (!match) throw new Error('A job file starts with a block between two --- lines')
	const fields = new Map<string, string>()
	for (const line of (match[1] as string).split(/\r?\n/)) {
		const at = line.indexOf(':')
		if (at > 0) fields.set(line.slice(0, at).trim(), line.slice(at + 1).trim())
	}
	const required = (key: string) => {
		const value = fields.get(key)
		if (!value) throw new Error(`A job file needs ${key}`)
		return value
	}
	const id = required('id')
	if (!JOB_ID.test(id)) throw new Error(`A job's id is letters, digits, - and _ only: ${id}`)
	if (RESERVED.test(id.toLowerCase()))
		throw new Error(`A job cannot be called ${id}: Windows keeps that name for a device`)
	return {
		id,
		title: required('title'),
		task: required('task'),
		schedule: parseSchedule(required('schedule')),
		destination: parseDestination(required('destination')),
		inputs: (match[2] as string).trim(),
		...zoneOf(fields.get('zone')),
		...(fields.get('team') ? { team: fields.get('team') } : {}),
	}
}

function zoneOf(zone: string | undefined): { zone?: string } {
	if (!zone) return {}
	if (!isTimeZone(zone)) throw new Error(`Not a time zone this computer knows: ${zone}`)
	return { zone }
}

function parseDestination(text: string): JobDestination {
	const [kind, ...rest] = text.split(/\s+/)
	const name = rest.join(' ').trim()
	if ((kind !== 'note' && kind !== 'team-note') || !name)
		throw new Error(`Not a destination: ${text}. Write note <name> or team-note <name>.`)
	return { kind, name }
}

/** What a job's id may hold: it names its files on every kind of storage. */
const JOB_ID = /^[A-Za-z0-9_-]{1,80}$/

/** One line per field, so no field carries a line break, and with it another field, into the block. */
const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim()

export function serializeJobFile(job: JobFile): string {
	return [
		'---',
		`id: ${oneLine(job.id)}`,
		`title: ${oneLine(job.title)}`,
		`task: ${oneLine(job.task)}`,
		`schedule: ${formatSchedule(job.schedule)}`,
		`destination: ${job.destination.kind} ${oneLine(job.destination.name)}`,
		...(job.zone ? [`zone: ${oneLine(job.zone)}`] : []),
		...(job.team ? [`team: ${oneLine(job.team)}`] : []),
		'---',
		job.inputs.trim(),
		'',
	].join('\n')
}

export function newJobState(job: JobFile, now: Date, taskVersion?: string): JobState {
	return {
		nextDue: nextOccurrence(job.schedule, now, job.zone).toISOString(),
		runs: [],
		...(taskVersion ? { taskVersion } : {}),
	}
}

export function isDue(state: JobState, now: Date): boolean {
	return !state.paused && Date.parse(state.nextDue) <= now.getTime()
}

/**
 * After a run that went through, or was held: dates missed while the computer was off collapse into
 * that one run, so the next is the first date after now.
 */
export function afterRun(state: JobState, job: JobFile, run: JobRun, now: Date): JobState {
	return {
		...state,
		nextDue: nextOccurrence(job.schedule, now, job.zone).toISOString(),
		runs: [run, ...state.runs].slice(0, KEPT_RUNS),
		tries: 0,
		claim: undefined,
		problem: undefined,
	}
}

/**
 * After a failure: tried again shortly, a few times, as long as that is before the next date; then
 * recorded as failed and left until that date.
 */
export function afterFailure(state: JobState, job: JobFile, run: JobRun, now: Date): JobState {
	const tries = (state.tries ?? 0) + 1
	const next = nextOccurrence(job.schedule, now, job.zone)
	const retry = new Date(now.getTime() + RETRY_MS)
	if (tries < MAX_TRIES && retry < next)
		return { ...state, nextDue: retry.toISOString(), tries, claim: undefined, problem: run.reason }
	return afterRun(state, job, run, now)
}

/**
 * `{date}` in a note's name becomes the day the run was due, so each run can keep its own note. In the
 * job's zone when it has one, so every member's computer names a team run's note alike.
 */
export function destinationNote(destination: JobDestination, dueAt: Date, zone?: string): string {
	const date = zone
		? wallClock(dueAt, zone)
		: { year: dueAt.getFullYear(), month: dueAt.getMonth() + 1, day: dueAt.getDate() }
	const day = [
		date.year,
		String(date.month).padStart(2, '0'),
		String(date.day).padStart(2, '0'),
	].join('-')
	return destination.name.replaceAll('{date}', day)
}

/** Said in a run's result when it ran late, so nobody takes a missed date for a quiet week. */
export function latenessNote(dueAt: Date, ranAt: Date): string | null {
	if (ranAt.getTime() - dueAt.getTime() < LATE_MS) return null
	const when = (date: Date) =>
		date.toLocaleString(undefined, {
			weekday: 'short',
			day: 'numeric',
			month: 'short',
			hour: '2-digit',
			minute: '2-digit',
		})
	return `Due ${when(dueAt)}, ran ${when(ranAt)}: the computer was off or the app was closed. It covers the time since the last run.`
}

/** Names Windows keeps for devices, which a synced folder there cannot hold as files. */
const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/

/** Letters no decomposition turns into a plain one. */
const SPELLED_OUT: Record<string, string> = {
	ß: 'ss',
	ł: 'l',
	Ł: 'l',
	ø: 'o',
	Ø: 'o',
	đ: 'd',
	Đ: 'd',
	æ: 'ae',
	Æ: 'ae',
	œ: 'oe',
	Œ: 'oe',
	þ: 'th',
	Þ: 'th',
}

/**
 * A job id from its title: what a file name allows, and unique among `taken` in any case, since most
 * computers' files do not tell Funding from funding.
 */
export function jobId(title: string, taken: string[]): string {
	const slug = title
		.replace(/[ßłŁøØđĐæÆœŒþÞ]/g, (letter) => SPELLED_OUT[letter] ?? letter)
		.normalize('NFKD')
		.replace(/\p{M}/gu, '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 40)
		.replace(/-+$/, '')
	const base = !slug ? 'job' : RESERVED.test(slug) ? `job-${slug}` : slug
	let id = base
	const used = new Set(taken.map((each) => each.toLowerCase()))
	for (let n = 2; used.has(id); n++) id = `${base}-${n}`
	return id
}

/**
 * A job's state as kept, or null when there is none or it is not one: a damaged or foreign state starts
 * again from the job's schedule rather than stopping the job for good.
 */
export function parseJobState(text: string | undefined | null): JobState | null {
	if (!text) return null
	let value: unknown
	try {
		value = JSON.parse(text)
	} catch {
		return null
	}
	const state = value as Partial<JobState> | null
	const isObject = (item: unknown): item is Record<string, unknown> =>
		typeof item === 'object' && item !== null && !Array.isArray(item)
	// A team's state is written by every member's app and can be touched by a sync app: each run is
	// checked too, or one bad entry would break the list for the whole team.
	const runOk = (run: unknown) =>
		isObject(run) &&
		typeof run.dueAt === 'string' &&
		typeof run.ranAt === 'string' &&
		typeof run.outcome === 'string' &&
		(run.changes === undefined ||
			(Array.isArray(run.changes) &&
				run.changes.every(
					(change) => isObject(change) && typeof change.tool === 'string' && isObject(change.args),
				)))
	if (
		!isObject(state) ||
		typeof state.nextDue !== 'string' ||
		Number.isNaN(Date.parse(state.nextDue)) ||
		!Array.isArray(state.runs) ||
		!state.runs.every(runOk) ||
		(state.claim !== undefined && !isObject(state.claim)) ||
		(state.paused !== undefined && typeof state.paused !== 'boolean')
	)
		return null
	return state as JobState
}

/** Tries at a change to a shared state that someone else keeps changing first. */
const UPDATE_TRIES = 3

/** A job's state in the team's storage stays below this: twenty runs and what they asked for fit easily. */
const MAX_STATE_BYTES = 200_000

const bytesOf = (text: string) => new TextEncoder().encode(text).length

/**
 * A state as written, kept below `MAX_STATE_BYTES` by shortening rather than refusing: a run that has
 * happened must be recorded. What older runs asked to change is shortened first, then the oldest runs go.
 */
function fitState(state: JobState): string {
	let fitted = state
	let text = JSON.stringify(fitted, null, 2)
	if (bytesOf(text) <= MAX_STATE_BYTES) return text
	const short = (args: Record<string, unknown>) =>
		Object.fromEntries(
			Object.entries(args).map(([key, value]) => {
				const shown = typeof value === 'string' ? value : JSON.stringify(value)
				return [key, shown.length > 500 ? `${shown.slice(0, 500)}…` : value]
			}),
		)
	fitted = {
		...fitted,
		runs: fitted.runs.map((run, index) =>
			index === 0 || !run.changes
				? run
				: {
						...run,
						changes: run.changes.map((change) => ({ ...change, args: short(change.args) })),
					},
		),
	}
	text = JSON.stringify(fitted, null, 2)
	while (bytesOf(text) > MAX_STATE_BYTES && fitted.runs.length > 1) {
		fitted = { ...fitted, runs: fitted.runs.slice(0, -1) }
		text = JSON.stringify(fitted, null, 2)
	}
	return text
}

/**
 * The jobs a team shares, in its own storage: each job's file under `jobs`, its state under
 * `job-states`. Every change to a state is written over the version it was read at, so two members'
 * computers never both run one date, and a change made meanwhile is read again rather than lost.
 */
export function createTeamJobStore(store: TeamStore, limits: () => TeamLimits): JobStore {
	return {
		async list() {
			const [files, states] = await Promise.all([store.list('jobs'), store.list('job-states')])
			const withState = new Set(states.map((each) => each.name))
			const listed: { id: string; text: string; state: JobState | null }[] = []
			// A few at a time, as for notes: on S3 or WebDAV each read is a request. A file gone since the
			// list was read is left out; one that cannot be read is listed empty, so it shows as broken.
			await eachAtMost(files, READS_AT_ONCE, async (entry) => {
				const [file, state] = await Promise.all([
					store.read('jobs', entry.name).catch(() => ({ text: '', version: null })),
					withState.has(entry.name) ? store.read('job-states', entry.name).catch(() => null) : null,
				])
				if (file)
					listed.push({ id: entry.name, text: file.text, state: parseJobState(state?.text) })
			})
			return listed
		},
		async write(id, text) {
			// Jobs count with the team's tasks toward the tasks limit.
			const [tasks, jobs] = await Promise.all([store.list('tasks'), store.list('jobs')])
			// What this job had before is looked up among jobs only: a task of the same name is another file.
			const pooled = [...tasks.map((task) => ({ ...task, name: `task:${task.name}` })), ...jobs]
			const problem = teamLimitProblem(limits(), 'jobs', pooled, id, text)
			if (problem) throw new Error(problem)
			try {
				await store.write('jobs', id, text, null)
			} catch (err) {
				if (err instanceof TeamConflict)
					throw new Error(
						'Someone in the team has just made a job of that name. Give this one another name.',
					)
				throw err
			}
		},
		async replace(id, text) {
			const [tasks, jobs] = await Promise.all([store.list('tasks'), store.list('jobs')])
			const pooled = [...tasks.map((task) => ({ ...task, name: `task:${task.name}` })), ...jobs]
			const problem = teamLimitProblem(limits(), 'jobs', pooled, id, text)
			if (problem) throw new Error(problem)
			const current = await store.read('jobs', id)
			if (!current) throw new Error('This job is not in the team any more.')
			try {
				await store.write('jobs', id, text, current.version)
			} catch (err) {
				if (err instanceof TeamConflict)
					throw new Error(
						'Someone in the team changed this job meanwhile. Open it again and redo the change.',
					)
				throw err
			}
		},
		async update(id, change) {
			for (let attempt = 0; attempt < UPDATE_TRIES; attempt++) {
				const [file, current] = await Promise.all([
					store.read('jobs', id),
					store.read('job-states', id),
				])
				// A job deleted meanwhile keeps no state, or a new job of the same name would take it over.
				if (!file) return null
				const next = change(parseJobState(current?.text))
				if (!next) return null
				const text = fitState(next)
				try {
					await store.write('job-states', id, text, current?.version ?? null)
					return next
				} catch (err) {
					if (!(err instanceof TeamConflict)) throw err
				}
			}
			throw new Error('Someone in the team changed this job at the same moment. Try again.')
		},
		async remove(id) {
			// The file first: a state without its file is never written again (see update), so another
			// member's app cannot bring it back meanwhile, and the next job of that name writes its own.
			for (const area of ['jobs', 'job-states'] as const) {
				for (let attempt = 1; ; attempt++) {
					const current = await store.read(area, id)
					if (!current) break
					try {
						await store.remove(area, id, current.version)
						break
					} catch (err) {
						if (!(err instanceof TeamConflict) || attempt >= UPDATE_TRIES) throw err
					}
				}
			}
		},
	}
}
