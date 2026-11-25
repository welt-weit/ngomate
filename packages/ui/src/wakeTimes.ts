import type { Schedule } from '@ngomate/core'
import type { WakeTime } from './host.js'

/**
 * When this computer starts NGOmate for a job: its next date on this computer's own clock, kept as
 * daily, weekly or monthly. Worked out again whenever the jobs change, so a team job's other zone and
 * a change of the clocks are followed.
 */
export function wakeTimeOf(schedule: Schedule, nextDue: Date): WakeTime {
	const time = { hour: nextDue.getHours(), minute: nextDue.getMinutes() }
	if (schedule.every === 'week') return { ...time, weekday: nextDue.getDay() }
	// A month day stops at 28; another zone can move it a day on, which the scheduler would not take.
	if (schedule.every === 'month') return { ...time, day: Math.min(28, nextDue.getDate()) }
	return time
}

/** The same time once, in a steady order, so an unchanged list is never written to the system again. */
export function wakeList(times: WakeTime[]): WakeTime[] {
	const seen = new Map(times.map((time) => [JSON.stringify(time), time]))
	return [...seen.keys()].sort().map((key) => seen.get(key) as WakeTime)
}
