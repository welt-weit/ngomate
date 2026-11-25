import { describe, expect, it } from 'vitest'
import {
	CLAIM_STALE_MS,
	type JobFile,
	type JobRun,
	MAX_TRIES,
	afterFailure,
	afterRun,
	claimRun,
	claimWatch,
	createTeamJobStore,
	destinationNote,
	isDue,
	isTimeZone,
	jobId,
	latenessNote,
	newJobState,
	nextOccurrence,
	parseJobFile,
	parseJobState,
	parseSchedule,
	serializeJobFile,
} from '../src/jobs.js'
import { parseTaskFile, serializeTaskFile } from '../src/tasks.js'
import {
	DEFAULT_TEAM_LIMITS,
	type TeamArea,
	TeamConflict,
	type TeamStore,
	saveTeamTask,
} from '../src/team.js'

const JOB: JobFile = {
	id: 'funding',
	title: 'Funding this week',
	task: 'find-opportunities',
	schedule: { every: 'week', day: 'mon', time: '09:00' },
	destination: { kind: 'team-note', name: 'Funding {date}' },
	inputs: 'Youth work in East Africa.\nUp to 50,000 EUR.',
}

const run = (outcome: JobRun['outcome'], at: Date): JobRun => ({
	dueAt: at.toISOString(),
	ranAt: at.toISOString(),
	outcome,
	seen: false,
})

describe('a job file', () => {
	it('is read back as it was written, inputs over several lines included', () => {
		expect(parseJobFile(serializeJobFile(JOB))).toEqual(JOB)
	})

	it('keeps a title on one line', () => {
		const text = serializeJobFile({ ...JOB, title: 'Two\nlines' })
		expect(parseJobFile(text).title).toBe('Two lines')
	})

	it('says what is wrong with a schedule or destination it cannot read', () => {
		expect(() => parseSchedule('weekly monday 09:00')).toThrow('Not a day of the week')
		expect(() => parseSchedule('monthly 31 09:00')).toThrow('1 to 28')
		expect(() => parseSchedule('daily 9am')).toThrow('09:00')
		expect(() => parseSchedule('every hour')).toThrow('Not a schedule')
		const bad = serializeJobFile(JOB).replace('team-note Funding {date}', 'email someone')
		expect(() => parseJobFile(bad)).toThrow('Not a destination')
	})
})

describe('when a job runs next', () => {
	// Monday 23 November 2026, local time.
	const monday = (hour: number, minute = 0) => new Date(2026, 10, 23, hour, minute)

	it('is later the same day, or the next day once the time has passed', () => {
		const daily = parseSchedule('daily 09:00')
		expect(nextOccurrence(daily, monday(8))).toEqual(monday(9))
		expect(nextOccurrence(daily, monday(9))).toEqual(new Date(2026, 10, 24, 9))
	})

	it('is the next matching weekday, a week on when it is that day and past the time', () => {
		expect(nextOccurrence(parseSchedule('weekly mon 09:00'), monday(8))).toEqual(monday(9))
		expect(nextOccurrence(parseSchedule('weekly mon 09:00'), monday(10))).toEqual(
			new Date(2026, 10, 30, 9),
		)
		expect(nextOccurrence(parseSchedule('weekly fri 17:30'), monday(10))).toEqual(
			new Date(2026, 10, 27, 17, 30),
		)
		expect(nextOccurrence(parseSchedule('weekly sun 09:00'), monday(10))).toEqual(
			new Date(2026, 10, 29, 9),
		)
	})

	it('moves to the next month, and the next year, past the day', () => {
		expect(nextOccurrence(parseSchedule('monthly 1 09:00'), monday(10))).toEqual(
			new Date(2026, 11, 1, 9),
		)
		expect(nextOccurrence(parseSchedule('monthly 1 09:00'), new Date(2026, 11, 2))).toEqual(
			new Date(2027, 0, 1, 9),
		)
	})
})

describe('a job between runs', () => {
	// Tuesday 24 November 2026: the job runs on Mondays.
	const made = new Date(2026, 10, 24, 10)

	it('is due from its date, never while paused', () => {
		const state = newJobState(JOB, made)
		expect(isDue(state, new Date(2026, 10, 29))).toBe(false)
		expect(isDue(state, new Date(2026, 10, 30, 9))).toBe(true)
		expect(isDue({ ...state, paused: true }, new Date(2026, 10, 30, 9))).toBe(false)
	})

	it('runs once after weeks away, then waits for the next date after now', () => {
		const state = newJobState(JOB, made)
		const back = new Date(2026, 11, 23, 8)
		const after = afterRun(state, JOB, run('done', back), back)
		expect(after.runs).toHaveLength(1)
		expect(after.nextDue).toBe(new Date(2026, 11, 28, 9).toISOString())
		expect(isDue(after, back)).toBe(false)
	})

	it('tries a failure again shortly, a few times, then waits for its next date', () => {
		let state = newJobState(JOB, made)
		const due = new Date(2026, 10, 30, 9)
		let now = due
		for (let tries = 1; tries < MAX_TRIES; tries++) {
			state = afterFailure(state, JOB, { ...run('failed', now), reason: 'No model.' }, now)
			expect(state.runs).toHaveLength(0)
			expect(state.problem).toBe('No model.')
			expect(Date.parse(state.nextDue)).toBe(now.getTime() + 15 * 60_000)
			now = new Date(state.nextDue)
		}
		state = afterFailure(state, JOB, run('failed', now), now)
		expect(state.runs.map((each) => each.outcome)).toEqual(['failed'])
		expect(state.problem).toBeUndefined()
		expect(state.nextDue).toBe(new Date(2026, 11, 7, 9).toISOString())
		expect(state.tries).toBe(0)
	})

	it('keeps the last twenty runs', () => {
		let state = newJobState(JOB, made)
		for (let day = 0; day < 25; day++) {
			const at = new Date(2026, 11, 1 + day, 9)
			state = afterRun(state, JOB, run('done', at), at)
		}
		expect(state.runs).toHaveLength(20)
		expect(state.runs[0]?.ranAt).toBe(new Date(2026, 11, 25, 9).toISOString())
	})
})

describe('what a run writes', () => {
	it('names the note by the day it ran', () => {
		expect(destinationNote(JOB.destination, new Date(2026, 0, 5, 9))).toBe('Funding 2026-01-05')
	})

	it('says when it ran late, and nothing when on time', () => {
		const due = new Date(2026, 10, 30, 9)
		expect(latenessNote(due, new Date(2026, 10, 30, 9, 2))).toBeNull()
		expect(latenessNote(due, new Date(2026, 11, 1, 10, 14))).toMatch(/computer was off/)
	})

	it('gets an id a file can be named by, unique among the others', () => {
		expect(jobId('Funding this week!', [])).toBe('funding-this-week')
		expect(jobId('Funding this week', ['funding-this-week'])).toBe('funding-this-week-2')
		expect(jobId('???', [])).toBe('job')
	})
})

describe('a team job', () => {
	it('runs at the same moment for every member, in the zone it was made in', () => {
		const weekly = parseSchedule('weekly mon 09:00')
		// Sunday 29 November 2026, 23:00 in Nairobi (UTC+3) is 20:00 UTC.
		const after = new Date(Date.UTC(2026, 10, 29, 20, 0))
		expect(nextOccurrence(weekly, after, 'Africa/Nairobi').toISOString()).toBe(
			'2026-11-30T06:00:00.000Z',
		)
		expect(nextOccurrence(weekly, after, 'Europe/Berlin').toISOString()).toBe(
			'2026-11-30T08:00:00.000Z',
		)
		// Across the clock change: 09:00 in Berlin is 07:00 UTC in summer.
		expect(
			nextOccurrence(
				parseSchedule('daily 09:00'),
				new Date(Date.UTC(2026, 2, 29, 12)),
				'Europe/Berlin',
			).toISOString(),
		).toBe('2026-03-30T07:00:00.000Z')
		expect(
			nextOccurrence(parseSchedule('monthly 1 09:00'), after, 'America/New_York').toISOString(),
		).toBe('2026-12-01T14:00:00.000Z')
	})

	it('keeps its zone in the file, and refuses one this computer does not know', () => {
		const zoned = { ...JOB, zone: 'Africa/Nairobi' }
		expect(parseJobFile(serializeJobFile(zoned))).toEqual(zoned)
		const bad = serializeJobFile(zoned).replace('Africa/Nairobi', 'Mars/Olympus')
		expect(() => parseJobFile(bad)).toThrow('Not a time zone')
	})

	it('is taken by one computer at a time, unless the claim was left behind', () => {
		const state = newJobState(JOB, new Date(2026, 10, 24))
		const now = new Date(2026, 10, 30, 9)
		const watch = claimWatch()
		const taken = claimRun(state, 'Amina', now, watch.held('funding', state, now))
		expect(taken?.claim).toEqual({ by: 'Amina', at: now.toISOString() })
		const soon = new Date(now.getTime() + 60_000)
		const held = taken ?? state
		expect(claimRun(held, 'Jonas', soon, watch.held('funding', held, soon))).toBeNull()
		const later = new Date(soon.getTime() + CLAIM_STALE_MS + 1)
		expect(claimRun(held, 'Jonas', later, watch.held('funding', held, later))?.claim?.by).toBe(
			'Jonas',
		)
		expect(afterRun(held, JOB, run('done', now), now).claim).toBeUndefined()
	})

	it("ages a claim on this computer's clock, whatever time the claiming one wrote in it", () => {
		const now = new Date(2026, 10, 30, 9)
		const watch = claimWatch()
		for (const hours of [-5, 5]) {
			const claimed = {
				...newJobState(JOB, now),
				claim: { by: 'Jonas', at: new Date(now.getTime() + hours * 3_600_000).toISOString() },
			}
			// A clock hours behind or ahead holds the run all the same, as long as it is fresh here.
			expect(watch.held(`job${hours}`, claimed, now)).toBe(true)
			expect(watch.held(`job${hours}`, claimed, new Date(now.getTime() + 30 * 60_000))).toBe(true)
			expect(watch.held(`job${hours}`, claimed, new Date(now.getTime() + CLAIM_STALE_MS))).toBe(
				false,
			)
		}
		expect(watch.held('none', newJobState(JOB, now), now)).toBe(false)
	})

	it('keeps a team id with a job of its own, on one line', () => {
		const withTeam = { ...JOB, team: 'team-abc' }
		expect(parseJobFile(serializeJobFile(withTeam))).toEqual(withTeam)
		expect(serializeJobFile({ ...JOB, team: 'a\nb' })).toContain('team: a b\n')
	})
})

/** A team storage in memory, with a version per file like a real one. */
function memoryTeamStore() {
	const files = new Map<string, { text: string; version: string }>()
	let next = 1
	const key = (area: TeamArea, name: string) => `${area}/${name}`
	const store: TeamStore = {
		async list(area) {
			return [...files]
				.filter(([path]) => path.startsWith(`${area}/`))
				.map(([path, file]) => ({
					name: path.slice(area.length + 1),
					version: file.version,
					updatedAt: null,
					bytes: file.text.length,
				}))
		},
		read: async (area, name) => files.get(key(area, name)) ?? null,
		async write(area, name, text, expected) {
			const current = files.get(key(area, name))
			if ((current?.version ?? null) !== expected) throw new TeamConflict(area, name)
			const version = `v${next++}`
			files.set(key(area, name), { text, version })
			return { version }
		},
		async remove(area, name, expected) {
			if (files.get(key(area, name))?.version !== expected) throw new TeamConflict(area, name)
			files.delete(key(area, name))
		},
		readTeamFile: async () => null,
	}
	return { store, files }
}

describe('the jobs a team shares', () => {
	const now = new Date(2026, 10, 30, 9)

	it('keeps each job as a file and its state beside it', async () => {
		const { store, files } = memoryTeamStore()
		const jobs = createTeamJobStore(store, () => DEFAULT_TEAM_LIMITS)
		await jobs.write('funding', serializeJobFile(JOB))
		await jobs.update('funding', () => newJobState(JOB, now))
		expect([...files.keys()]).toEqual(['jobs/funding', 'job-states/funding'])
		const [listed] = await jobs.list()
		expect(parseJobFile(listed?.text ?? '')).toEqual(JOB)
		expect(listed?.state?.runs).toEqual([])
		await jobs.remove('funding')
		expect(files.size).toBe(0)
	})

	it('lets only one of two computers claim the same run', async () => {
		const { store } = memoryTeamStore()
		const jobs = createTeamJobStore(store, () => DEFAULT_TEAM_LIMITS)
		await jobs.write('funding', serializeJobFile(JOB))
		await jobs.update('funding', () => newJobState(JOB, new Date(2026, 10, 24)))
		const first = await jobs.update('funding', (state) =>
			state ? claimRun(state, 'Amina', now, false) : null,
		)
		const second = await jobs.update('funding', (state) =>
			state ? claimRun(state, 'Jonas', now, claimWatch().held('funding', state, now)) : null,
		)
		expect(first?.claim?.by).toBe('Amina')
		expect(second).toBeNull()
	})

	it('reads a state again when someone changed it meanwhile, so neither change is lost', async () => {
		const { store, files } = memoryTeamStore()
		const jobs = createTeamJobStore(store, () => DEFAULT_TEAM_LIMITS)
		await jobs.write('funding', serializeJobFile(JOB))
		await jobs.update('funding', () => newJobState(JOB, now))
		let interfered = false
		const after = await jobs.update('funding', (state) => {
			if (!interfered && state) {
				interfered = true
				// Another member pauses it between this read and this write.
				files.set('job-states/funding', {
					text: JSON.stringify({ ...state, paused: true }),
					version: 'theirs',
				})
			}
			return state ? { ...state, runs: [run('done', now)] } : null
		})
		expect(after?.paused).toBe(true)
		expect(after?.runs).toHaveLength(1)
	})

	it('refuses a job file past the team limit', async () => {
		const { store } = memoryTeamStore()
		const jobs = createTeamJobStore(store, () => ({ ...DEFAULT_TEAM_LIMITS, tasksBytes: 10 }))
		await expect(jobs.write('funding', serializeJobFile(JOB))).rejects.toThrow('Team jobs is full')
	})
})

describe('round-one fixes', () => {
	it('takes a time the clock skips as the moment after the skip, east and west of UTC alike', () => {
		const daily = parseSchedule('daily 02:30')
		// 8 March 2026, New York: 02:00 becomes 03:00. 02:30 does not exist; 03:30 EDT is 07:30 UTC.
		expect(
			nextOccurrence(daily, new Date(Date.UTC(2026, 2, 8, 5)), 'America/New_York').toISOString(),
		).toBe('2026-03-08T07:30:00.000Z')
		// 29 March 2026, Berlin: 03:30 CEST is 01:30 UTC.
		expect(
			nextOccurrence(daily, new Date(Date.UTC(2026, 2, 28, 23)), 'Europe/Berlin').toISOString(),
		).toBe('2026-03-29T01:30:00.000Z')
		// Half-hour zones: Kathmandu is UTC+5:45.
		expect(
			nextOccurrence(daily, new Date(Date.UTC(2026, 0, 1)), 'Asia/Kathmandu').toISOString(),
		).toBe('2026-01-01T20:45:00.000Z')
	})

	it('takes a time the clock shows twice as the first of the two', () => {
		// 1 November 2026, New York: 01:30 happens in EDT (05:30 UTC), then again in EST.
		expect(
			nextOccurrence(
				parseSchedule('daily 01:30'),
				new Date(Date.UTC(2026, 10, 1, 3)),
				'America/New_York',
			).toISOString(),
		).toBe('2026-11-01T05:30:00.000Z')
	})

	it('accepts named zones only', () => {
		expect(isTimeZone('Europe/Berlin')).toBe(true)
		expect(isTimeZone('UTC')).toBe(true)
		for (const zone of ['+01:00', 'EST', 'GMT', 'Mars/Olympus'])
			expect(isTimeZone(zone)).toBe(false)
	})

	it('starts a damaged or foreign state again rather than stopping the job', () => {
		for (const text of [
			'{}',
			'[]',
			'null',
			'{"nextDue":"garbage","runs":[]}',
			'{"nextDue":"2026-11-30T08:00:00Z"}',
		])
			expect(parseJobState(text)).toBeNull()
		expect(parseJobState('{"nextDue":"2026-11-30T08:00:00Z","runs":[]}')?.runs).toEqual([])
	})

	it('keeps every field on its own line, and refuses an id a file cannot be named by', () => {
		const text = serializeJobFile({ ...JOB, task: 'a\ntitle: hacked' })
		expect(parseJobFile(text).title).toBe(JOB.title)
		expect(() => parseJobFile(text.replace('id: funding', 'id: ../x'))).toThrow("A job's id")
	})

	it('makes ids from any title: accents dropped, no trailing dash, no device names', () => {
		expect(jobId('Müller Bericht', [])).toBe('muller-bericht')
		expect(jobId(`${'a'.repeat(39)} bcd`, [])).toBe('a'.repeat(39))
		expect(jobId('Con', [])).toBe('job-con')
	})

	it("names a team run's note by the day it was due in the job's zone", () => {
		// Monday 09:00 in Auckland is Sunday 20:00 UTC.
		const due = new Date(Date.UTC(2026, 10, 29, 20))
		expect(destinationNote({ kind: 'team-note', name: 'F {date}' }, due, 'Pacific/Auckland')).toBe(
			'F 2026-11-30',
		)
	})

	it('keeps no state for a job whose file is gone, refuses a job of a name just made, and pools with tasks', async () => {
		const { store, files } = memoryTeamStore()
		const jobs = createTeamJobStore(store, () => ({ ...DEFAULT_TEAM_LIMITS, tasksBytes: 400 }))
		expect(await jobs.update('gone', () => newJobState(JOB, new Date()))).toBeNull()
		expect(files.has('job-states/gone')).toBe(false)
		await jobs.write('funding', serializeJobFile(JOB))
		await expect(jobs.write('funding', serializeJobFile(JOB))).rejects.toThrow(
			'just made a job of that name',
		)
		await store.write('tasks', 'big', 'x'.repeat(300), null)
		await expect(jobs.write('other', serializeJobFile({ ...JOB, id: 'other' }))).rejects.toThrow(
			'Team jobs is full',
		)
	})
})

describe('round-two fixes', () => {
	it('gets the clock change right in zones twelve hours or more ahead of UTC', () => {
		const daily = parseSchedule('daily 02:30')
		// 27 September 2026, Auckland: 02:00 becomes 03:00 (NZST +12 to NZDT +13). 03:30 NZDT is 14:30 UTC.
		expect(
			nextOccurrence(daily, new Date(Date.UTC(2026, 8, 26, 10)), 'Pacific/Auckland').toISOString(),
		).toBe('2026-09-26T14:30:00.000Z')
		// 5 April 2026, Auckland: 03:00 goes back to 02:00, so 02:30 happens twice; the first is NZDT, 13:30 UTC.
		expect(
			nextOccurrence(daily, new Date(Date.UTC(2026, 3, 4, 10)), 'Pacific/Auckland').toISOString(),
		).toBe('2026-04-04T13:30:00.000Z')
	})

	it('starts again from a state whose runs are not runs', () => {
		const base = { nextDue: '2026-11-30T08:00:00Z' }
		for (const runs of [
			[null],
			[{ dueAt: 'x', ranAt: 'y', outcome: 'done', changes: [null] }],
			['run'],
		])
			expect(parseJobState(JSON.stringify({ ...base, runs }))).toBeNull()
		expect(parseJobState(JSON.stringify({ ...base, runs: [], claim: 'x' }))).toBeNull()
		expect(parseJobState(JSON.stringify({ ...base, runs: [], paused: 'no' }))).toBeNull()
	})

	it('records a run even when the state has grown past its size, shortening older runs first', async () => {
		const { store } = memoryTeamStore()
		const jobs = createTeamJobStore(store, () => DEFAULT_TEAM_LIMITS)
		await jobs.write('funding', serializeJobFile(JOB))
		const big = {
			tool: 'add_note',
			args: { text: 'x'.repeat(30_000) },
			decision: 'waiting' as const,
		}
		const runs = Array.from({ length: 20 }, (_, index) => ({
			...run('waiting', new Date(2026, 0, 1 + index)),
			changes: [big],
		}))
		const written = await jobs.update('funding', () => ({ ...newJobState(JOB, new Date()), runs }))
		expect(written).not.toBeNull()
		const kept = parseJobState((await store.read('job-states', 'funding'))?.text)
		expect(kept?.runs.length).toBeGreaterThan(1)
		expect(String(kept?.runs[0]?.changes?.[0]?.args.text).length).toBe(30_000)
		expect(String(kept?.runs[1]?.changes?.[0]?.args.text).length).toBeLessThan(600)
	})

	it("does not count a task of the same name as the job's own size", async () => {
		const { store } = memoryTeamStore()
		const jobs = createTeamJobStore(store, () => ({ ...DEFAULT_TEAM_LIMITS, tasksBytes: 300 }))
		await store.write('tasks', 'funding', 'x'.repeat(200), null)
		await expect(jobs.write('funding', serializeJobFile(JOB))).rejects.toThrow('Team jobs is full')
	})

	it('keeps the zone on its own line and refuses a device name as an id', () => {
		const text = serializeJobFile({ ...JOB, zone: 'Europe/Berlin\nid: evil' })
		expect(text).not.toMatch(/\nid: evil/)
		expect(() => parseJobFile(serializeJobFile({ ...JOB, id: 'con' }))).toThrow('Windows')
	})

	it('spells out letters no decomposition turns plain, and tells ids apart in any case', () => {
		expect(jobId('Größe', [])).toBe('grosse')
		expect(jobId('Łódź report', [])).toBe('lodz-report')
		expect(jobId('funding', ['Funding'])).toBe('funding-2')
	})
})

describe('a task saved for the team', () => {
	const TASK = {
		id: 'funder-check',
		title: 'Funder page check',
		description: 'Says what changed.',
		ask: 'The funder',
		tools: 'none' as const,
		instructions: 'List what changed.',
	}

	it('counts with team jobs toward the tasks limit', async () => {
		const { store } = memoryTeamStore()
		await store.write('jobs', 'big', 'x'.repeat(900), null)
		const limits = { ...DEFAULT_TEAM_LIMITS, tasksBytes: 1000 }
		await expect(
			saveTeamTask(store, limits, 'funder-check', serializeTaskFile(TASK), null),
		).rejects.toThrow('Team tasks is full')
	})

	it('saves on a connector, which keeps no team jobs', async () => {
		const { store, files } = memoryTeamStore()
		const connector: TeamStore = {
			...store,
			list: async (area) => {
				if (area === 'jobs') throw new Error('A connector does not keep team jobs.')
				return store.list(area)
			},
		}
		await saveTeamTask(
			connector,
			DEFAULT_TEAM_LIMITS,
			'funder-check',
			serializeTaskFile(TASK),
			null,
		)
		expect(files.has('tasks/funder-check')).toBe(true)
	})

	it('is never written as a file that would not read back', () => {
		expect(() => serializeTaskFile({ ...TASK, ask: '  ' })).toThrow('needs ask')
		expect(() => serializeTaskFile({ ...TASK, tools: ['all'] })).toThrow("tool's name")
		const named = { ...TASK, tools: ['search', 'fetch'] }
		expect(parseTaskFile(serializeTaskFile(named))).toEqual(named)
		const fenced = { ...TASK, instructions: 'First.\n---\nThen this.' }
		expect(parseTaskFile(serializeTaskFile(fenced))).toEqual(fenced)
	})
})
