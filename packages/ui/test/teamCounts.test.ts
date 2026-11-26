import { TeamConflict, type TeamStore } from '@ngomate/core'
import { describe, expect, it } from 'vitest'
import type { PolicyRecordEntry } from '../src/policyCheck.js'
import { countForTeam, teamCounts } from '../src/teamCounts.js'

function memoryStore() {
	const files = new Map<string, { text: string; version: string }>()
	let next = 1
	const store: TeamStore = {
		list: async (area) =>
			[...files]
				.filter(([path]) => path.startsWith(`${area}/`))
				.map(([path, file]) => ({
					name: path.slice(area.length + 1),
					version: file.version,
					updatedAt: null,
					bytes: file.text.length,
				})),
		read: async (area, name) => files.get(`${area}/${name}`) ?? null,
		async write(area, name, text, expected) {
			if ((files.get(`${area}/${name}`)?.version ?? null) !== expected)
				throw new TeamConflict(area, name)
			const version = `v${next++}`
			files.set(`${area}/${name}`, { text, version })
			return { version }
		},
		remove: async () => {},
		readTeamFile: async () => null,
	}
	return { store, files }
}

const entry = (more: Partial<PolicyRecordEntry>): PolicyRecordEntry => ({
	at: '2026-11-25T10:00:00.000Z',
	feature: 'chat',
	where: ['model'],
	dataClass: 'personal',
	action: 'local_only',
	observed: false,
	template: 'standard',
	version: 1,
	...more,
})

describe("the team's counts", () => {
	it('keeps numbers per month for each computer, and sums them for the team', async () => {
		const { store, files } = memoryStore()
		await countForTeam(store, 'computer-a', entry({}))
		await countForTeam(store, 'computer-a', entry({ action: 'redact' }))
		await countForTeam(store, 'computer-b', entry({ action: 'block' }))
		await countForTeam(store, 'computer-b', entry({ observed: true }))
		await countForTeam(store, 'computer-b', entry({ at: '2026-10-02T10:00:00.000Z' }))
		expect(await teamCounts(store, '2026-11')).toEqual({
			computers: 2,
			counts: { kept: 1, asked: 1, stopped: 1, watched: 1 },
		})
		// Nothing but the numbers: no class, time of day, feature or text.
		const written = files.get('policy-counts/computer-b')?.text ?? ''
		expect(JSON.parse(written)).toEqual({
			'2026-10': { kept: 1, asked: 0, stopped: 0, watched: 0 },
			'2026-11': { kept: 0, asked: 0, stopped: 1, watched: 1 },
		})
	})
})
