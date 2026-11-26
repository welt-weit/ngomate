import { TeamConflict, type TeamStore } from '@ngomate/core'
import type { PolicyRecordEntry } from './policyCheck.js'

/**
 * What the AI-use policy did in a team, as numbers: each computer keeps one file in the team's storage
 * (`policy-counts/<id>.json`, the id a random one this computer made, never a name) with a count per
 * month. Never the time of day, the kind of data, or anything a conversation said. The person
 * accountable for the policy reads the sum.
 */

export type MonthCounts = {
	/** Answered on this computer instead of leaving it. */
	kept: number
	/** Asked first, the person confirming or not. */
	asked: number
	/** Not sent at all. */
	stopped: number
	/** Would have been held back, under a policy that only watches. */
	watched: number
}

type CountsFile = Record<string, MonthCounts>

const AREA = 'policy-counts'
const MONTHS_KEPT = 12
const zero = (): MonthCounts => ({ kept: 0, asked: 0, stopped: 0, watched: 0 })

/** The month an entry falls in, as `YYYY-MM`. */
export const monthOf = (at: string) => at.slice(0, 7)

function parse(text: string | undefined): CountsFile {
	if (!text) return {}
	try {
		const value = JSON.parse(text)
		return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
	} catch {
		return {}
	}
}

function kind(entry: PolicyRecordEntry): keyof MonthCounts {
	if (entry.observed) return 'watched'
	if (entry.action === 'block') return 'stopped'
	if (entry.action === 'allow_with_review' || entry.action === 'redact') return 'asked'
	return 'kept'
}

let writing: Promise<unknown> = Promise.resolve()

/** Adds one entry to this computer's counts in the team's storage. One write at a time. */
export function countForTeam(
	store: TeamStore,
	computer: string,
	entry: PolicyRecordEntry,
): Promise<void> {
	const next = writing.then(async () => {
		// Only this computer writes its file, so a conflict means a write of its own got there first.
		for (let attempt = 0; attempt < 2; attempt++) {
			const read = await store.read(AREA, computer)
			const file = parse(read?.text)
			const month = monthOf(entry.at)
			const counts = { ...zero(), ...file[month] }
			counts[kind(entry)] += 1
			file[month] = counts
			const months = Object.keys(file).sort().slice(-MONTHS_KEPT)
			const kept = Object.fromEntries(months.map((each) => [each, file[each]]))
			try {
				await store.write(AREA, computer, JSON.stringify(kept), read?.version ?? null)
				return
			} catch (err) {
				if (!(err instanceof TeamConflict) || attempt === 1) throw err
			}
		}
	})
	writing = next.catch(() => {})
	return next
}

/** The team's counts for one month, summed over every computer that wrote any. */
export async function teamCounts(
	store: TeamStore,
	month: string,
): Promise<{ computers: number; counts: MonthCounts }> {
	const entries = await store.list(AREA)
	const counts = zero()
	let computers = 0
	for (const entry of entries) {
		const read = await store.read(AREA, entry.name).catch(() => null)
		const monthly = parse(read?.text)[month]
		if (!monthly) continue
		computers += 1
		for (const key of Object.keys(counts) as (keyof MonthCounts)[])
			counts[key] += Number(monthly[key]) || 0
	}
	return { computers, counts }
}
