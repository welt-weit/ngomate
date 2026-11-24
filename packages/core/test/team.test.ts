import { describe, expect, it, vi } from 'vitest'
import { runTask } from '../src/agent.js'
import type { ToolSource } from '../src/mcp.js'
import { type MemoryStore, buildMemoryContext, createMemoryToolSource } from '../src/memory.js'
import type { ModelClient, ModelReply } from '../src/model.js'
import {
	DEFAULT_TEAM_LIMITS,
	type TeamArea,
	type TeamNoteCopy,
	TeamConflict,
	type TeamStore,
	chooseTeamNotes,
	createTeamNotes,
	inviteCode,
	inviteLink,
	newTeamFile,
	parseInvite,
	parseTeamFile,
	serializeTeamFile,
	teamLimitProblem,
} from '../src/team.js'

/** A team storage in memory, with a version per note like a real one. */
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
					updatedAt: file.version,
					bytes: new TextEncoder().encode(file.text).length,
				}))
		},
		async read(area, name) {
			return files.get(key(area, name)) ?? null
		},
		async write(area, name, text, expected) {
			const current = files.get(key(area, name))
			if ((current?.version ?? null) !== expected) throw new TeamConflict(area, name)
			const version = `v${next++}`
			files.set(key(area, name), { text, version })
			return { version }
		},
		async remove(area, name) {
			files.delete(key(area, name))
		},
		readTeamFile: async () => null,
	}
	return { store, files }
}

function personalStore(): MemoryStore {
	const notes = new Map<string, string>()
	return {
		list: async () =>
			[...notes].map(([name, text]) => ({ name, updatedAt: null, chars: text.length })),
		read: async (name) => notes.get(name) ?? null,
		write: async (name, text) => {
			notes.set(name, text)
		},
		remove: async (name) => {
			notes.delete(name)
		},
	}
}

describe('the team file', () => {
	it('keeps only what it knows, and fills in the limits', () => {
		const team = parseTeamFile(
			JSON.stringify({
				format: 1,
				name: ' Riverside Water Group ',
				token: 'should-not-survive',
				connectors: [
					{ name: 'Good', url: 'https://example.org/mcp', apiKey: 'x' },
					{ name: 'Plain web', url: 'http://example.org/mcp' },
					{ name: 'With a password', url: 'https://user:secret@example.org/mcp' },
				],
			}),
		)
		expect(team).toEqual({
			format: 1,
			name: 'Riverside Water Group',
			createdBy: null,
			limits: DEFAULT_TEAM_LIMITS,
			connectors: [{ name: 'Good', url: 'https://example.org/mcp' }],
		})
	})

	it('says when a newer app made it', () => {
		expect(() => parseTeamFile(JSON.stringify({ format: 2, name: 'x' }))).toThrow(/newer version/)
	})

	it('reads back what it wrote', () => {
		const team = newTeamFile('Riverside', 'Amina')
		expect(parseTeamFile(serializeTeamFile(team))).toEqual(team)
	})
})

describe('invites', () => {
	const invite = {
		format: 1 as const,
		team: 'Riverside',
		storage: {
			type: 's3' as const,
			endpoint: 'https://s3.example.org',
			region: 'eu',
			bucket: 'notes',
		},
	}

	it('reads a link and a code alike', () => {
		expect(parseInvite(inviteLink(invite))).toEqual(invite)
		expect(parseInvite(`  ${inviteCode(invite)}\n`)).toEqual(invite)
	})

	it('drops anything an invite may not carry, such as a key', () => {
		const crafted = inviteCode({
			...invite,
			storage: { ...invite.storage, secretKey: 'abc' },
			password: 'x',
		} as never)
		const read = parseInvite(crafted)
		expect(JSON.stringify(read)).not.toMatch(/abc|password/)
		expect(read).toEqual(invite)
	})

	it('refuses an address that is not https or on this computer', () => {
		const plain = inviteCode({
			format: 1,
			team: 'x',
			storage: { type: 'webdav', url: 'http://dav.example.org' },
		})
		expect(() => parseInvite(plain)).toThrow(/does not say where/)
		const local = inviteCode({
			format: 1,
			team: 'x',
			storage: { type: 'webdav', url: 'http://localhost:8080' },
		})
		expect(parseInvite(local).storage).toEqual({ type: 'webdav', url: 'http://localhost:8080' })
	})

	it('refuses what is not an invite', () => {
		expect(() => parseInvite('hello there')).toThrow(/not an invite/)
		expect(() => parseInvite('')).toThrow(/not an invite/)
	})
})

describe('team limits', () => {
	const limits = { notesBytes: 100, noteBytes: 40, tasksBytes: 50 }
	const entries = [
		{ name: 'a', version: '1', updatedAt: null, bytes: 30 },
		{ name: 'b', version: '1', updatedAt: null, bytes: 60 },
	]

	it('refuses a note larger than one note may be', () => {
		expect(teamLimitProblem(limits, 'notes', entries, 'c', 'x'.repeat(41))).toMatch(
			/at most 40 bytes/,
		)
	})

	it('refuses growing past the total, counting only the difference on a replace', () => {
		expect(teamLimitProblem(limits, 'notes', entries, 'c', 'x'.repeat(11))).toMatch(/is full/)
		expect(teamLimitProblem(limits, 'notes', entries, 'a', 'x'.repeat(40))).toBeNull()
	})

	it('lets a note over the limit be shortened', () => {
		const over = [{ name: 'a', version: '1', updatedAt: null, bytes: 200 }]
		expect(teamLimitProblem(limits, 'notes', over, 'a', 'short')).toBeNull()
	})
})

describe('team notes', () => {
	it('refuses to overwrite a change made since the note was read', async () => {
		const { store, files } = memoryTeamStore()
		const notes = createTeamNotes(store, () => DEFAULT_TEAM_LIMITS)
		await notes.save('plan', 'first')
		await notes.read('plan')
		files.set('notes/plan', { text: 'changed by someone else', version: 'other' })
		await expect(notes.save('plan', 'mine')).rejects.toBeInstanceOf(TeamConflict)
		expect(files.get('notes/plan')?.text).toBe('changed by someone else')
	})

	it('refuses to replace a note that appeared while saving a new one', async () => {
		const { store, files } = memoryTeamStore()
		const notes = createTeamNotes(store, () => DEFAULT_TEAM_LIMITS)
		const write = store.write.bind(store)
		store.write = async (area, name, text, expected) => {
			files.set('notes/new', { text: 'theirs', version: 'x' })
			return write(area, name, text, expected)
		}
		await expect(notes.save('new', 'mine')).rejects.toBeInstanceOf(TeamConflict)
	})

	it('reads a note again only when its version changed', async () => {
		const { store } = memoryTeamStore()
		const notes = createTeamNotes(store, () => DEFAULT_TEAM_LIMITS)
		await notes.save('plan', 'text')
		const read = vi.spyOn(store, 'read')
		await notes.readAll()
		await notes.readAll()
		expect(read).not.toHaveBeenCalled()
	})

	it('picks the notes that share the question’s words', () => {
		const notes = [
			{ name: 'office', text: 'The office opens at nine.', updatedAt: '2026-11-03' },
			{
				name: 'boreholes',
				text: 'Borehole repairs cost about 400 euros.',
				updatedAt: '2026-11-01',
			},
			{ name: 'donors', text: 'Thank donors within a week.', updatedAt: '2026-11-02' },
		]
		const chosen = chooseTeamNotes(notes, 'What does a borehole repair cost?', 45)
		expect(chosen.included.map((note) => note.name)).toEqual(['boreholes'])
		expect(chosen.omitted).toEqual(['office', 'donors'])
	})
})

describe('saving to the team', () => {
	const say = (content: string): ModelReply => ({
		content,
		toolCalls: [],
		promptTokens: 1,
		completionTokens: 1,
	})
	const save: ModelReply = {
		content: null,
		toolCalls: [
			{
				id: 'c1',
				name: 'save_memory',
				arguments: JSON.stringify({ name: 'Plan', text: 'Meet on Monday.' }),
			},
		],
		promptTokens: 1,
		completionTokens: 1,
	}
	const profile = {
		id: 'chat',
		instructions: 'Help.',
		readTools: [],
		writeTools: [],
		allTools: true,
	}

	function setup() {
		const replies = [save, say('Saved.')]
		const model = { chat: vi.fn(async () => replies.shift() as ModelReply) } as ModelClient
		const team = memoryTeamStore()
		const own = personalStore()
		const tools: ToolSource = createMemoryToolSource(
			own,
			createTeamNotes(team.store, () => DEFAULT_TEAM_LIMITS),
		)
		return { model, tools, team, own }
	}

	it('asks where, and saves where the person picked', async () => {
		const { model, tools, team, own } = setup()
		const confirmWrite = vi.fn(async () => ({ choice: 'team' }))
		await runTask({ model, tools, profile, input: 'remember it', confirmWrite })
		expect(confirmWrite).toHaveBeenCalledWith(
			expect.objectContaining({
				choices: [expect.objectContaining({ id: 'me' }), expect.objectContaining({ id: 'team' })],
			}),
		)
		expect(team.files.get('notes/plan')?.text).toBe('Meet on Monday.')
		expect(await own.read('plan')).toBeNull()
	})

	it('saves for the person alone when they just approve', async () => {
		const { model, tools, team, own } = setup()
		await runTask({ model, tools, profile, input: 'remember it', confirmWrite: async () => true })
		expect(await own.read('plan')).toBe('Meet on Monday.')
		expect(team.files.size).toBe(0)
	})

	it('saves nothing when the answer names an option that was not offered', async () => {
		const { model, tools, team, own } = setup()
		await runTask({
			model,
			tools,
			profile,
			input: 'remember it',
			confirmWrite: async () => ({ choice: 'everyone' }),
		})
		expect(await own.read('plan')).toBeNull()
		expect(team.files.size).toBe(0)
	})

	it('cannot be told by the model where to save', async () => {
		const { model, tools, team, own } = setup()
		save.toolCalls[0] = {
			...save.toolCalls[0],
			arguments: JSON.stringify({ name: 'team/plan', text: 'x', choice: 'team' }),
		} as never
		await runTask({ model, tools, profile, input: 'remember it', confirmWrite: async () => true })
		expect(team.files.size).toBe(0)
		expect(await own.read('plan')).toBe('x')
	})
})

describe('reading team notes', () => {
	it('reads a teammate’s own file by the name it is listed under', async () => {
		const { store, files } = memoryTeamStore()
		files.set('notes/Pump Notes', { text: 'Seal on pump 3.', version: 'v1' })
		const tools = createMemoryToolSource(
			personalStore(),
			createTeamNotes(store, () => DEFAULT_TEAM_LIMITS),
		)
		expect((await tools.callTool('list_memory', {})).text).toContain('team/Pump Notes')
		expect(await tools.callTool('read_memory', { name: 'team/Pump Notes' })).toEqual({
			text: 'Seal on pump 3.',
			isError: false,
		})
	})
})

describe('the memory at the start of a conversation', () => {
	it('carries the person’s notes and the team notes the question needs', async () => {
		const own = personalStore()
		await own.write('me', 'I work on water projects.')
		const { store } = memoryTeamStore()
		const notes = createTeamNotes(store, () => DEFAULT_TEAM_LIMITS)
		await notes.save('boreholes', 'Borehole repairs cost about 400 euros.')
		await notes.save('office', 'The office opens at nine. '.repeat(10))
		const context = await buildMemoryContext(own, 400, { notes, question: 'borehole repair cost' })
		expect(context).toContain('I work on water projects.')
		expect(context).toContain('team/boreholes (team note)')
		expect(context).toContain('Other team notes, available through read_memory: team/office')
	})

	it('stays within its room with hundreds of team notes, counting those it leaves out', async () => {
		const own = personalStore()
		await own.write('me', 'I work on water projects.')
		const { store } = memoryTeamStore()
		const notes = createTeamNotes(store, () => DEFAULT_TEAM_LIMITS)
		await notes.save('boreholes', 'Borehole repairs cost about 400 euros.')
		for (let i = 0; i < 200; i++) await notes.save(`meeting notes ${i}`, `Notes from meeting ${i}.`)
		const context = await buildMemoryContext(own, 900, { notes, question: 'borehole repair cost' })
		expect(context.length).toBeLessThanOrEqual(900)
		expect(context).toContain('Borehole repairs cost about 400 euros.')
		expect(context).toMatch(/\d+ more not named here, listed by list_memory\.$/)
	})
})

describe('a connector as team storage', () => {
	it('needs every team memory tool', async () => {
		const { offersTeamTools } = await import('../src/team.js')
		const all = ['list_notes', 'read_note', 'write_note', 'delete_note', 'get_team'].map(
			(name) => ({ name }),
		)
		expect(offersTeamTools(all)).toBe(true)
		expect(offersTeamTools(all.slice(1))).toBe(false)
	})

	it('turns a conflict answer into a TeamConflict, and other refusals into their message', async () => {
		const { createConnectorTeamStore } = await import('../src/team.js')
		const answers: Record<string, { text: string; isError: boolean }> = {
			write_note: { text: '{"code":"conflict"}', isError: true },
			delete_note: { text: '{"message":"Read only for you."}', isError: true },
			read_note: { text: '{"code":"not_found"}', isError: true },
		}
		const store = createConnectorTeamStore({
			callTool: async (name) => answers[name] ?? { text: '[]', isError: false },
		})
		await expect(store.write('notes', 'a', 'x', 'v1')).rejects.toBeInstanceOf(TeamConflict)
		await expect(store.remove('notes', 'a', 'v1')).rejects.toThrow('Read only for you.')
		expect(await store.read('notes', 'a')).toBeNull()
		expect(await store.list('notes')).toEqual([])
	})
})

describe('sync apps’ conflict copies', () => {
	it('knows each app’s copy, and not a note that is only about conflict', async () => {
		const { isConflictCopy } = await import('../src/team.js')
		const notes = ['Plan', 'conflict-resolution']
		for (const name of [
			'Plan (conflicted copy 2026-11-23)',
			'Plan.sync-conflict-20261123-101010-ABCDEFG',
			'Plan [Conflict]',
			'Plan-DESKTOP-AB12C',
		]) {
			expect(isConflictCopy(name, notes), name).toBe(true)
		}
		expect(isConflictCopy('conflict-resolution', notes)).toBe(false)
		expect(isConflictCopy('Budget-2027', notes)).toBe(false)
		expect(isConflictCopy('Water-WHO', notes)).toBe(false)
	})
})

describe('a Nextcloud invite', () => {
	it('names the server and the folder, never the account', () => {
		const invite = {
			format: 1 as const,
			team: 'Riverside',
			storage: {
				type: 'nextcloud' as const,
				server: 'https://cloud.example.org',
				folder: 'Riverside',
			},
		}
		expect(parseInvite(inviteLink(invite))).toEqual(invite)
		const plain = inviteCode({
			...invite,
			storage: { ...invite.storage, server: 'http://cloud.example.org' },
		})
		expect(() => parseInvite(plain)).toThrow(/does not say where/)
	})
})

describe('reading team notes for each message', () => {
	it('reuses the list for a while, and lists again after a save', async () => {
		const { store } = memoryTeamStore()
		let clock = 0
		const notes = createTeamNotes(
			store,
			() => DEFAULT_TEAM_LIMITS,
			() => clock,
		)
		await notes.save('plan', 'text')
		const list = vi.spyOn(store, 'list')
		await notes.readAll()
		await notes.readAll()
		expect(list).toHaveBeenCalledTimes(1)
		clock = 31_000
		await notes.readAll()
		expect(list).toHaveBeenCalledTimes(2)
		await notes.save('other', 'more')
		await notes.readAll()
		expect(list).toHaveBeenCalledTimes(4)
	})
	it('fetches on a new start only the notes whose version changed', async () => {
		const { store, files } = memoryTeamStore()
		for (const name of ['a', 'b', 'c'])
			files.set(`notes/${name}`, { text: `Note ${name}.`, version: `${name}1` })
		let kept: Record<string, TeamNoteCopy> = {}
		const copies = {
			load: async () => kept,
			save: vi.fn(async (notes: Record<string, TeamNoteCopy>) => {
				kept = notes
			}),
		}
		const read = vi.spyOn(store, 'read')
		await createTeamNotes(store, () => DEFAULT_TEAM_LIMITS, Date.now, copies).readAll()
		expect(read).toHaveBeenCalledTimes(3)

		files.set('notes/b', { text: 'Note b, changed.', version: 'b2' })
		files.delete('notes/c')
		read.mockClear()
		const again = await createTeamNotes(
			store,
			() => DEFAULT_TEAM_LIMITS,
			Date.now,
			copies,
		).readAll()
		expect(read.mock.calls.map(([, name]) => name)).toEqual(['b'])
		expect(again.map((note) => note.text)).toEqual(['Note a.', 'Note b, changed.'])
		expect(Object.keys(kept)).toEqual(['a', 'b'])
	})

	it('saves the copies only when they changed', async () => {
		const { store, files } = memoryTeamStore()
		files.set('notes/a', { text: 'A.', version: 'a1' })
		const copies = { load: async () => ({}), save: vi.fn(async () => {}) }
		let clock = 0
		const notes = createTeamNotes(
			store,
			() => DEFAULT_TEAM_LIMITS,
			() => clock,
			copies,
		)
		await notes.readAll()
		clock = 31_000
		await notes.readAll()
		expect(copies.save).toHaveBeenCalledTimes(1)
	})

	it('reads a few notes at once, and a second request joins the one under way', async () => {
		const { store, files } = memoryTeamStore()
		for (let i = 0; i < 30; i++) files.set(`notes/n${i}`, { text: `Note ${i}.`, version: `v${i}` })
		const read = store.read
		let open = 0
		let most = 0
		let calls = 0
		store.read = async (area, name) => {
			calls++
			open++
			most = Math.max(most, open)
			await new Promise((resolve) => setTimeout(resolve, 1))
			open--
			return read(area, name)
		}
		const notes = createTeamNotes(store, () => DEFAULT_TEAM_LIMITS)
		const [first, second] = await Promise.all([notes.readAll(), notes.readAll()])
		expect(first).toHaveLength(30)
		expect(second).toBe(first)
		expect(calls).toBe(30)
		expect(most).toBe(8)
	})

	it('leaves out a note that cannot be read now, even with an older copy', async () => {
		const { store, files } = memoryTeamStore()
		files.set('notes/a', { text: 'New text.', version: 'a2' })
		const copies = {
			load: async () => ({ a: { version: 'a1', text: 'Old text.' } }),
			save: async () => {},
		}
		store.read = async () => {
			throw new Error('offline')
		}
		const all = await createTeamNotes(store, () => DEFAULT_TEAM_LIMITS, Date.now, copies).readAll()
		expect(all).toEqual([])
	})
})
