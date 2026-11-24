// @vitest-environment jsdom
import {
	type ChatRequest,
	type ModelReply,
	TeamConflict,
	type TeamFile,
	type TeamStore,
	type ToolSource,
	inviteCode,
	newTeamFile,
	parseInvite,
	parseTeamFile,
	serializeTeamFile,
} from '@ngomate/core'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NgomateApp } from '../src/NgomateApp.js'
import {
	type Addon,
	type Conversation,
	DEFAULT_SETTINGS,
	type MenuCommand,
	type NgomateHost,
	type Settings,
	type TeamHost,
	type TeamLocation,
	type TeamMembership,
} from '../src/host.js'
import { parseMenuCommand } from '../src/menu.js'

afterEach(cleanup)

const say = (content: string): ModelReply => ({
	content,
	toolCalls: [],
	promptTokens: 1,
	completionTokens: 1,
})
const call = (name: string, args: unknown): ModelReply => ({
	content: null,
	toolCalls: [{ id: `c-${name}`, name, arguments: JSON.stringify(args) }],
	promptTokens: 1,
	completionTokens: 1,
})

type Files = Map<string, { text: string; version: string }>

/**
 * The host's teams in memory, each kept in its own place: a folder's files as its sync app would carry
 * them, a bucket's or a server's. `files` is the place at `path`, the folder picked by default.
 */
function sharedFolder(path = '/Shared/Riverside') {
	const places = new Map<string, Files>()
	let next = 1
	const placeOf = (location: TeamLocation) =>
		location.type === 'folder'
			? location.path
			: location.type === 'connector'
				? `connector:${location.addonId}`
				: location.type === 's3'
					? `${location.endpoint}/${location.bucket}`
					: location.url
	const at = (place: string) => {
		const found = places.get(place) ?? new Map()
		places.set(place, found)
		return found
	}
	let memberships: TeamMembership[] = []
	let active: string | null = null
	let previous: string | null = null
	let pick = path
	const current = () => memberships.find((membership) => membership.id === active)
	const here = () => {
		const team = current()
		return team && team.location.type !== 'connector'
			? at(placeOf(team.location))
			: (new Map() as Files)
	}
	const put = (files: Files, key: string, text: string) => {
		const version = `v${next++}`
		files.set(key, { text, version })
		return version
	}
	const add = (location: TeamLocation) => {
		const same = memberships.find(
			(membership) => placeOf(membership.location) === placeOf(location),
		)
		const id = same?.id ?? `team-${next++}`
		if (!same) memberships = [...memberships, { id, name: null, location, refusesOverwrites: true }]
		if (active !== id) previous = active
		active = id
	}
	const store: TeamStore = {
		list: async (area) =>
			[...here()]
				.filter(([key]) => key.startsWith(`${area}/`))
				.map(([key, file]) => ({
					name: key.slice(area.length + 1),
					version: file.version,
					updatedAt: null,
					bytes: file.text.length,
				})),
		read: async (area, name) => here().get(`${area}/${name}`) ?? null,
		async write(area, name, text, expected) {
			if ((here().get(`${area}/${name}`)?.version ?? null) !== expected)
				throw new TeamConflict(area, name)
			return { version: put(here(), `${area}/${name}`, text) }
		},
		async remove(area, name) {
			here().delete(`${area}/${name}`)
		},
		readTeamFile: async () => {
			const file = here().get('team')
			return file ? parseTeamFile(file.text) : null
		},
	}
	const forget = vi.fn(async () => {
		memberships = memberships.filter((membership) => membership.id !== active)
		active = memberships.some((membership) => membership.id === previous)
			? previous
			: (memberships[0]?.id ?? null)
		previous = null
	})
	const team: TeamHost = {
		teams: async () => ({ active, teams: memberships }),
		switchTo: async (id) => {
			if (active !== id) previous = active
			active = id
		},
		label: async (name) => {
			memberships = memberships.map((membership) =>
				membership.id === active ? { ...membership, name } : membership,
			)
		},
		location: async () => current()?.location ?? null,
		chooseFolder: async () => {
			add({ type: 'folder', path: pick })
			return pick
		},
		use: vi.fn(async (location: Exclude<TeamLocation, { type: 'folder' }>) => add(location)),
		forget,
		store,
		readTeamFile: async () => {
			const file = here().get('team')
			return file ? { team: parseTeamFile(file.text), version: file.version } : null
		},
		async writeTeamFile(file, expected) {
			if ((here().get('team')?.version ?? null) !== expected)
				throw new TeamConflict('notes', 'team')
			put(here(), 'team', serializeTeamFile(file))
		},
	}
	const files = at(path)
	return {
		team,
		files,
		forget,
		holdTeam: (file: TeamFile, place = path) => put(at(place), 'team', serializeTeamFile(file)),
		put: (key: string, text: string, place = path) => put(at(place), key, text),
		join: (place = path) => add({ type: 'folder', path: place }),
		pickFolder: (place: string) => {
			pick = place
		},
	}
}

/** A connector that holds a team through the team memory tools, kept in memory. */
function teamConnector(team: TeamFile | null) {
	const notes = new Map<string, { text: string; version: string }>()
	let next = 1
	const json = (value: unknown, isError = false) => ({ text: JSON.stringify(value), isError })
	const source: ToolSource = {
		listTools: async () =>
			['list_notes', 'read_note', 'write_note', 'delete_note', 'get_team'].map((name) => ({
				name,
				description: name,
				inputSchema: {},
				annotations: {
					readOnly: name.startsWith('list') || name.startsWith('read') || name === 'get_team',
				},
			})),
		async callTool(name, args) {
			const key = `${args.area}/${args.name}`
			switch (name) {
				case 'get_team':
					return team
						? { text: serializeTeamFile(team), isError: false }
						: json({ code: 'not_found' }, true)
				case 'list_notes':
					return json(
						[...notes]
							.filter(([path]) => path.startsWith(`${args.area}/`))
							.map(([path, note]) => ({
								name: path.split('/')[1],
								version: note.version,
								bytes: note.text.length,
							})),
					)
				case 'read_note': {
					const note = notes.get(key)
					return note ? json(note) : json({ code: 'not_found' }, true)
				}
				case 'write_note': {
					if ((notes.get(key)?.version ?? null) !== args.expectedVersion)
						return json({ code: 'conflict' }, true)
					const version = `c${next++}`
					notes.set(key, { text: String(args.text), version })
					return json({ version })
				}
				default:
					notes.delete(key)
					return json({})
			}
		},
		close: async () => {},
	}
	return { source, notes }
}

const trackerAddon: Addon = {
	id: 'tracker',
	name: 'Our tracker',
	connection: { kind: 'http', url: 'https://tracker.example.org/mcp' },
	enabled: true,
	allowDestructive: false,
}

function makeHost(
	replies: ModelReply[],
	team: TeamHost,
	settings: Partial<Settings> = {},
	connectAddon?: () => Promise<ToolSource>,
) {
	const notes = new Map<string, string>()
	const conversations = new Map<string, Conversation>()
	const saved: Settings[] = []
	const chat = vi.fn(async (request: ChatRequest) => {
		const next = replies.shift()
		if (!next) throw new Error('no more replies')
		if (next.content) request.onText?.(next.content)
		return next
	})
	const host: NgomateHost = {
		appName: 'NGOmate',
		tasks: [],
		memory: {
			list: async () =>
				[...notes].map(([name, text]) => ({ name, updatedAt: null, chars: text.length })),
			read: async (name) => notes.get(name) ?? null,
			write: async (name, text) => void notes.set(name, text),
			remove: async (name) => void notes.delete(name),
		},
		loadSettings: async () => ({
			...DEFAULT_SETTINGS,
			model: { kind: 'server', baseUrl: 'http://x', model: 'm' },
			...settings,
		}),
		saveSettings: async (next) => void saved.push(next),
		listConversations: async () => [...conversations.values()],
		readConversation: async (id) => conversations.get(id) ?? null,
		writeConversation: async (conversation) =>
			void conversations.set(conversation.id, conversation),
		removeConversation: async (id) => void conversations.delete(id),
		pickDocument: async () => null,
		saveDocument: async () => true,
		createModelClient: () => ({ chat }),
		connectAddon:
			connectAddon ??
			(async () => {
				throw new Error('no connectors here')
			}),
		getSecret: async () => null,
		setSecret: async () => {},
		deleteSecret: async () => {},
		team,
	}
	return { host, notes, saved, chat }
}

const typeAndSend = async (text: string) => {
	await userEvent.type(await screen.findByRole('textbox', { name: 'Message' }), text)
	await userEvent.click(screen.getByRole('button', { name: 'Send' }))
}

/** Settings, at the top left beside the team menu, then one of its sections. */
const openSettings = async (section: string) => {
	await userEvent.click(await screen.findByRole('button', { name: 'You and your team' }))
	await userEvent.click(await screen.findByRole('button', { name: 'Settings…' }))
	await userEvent.click(await screen.findByRole('button', { name: section }))
}
const openTeams = () => openSettings('Teams')

describe('team', () => {
	it('sets up a team in the shared folder and offers an invite that names only the folder', async () => {
		const folder = sharedFolder()
		const { host, saved } = makeHost([], folder.team)
		render(<NgomateApp host={host} />)
		await openTeams()
		await userEvent.click(screen.getByRole('button', { name: 'Set up a team' }))
		await userEvent.type(screen.getByLabelText('Your name, as the team will see it'), 'Amina')
		await userEvent.type(screen.getByLabelText("The team's name"), 'Riverside Water Group')
		await userEvent.click(screen.getByRole('button', { name: 'Choose the shared folder' }))

		expect(
			await screen.findByRole('heading', { name: 'Riverside Water Group', level: 2 }),
		).toBeTruthy()
		const team = parseTeamFile(folder.files.get('team')?.text ?? '')
		expect(team.createdBy).toBe('Amina')
		expect(team.limits.notesBytes).toBe(10_000_000)
		const link = (screen.getByDisplayValue(/^ngomate:\/\/join\?code=/) as HTMLInputElement).value
		expect(parseInvite(link)).toEqual({
			format: 1,
			team: 'Riverside Water Group',
			storage: { type: 'folder', folderName: 'Riverside' },
		})
		await waitFor(() => expect(saved.at(-1)?.yourName).toBe('Amina'))
	})

	it('joins from an invite only when the folder holds that team', async () => {
		const folder = sharedFolder()
		const { host } = makeHost([], folder.team)
		render(<NgomateApp host={host} />)
		const code = inviteCode({
			format: 1,
			team: 'Riverside',
			storage: { type: 'folder', folderName: 'Riverside' },
		})
		await openTeams()
		await userEvent.click(screen.getByRole('button', { name: 'Join a team' }))
		await userEvent.type(screen.getByLabelText('The invite you were sent, a link or a code'), code)
		await userEvent.click(screen.getByRole('button', { name: 'Read the invite' }))

		// Not synced yet: nothing is kept, and the person is told what to wait for.
		await userEvent.click(screen.getByRole('button', { name: 'Choose the folder' }))
		expect(await screen.findByText(/There is no team in that folder/)).toBeTruthy()
		expect(folder.forget).toHaveBeenCalled()

		folder.holdTeam(newTeamFile('Riverside', 'Amina'))
		await userEvent.click(screen.getByRole('button', { name: 'Choose the folder' }))
		expect(await screen.findByRole('heading', { name: 'Riverside', level: 2 })).toBeTruthy()
	})

	it('opens the join form from an invite link the app was opened with, and waits for the person', async () => {
		const folder = sharedFolder()
		const listeners: ((link: string) => void)[] = []
		const team = {
			...folder.team,
			onInvite: (listener: (link: string) => void) => {
				listeners.push(listener)
				return () => {}
			},
		}
		const { host } = makeHost([], team)
		render(<NgomateApp host={host} />)
		await screen.findByRole('button', { name: 'You and your team' })
		const link = `ngomate://join?code=${inviteCode({ format: 1, team: 'Riverside', storage: { type: 'folder', folderName: 'Riverside' } })}`
		for (const listener of listeners) listener(link)
		expect(await screen.findByText('Join Riverside')).toBeTruthy()
		expect(folder.forget).not.toHaveBeenCalled()
		expect(await folder.team.location()).toBeNull()
	})

	it('sets up a team in a Nextcloud folder through Nextcloud’s own sign-in', async () => {
		const folder = sharedFolder()
		const wait = vi.fn(async () => ({
			server: 'https://cloud.example.org',
			loginName: 'amina',
			appPassword: 'app-password-1',
		}))
		const team = {
			...folder.team,
			nextcloudLogin: {
				start: async () => ({
					loginUrl: 'https://cloud.example.org/login/v2/flow/x',
					pollUrl: 'https://cloud.example.org/login/v2/poll',
					token: 't',
				}),
				wait,
			},
		}
		const { host } = makeHost([], team)
		render(<NgomateApp host={host} />)
		await openTeams()
		await userEvent.click(screen.getByRole('button', { name: 'Set up a team' }))
		await userEvent.type(screen.getByLabelText("The team's name"), 'Riverside')
		await userEvent.selectOptions(screen.getByLabelText('Where the team keeps its notes'), 'webdav')
		await userEvent.type(
			screen.getByLabelText('Your Nextcloud address'),
			'https://cloud.example.org',
		)
		await userEvent.click(screen.getByRole('button', { name: 'Sign in with Nextcloud' }))
		expect(await screen.findByText('Signed in as amina.', { exact: false })).toBeTruthy()
		await userEvent.click(screen.getByRole('button', { name: 'Use this folder' }))

		expect(await screen.findByRole('heading', { name: 'Riverside', level: 2 })).toBeTruthy()
		expect(folder.team.use).toHaveBeenCalledWith(
			{
				type: 'webdav',
				url: 'https://cloud.example.org/remote.php/dav/files/amina/NGOmate%20team',
				user: 'amina',
			},
			'app-password-1',
		)
		const link = (screen.getByDisplayValue(/^ngomate:\/\/join\?code=/) as HTMLInputElement).value
		// The server and the folder's name, never the inviter's own account.
		expect(parseInvite(link).storage).toEqual({
			type: 'nextcloud',
			server: 'https://cloud.example.org',
			folder: 'NGOmate team',
		})
		expect(link).not.toContain('amina')
	})

	it('joins a Nextcloud team at the folder as it appears in the joining person’s own files', async () => {
		const folder = sharedFolder()
		folder.holdTeam(
			newTeamFile('Riverside', 'Amina'),
			'https://cloud.example.org/remote.php/dav/files/kofi/Riverside',
		)
		const team = {
			...folder.team,
			nextcloudLogin: {
				start: async () => ({
					loginUrl: 'https://cloud.example.org/login',
					pollUrl: 'https://cloud.example.org/poll',
					token: 't',
				}),
				wait: async () => ({
					server: 'https://cloud.example.org',
					loginName: 'kofi',
					appPassword: 'app-password-2',
				}),
			},
		}
		const { host } = makeHost([], team)
		render(<NgomateApp host={host} />)
		const code = inviteCode({
			format: 1,
			team: 'Riverside',
			storage: { type: 'nextcloud', server: 'https://cloud.example.org', folder: 'Riverside' },
		})
		await openTeams()
		await userEvent.click(screen.getByRole('button', { name: 'Join a team' }))
		await userEvent.type(screen.getByLabelText('The invite you were sent, a link or a code'), code)
		await userEvent.click(screen.getByRole('button', { name: 'Read the invite' }))
		expect(
			screen.getByText(/folder “Riverside” on the Nextcloud at https:\/\/cloud\.example\.org/),
		).toBeTruthy()
		expect((screen.getByLabelText('Your Nextcloud address') as HTMLInputElement).value).toBe(
			'https://cloud.example.org',
		)
		await userEvent.click(screen.getByRole('button', { name: 'Sign in with Nextcloud' }))
		await userEvent.click(await screen.findByRole('button', { name: 'Use this folder' }))
		expect(await screen.findByRole('heading', { name: 'Riverside', level: 2 })).toBeTruthy()
		expect(folder.team.use).toHaveBeenCalledWith(
			{
				type: 'webdav',
				url: 'https://cloud.example.org/remote.php/dav/files/kofi/Riverside',
				user: 'kofi',
			},
			'app-password-2',
		)
	})

	it('saves a note for the team only when the person picks that', async () => {
		const folder = sharedFolder()
		folder.holdTeam(newTeamFile('Riverside', null))
		folder.join()
		const { host, notes } = makeHost(
			[call('save_memory', { name: 'pumps', text: 'Pump 3 needs a new seal.' }), say('Saved.')],
			folder.team,
		)
		render(<NgomateApp host={host} />)
		await screen.findByRole('button', { name: 'You and your team' })
		await typeAndSend('Remember this for everyone')
		await userEvent.click(await screen.findByRole('button', { name: 'Save for the team' }))
		await screen.findByText('Saved.')
		expect(folder.files.get('notes/pumps')?.text).toBe('Pump 3 needs a new seal.')
		expect(notes.size).toBe(0)
	})

	it('reads the team notes that fit the question into the conversation', async () => {
		const folder = sharedFolder()
		folder.holdTeam(newTeamFile('Riverside', null))
		folder.put('notes/boreholes', 'Borehole repairs cost about 400 euros.')
		folder.join()
		const { host, chat } = makeHost([say('About 400 euros.')], folder.team)
		render(<NgomateApp host={host} />)
		await screen.findByRole('button', { name: 'You and your team' })
		await typeAndSend('What does a borehole repair cost?')
		await screen.findByText('About 400 euros.')
		const sent = JSON.stringify(chat.mock.calls[0]?.[0].messages)
		expect(sent).toContain('team/boreholes (team note)')
	})

	it('shows a team task’s text before it runs for the first time after a change', async () => {
		const folder = sharedFolder()
		folder.holdTeam(newTeamFile('Riverside', null))
		const task =
			'---\nid: x\ntitle: Weekly update\ndescription: Writes it.\nask: What happened?\n---\nWrite a short update.'
		folder.put('tasks/weekly', task)
		folder.join()
		const { host, saved } = makeHost([], folder.team)
		render(<NgomateApp host={host} />)
		await userEvent.click(await screen.findByRole('button', { name: /Weekly update/ }))
		expect(await screen.findByText(/This task comes from your team/)).toBeTruthy()
		expect(screen.getByText(/Write a short update\./)).toBeTruthy()
		await userEvent.click(screen.getByRole('button', { name: 'Run it' }))
		await waitFor(() =>
			expect(
				Object.keys(saved.at(-1)?.teamTasksSeen ?? {}).some((key) => key.endsWith('/team:weekly')),
			).toBe(true),
		)
	})

	it('keeps a team with a connector that holds one, and saves team notes there', async () => {
		const connector = teamConnector(newTeamFile('Riverside', 'Amina'))
		const folder = sharedFolder()
		const { host, chat } = makeHost(
			[call('save_memory', { name: 'pumps', text: 'Seal on pump 3.' }), say('Saved.')],
			folder.team,
			{ addons: [trackerAddon] },
			async () => connector.source,
		)
		render(<NgomateApp host={host} />)
		await openTeams()
		await userEvent.click(screen.getByRole('button', { name: 'Set up a team' }))
		await userEvent.type(screen.getByLabelText("The team's name"), 'Riverside')
		await userEvent.selectOptions(
			screen.getByLabelText('Where the team keeps its notes'),
			'connector',
		)
		await userEvent.click(await screen.findByRole('button', { name: 'Our tracker' }))
		expect(await screen.findByRole('heading', { name: 'Riverside', level: 2 })).toBeTruthy()
		expect(screen.getByText(/set by the connector's service/)).toBeTruthy()
		expect(await folder.team.location()).toEqual({ type: 'connector', addonId: 'tracker' })

		await userEvent.click(screen.getByRole('button', { name: 'New conversation' }))
		await typeAndSend('Remember this for everyone')
		await userEvent.click(await screen.findByRole('button', { name: 'Save for the team' }))
		await screen.findByText('Saved.')
		expect(connector.notes.get('notes/pumps')?.text).toBe('Seal on pump 3.')
		// Its own team tools are never offered: a team note is saved where the person picks.
		const offered = (chat.mock.calls[0]?.[0].tools ?? []).map((tool) => tool.name)
		expect(offered).toContain('save_memory')
		expect(offered).not.toContain('write_note')
	})

	it('does not offer a connector that cannot hold a team', async () => {
		const plain: ToolSource = {
			listTools: async () => [{ name: 'search', description: 's', inputSchema: {} }],
			callTool: async () => ({ text: '', isError: false }),
			close: async () => {},
		}
		const { host } = makeHost(
			[],
			sharedFolder().team,
			{ addons: [trackerAddon] },
			async () => plain,
		)
		render(<NgomateApp host={host} />)
		await openTeams()
		await userEvent.click(screen.getByRole('button', { name: 'Set up a team' }))
		await userEvent.selectOptions(
			screen.getByLabelText('Where the team keeps its notes'),
			'connector',
		)
		expect(await screen.findByText(/None of your connectors can hold a team/)).toBeTruthy()
	})

	it('sets up a team in an S3 bucket, keeping the key out of the invite', async () => {
		const folder = sharedFolder()
		const { host } = makeHost([], folder.team)
		render(<NgomateApp host={host} />)
		await openTeams()
		await userEvent.click(screen.getByRole('button', { name: 'Set up a team' }))
		await userEvent.type(screen.getByLabelText("The team's name"), 'Riverside')
		await userEvent.selectOptions(screen.getByLabelText('Where the team keeps its notes'), 's3')
		await userEvent.type(screen.getByLabelText('Endpoint'), 'https://s3.example.org')
		await userEvent.type(screen.getByLabelText('Bucket'), 'riverside')
		await userEvent.type(screen.getByLabelText('Access key ID'), 'KEYID')
		await userEvent.type(screen.getByLabelText('Secret access key'), 'very-secret')
		await userEvent.click(screen.getByRole('button', { name: 'Connect to the bucket' }))

		expect(await screen.findByRole('heading', { name: 'Riverside', level: 2 })).toBeTruthy()
		expect(folder.team.use).toHaveBeenCalledWith(
			{
				type: 's3',
				endpoint: 'https://s3.example.org',
				region: 'us-east-1',
				bucket: 'riverside',
				accessKeyId: 'KEYID',
			},
			'very-secret',
		)
		const link = (screen.getByDisplayValue(/^ngomate:\/\/join\?code=/) as HTMLInputElement).value
		expect(parseInvite(link).storage).toEqual({
			type: 's3',
			endpoint: 'https://s3.example.org',
			region: 'us-east-1',
			bucket: 'riverside',
		})
		expect(link).not.toContain('very-secret')
		expect(atob(link.split('code=')[1]?.replace(/-/g, '+').replace(/_/g, '/') ?? '')).not.toMatch(
			/KEYID|very-secret/,
		)
	})

	it('is in two teams, switches between them, and reads only the active team’s notes', async () => {
		const folder = sharedFolder()
		folder.holdTeam(newTeamFile('Riverside', null))
		folder.put('notes/boreholes', 'Borehole repairs cost about 400 euros.')
		folder.join()
		folder.pickFolder('/Shared/Coalition')
		const { host, chat } = makeHost([say('No idea.'), say('About 400 euros.')], folder.team)
		render(<NgomateApp host={host} />)

		await openTeams()
		expect(await screen.findByRole('heading', { name: 'Riverside', level: 2 })).toBeTruthy()
		await userEvent.click(screen.getByRole('button', { name: 'Join or set up another team' }))
		await userEvent.click(screen.getByRole('button', { name: 'Set up a team' }))
		await userEvent.type(screen.getByLabelText("The team's name"), 'Coalition')
		await userEvent.click(screen.getByRole('button', { name: 'Choose the shared folder' }))
		expect(await screen.findByRole('heading', { name: 'Coalition', level: 2 })).toBeTruthy()

		// The Teams page lists both: the new one active, the other one to switch to.
		expect(await screen.findByRole('button', { name: 'Switch to it' })).toBeTruthy()
		await userEvent.click(screen.getByRole('button', { name: 'New conversation' }))
		await typeAndSend('What does a borehole repair cost?')
		await screen.findByText('No idea.')
		expect(JSON.stringify(chat.mock.calls[0]?.[0].messages)).not.toContain('boreholes')

		const riverside = (await folder.team.teams()).teams.find((team) => team.name === 'Riverside')
		await openTeams()
		await userEvent.click(await screen.findByRole('button', { name: 'Switch to it' }))
		await waitFor(async () => expect((await folder.team.teams()).active).toBe(riverside?.id))
		expect(await screen.findByRole('heading', { name: 'Riverside', level: 2 })).toBeTruthy()
		await userEvent.click(screen.getByRole('button', { name: 'New conversation' }))
		await typeAndSend('What does a borehole repair cost?')
		await screen.findByText('About 400 euros.')
		expect(JSON.stringify(chat.mock.calls[1]?.[0].messages)).toContain('team/boreholes (team note)')
	})

	it('stays in the team it was in when joining another fails', async () => {
		const folder = sharedFolder()
		folder.holdTeam(newTeamFile('Riverside', null))
		folder.join()
		folder.pickFolder('/Shared/Empty')
		const { host } = makeHost([], folder.team)
		render(<NgomateApp host={host} />)
		const code = inviteCode({
			format: 1,
			team: 'Coalition',
			storage: { type: 'folder', folderName: 'Empty' },
		})
		await openTeams()
		await userEvent.click(
			await screen.findByRole('button', { name: 'Join or set up another team' }),
		)
		await userEvent.click(screen.getByRole('button', { name: 'Join a team' }))
		await userEvent.type(screen.getByLabelText('The invite you were sent, a link or a code'), code)
		await userEvent.click(screen.getByRole('button', { name: 'Read the invite' }))
		await userEvent.click(screen.getByRole('button', { name: 'Choose the folder' }))
		expect(await screen.findByText(/There is no team in that folder/)).toBeTruthy()
		expect((await folder.team.teams()).teams.map((membership) => membership.location)).toEqual([
			{ type: 'folder', path: '/Shared/Riverside' },
		])
		await userEvent.click(screen.getByRole('button', { name: 'Back to Riverside' }))
		expect(await screen.findByRole('heading', { name: 'Riverside', level: 2 })).toBeTruthy()
	})

	it('keeps a team it is already in when an invite for another team points at its folder', async () => {
		const folder = sharedFolder()
		folder.holdTeam(newTeamFile('Riverside', null))
		folder.join()
		const { host } = makeHost([], folder.team)
		render(<NgomateApp host={host} />)
		const code = inviteCode({
			format: 1,
			team: 'Coalition',
			storage: { type: 'folder', folderName: 'Riverside' },
		})
		await openTeams()
		await userEvent.click(
			await screen.findByRole('button', { name: 'Join or set up another team' }),
		)
		await userEvent.click(screen.getByRole('button', { name: 'Join a team' }))
		await userEvent.type(screen.getByLabelText('The invite you were sent, a link or a code'), code)
		await userEvent.click(screen.getByRole('button', { name: 'Read the invite' }))
		await userEvent.click(screen.getByRole('button', { name: 'Choose the folder' }))
		expect(await screen.findByText(/holds the team Riverside, not Coalition/)).toBeTruthy()
		expect((await folder.team.teams()).teams).toHaveLength(1)
		expect(folder.forget).not.toHaveBeenCalled()
	})

	it('warns when the storage lets the last save win', async () => {
		const folder = sharedFolder()
		folder.holdTeam(newTeamFile('Riverside', null))
		folder.join()
		const team = {
			...folder.team,
			teams: async () => {
				const listed = await folder.team.teams()
				return {
					...listed,
					teams: listed.teams.map((membership) => ({ ...membership, refusesOverwrites: false })),
				}
			},
		}
		const { host } = makeHost([], team)
		render(<NgomateApp host={host} />)
		await openTeams()
		expect(await screen.findByText(/the last save wins without a warning/)).toBeTruthy()
	})

	it('suggests the team’s connectors under Connectors, for each person to sign in to', async () => {
		const folder = sharedFolder()
		folder.holdTeam({
			...newTeamFile('Riverside', null),
			connectors: [{ name: 'Our tracker', url: 'https://tracker.example.org/mcp' }],
		})
		folder.join()
		const { host } = makeHost([], folder.team)
		render(<NgomateApp host={host} />)
		await openSettings('Connectors')
		expect(await screen.findByText('Our tracker')).toBeTruthy()
		expect(screen.getByText(/Your team suggests this\./)).toBeTruthy()
	})
})

describe('the menu bar', () => {
	function withMenu(team: TeamHost, overrides: Partial<NgomateHost> = {}) {
		const listeners: ((command: MenuCommand) => void)[] = []
		const update = vi.fn()
		const made = makeHost([], team)
		const host: NgomateHost = {
			...made.host,
			...overrides,
			menu: {
				onCommand: (listener) => {
					listeners.push(listener)
					return () => {}
				},
				update,
			},
		}
		const send = (id: string) => {
			const command = parseMenuCommand(id)
			if (command) for (const listener of listeners) act(() => listener(command))
		}
		return { host, send, update }
	}

	it('reads only the commands it knows', () => {
		expect(parseMenuCommand('new-beside')).toEqual({ type: 'new-conversation', beside: true })
		expect(parseMenuCommand('show:team')).toEqual({ type: 'show', page: 'team' })
		expect(parseMenuCommand('team:abc')).toEqual({ type: 'switch-team', id: 'abc' })
		for (const id of ['show:secrets', 'team:', 'delete-everything', '']) {
			expect(parseMenuCommand(id), id).toBeNull()
		}
	})

	it('lists the teams in the menu and switches from it', async () => {
		const folder = sharedFolder()
		folder.holdTeam(newTeamFile('Riverside', null))
		folder.join()
		folder.holdTeam(newTeamFile('Coalition', null), '/Shared/Coalition')
		folder.join('/Shared/Coalition')
		const { host, send, update } = withMenu(folder.team)
		render(<NgomateApp host={host} />)
		await waitFor(() =>
			expect(update).toHaveBeenLastCalledWith(
				expect.objectContaining({
					teams: [
						expect.objectContaining({ name: null }),
						expect.objectContaining({ name: 'Coalition' }),
					],
					canInvite: true,
					sidebarCollapsed: false,
				}),
			),
		)
		const riverside = (await folder.team.teams()).teams[0]?.id ?? ''
		send(`team:${riverside}`)
		send('show:team')
		expect(await screen.findByRole('heading', { name: 'Riverside', level: 2 })).toBeTruthy()
		await waitFor(() =>
			expect(update).toHaveBeenLastCalledWith(expect.objectContaining({ activeId: riverside })),
		)
	})

	it('opens settings, a new conversation, another team and the invite from the menu', async () => {
		const folder = sharedFolder()
		folder.holdTeam(newTeamFile('Riverside', null))
		folder.join()
		const writeText = vi.fn(async () => {})
		Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
		const { host, send } = withMenu(folder.team)
		render(<NgomateApp host={host} />)
		await screen.findByRole('button', { name: 'You and your team' })

		send('show:model')
		expect(await screen.findByRole('heading', { name: 'Model', level: 2 })).toBeTruthy()
		send('copy-invite')
		await waitFor(() =>
			expect(writeText).toHaveBeenCalledWith(expect.stringMatching(/^ngomate:\/\/join\?code=/)),
		)
		expect(await screen.findByRole('button', { name: 'Link copied' })).toBeTruthy()
		send('add-team')
		expect(await screen.findByRole('heading', { name: 'Another team', level: 2 })).toBeTruthy()
		send('new-conversation')
		expect(await screen.findByRole('textbox', { name: 'Message' })).toBeTruthy()
	})

	it('says so when asked to check for updates and nothing is newer', async () => {
		const { host, send } = withMenu(sharedFolder().team, { checkForUpdate: async () => null })
		render(<NgomateApp host={host} />)
		await screen.findByRole('button', { name: 'You and your team' })
		expect(screen.queryByText('You have the newest version.')).toBeNull()
		send('check-updates')
		expect(await screen.findByText('You have the newest version.')).toBeTruthy()
	})

	it('attaches a document to the conversation in front', async () => {
		const pickDocument = vi.fn(async () => ({
			name: 'report.txt',
			text: 'Our report.',
			truncated: false,
		}))
		const { host, send } = withMenu(sharedFolder().team, { pickDocument })
		render(<NgomateApp host={host} />)
		await screen.findByRole('textbox', { name: 'Message' })
		send('attach')
		expect(await screen.findByText(/report\.txt/)).toBeTruthy()
		expect(pickDocument).toHaveBeenCalledTimes(1)
	})
})

describe('the head of the sidebar', () => {
	it('keeps the app’s name at the top, and teams out of the sidebar', async () => {
		const { host } = makeHost([], sharedFolder().team)
		render(<NgomateApp host={host} />)
		expect((await screen.findByRole('heading', { level: 1 })).textContent).toBe('NGOmate')
		expect(screen.queryByRole('combobox')).toBeNull()
	})

	it('keeps Memory at the bottom and everything set up once behind Settings', async () => {
		const { host, saved } = makeHost([], sharedFolder().team, {}, undefined)
		render(<NgomateApp host={{ ...host, checkForUpdate: async () => null }} />)
		await userEvent.click(await screen.findByRole('button', { name: 'Memory' }))
		expect(await screen.findByRole('heading', { name: 'Memory', level: 2 })).toBeTruthy()

		await openSettings('You')
		await userEvent.type(screen.getByLabelText('Your name, as your teams see it'), 'Amina')
		await userEvent.click(screen.getByRole('button', { name: 'Save' }))
		await waitFor(() => expect(saved.at(-1)?.yourName).toBe('Amina'))
		expect(
			screen
				.getAllByRole('button')
				.filter((button) => button.closest('nav'))
				.map((button) => button.textContent),
		).toEqual(['You', 'Model', 'Connectors', 'Teams', 'About'])

		await userEvent.click(screen.getByRole('button', { name: 'About' }))
		await userEvent.click(screen.getByRole('button', { name: 'Check for updates' }))
		expect(await screen.findByText('You have the newest version.')).toBeTruthy()
	})
})

describe('the avatar', () => {
	it('shows who you are and the model, and switches teams without opening Settings', async () => {
		const folder = sharedFolder()
		folder.holdTeam(newTeamFile('Riverside', null))
		folder.join()
		folder.holdTeam(newTeamFile('Coalition', null), '/Shared/Coalition')
		folder.join('/Shared/Coalition')
		const writeText = vi.fn(async () => {})
		Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
		const { host } = makeHost([], folder.team, { yourName: 'Amina Okafor' })
		render(<NgomateApp host={host} />)
		const avatar = await screen.findByRole('button', { name: 'You and your team' })
		expect(avatar.textContent).toBe('AO')
		await userEvent.click(avatar)
		expect(screen.getByText('Amina Okafor')).toBeTruthy()
		expect(screen.getByText('m · your model server')).toBeTruthy()
		const active = await screen.findByRole('button', { name: 'Coalition' })
		expect(active.getAttribute('aria-current')).toBe('true')

		await userEvent.click(screen.getByRole('button', { name: 'Copy invite link' }))
		await waitFor(() =>
			expect(writeText).toHaveBeenCalledWith(expect.stringMatching(/^ngomate:\/\/join\?code=/)),
		)
		expect(await screen.findByRole('button', { name: 'Invite link copied' })).toBeTruthy()

		// The other team's name is read once it is switched to.
		const riverside = (await folder.team.teams()).teams[0]?.id
		await userEvent.click(screen.getByRole('button', { name: 'A team not read yet' }))
		await waitFor(async () => expect((await folder.team.teams()).active).toBe(riverside))
		// It closes, and nothing else changed: still on the conversation.
		expect(screen.queryByRole('button', { name: 'Copy invite link' })).toBeNull()
		expect(screen.queryByRole('heading', { level: 2, name: 'Teams' })).toBeNull()
	})

	it('closes on Escape and gives focus back to the avatar', async () => {
		const { host } = makeHost([], sharedFolder().team)
		render(<NgomateApp host={host} />)
		const avatar = await screen.findByRole('button', { name: 'You and your team' })
		expect(avatar.textContent).toBe('')
		await userEvent.click(avatar)
		expect(screen.getByText('No team, just me')).toBeTruthy()
		expect(document.activeElement?.textContent).toBe('Add your name')
		await userEvent.keyboard('{ArrowDown}')
		expect(document.activeElement?.textContent).toBe('Set up or join a team…')
		await userEvent.keyboard('{Escape}')
		expect(screen.queryByText('No team, just me')).toBeNull()
		expect(document.activeElement).toBe(avatar)
	})
})

describe('the sidebar', () => {
	it('folds to a strip of icons and back, and remembers it', async () => {
		const { host, saved } = makeHost([], sharedFolder().team)
		render(<NgomateApp host={host} />)
		await userEvent.click(await screen.findByRole('button', { name: 'Hide the sidebar' }))
		await waitFor(() => expect(saved.at(-1)?.sidebarCollapsed).toBe(true))
		expect(screen.queryByRole('button', { name: 'New conversation', hidden: false })).toBeTruthy()
		expect(screen.queryByRole('heading', { level: 1 })).toBeNull()
		await userEvent.click(screen.getByRole('button', { name: 'Show the sidebar' }))
		expect(await screen.findByRole('heading', { level: 1 })).toBeTruthy()
		await waitFor(() => expect(saved.at(-1)?.sidebarCollapsed).toBe(false))
	})

	it('folds a section away and remembers which', async () => {
		const { host, saved } = makeHost([], sharedFolder().team)
		render(<NgomateApp host={host} />)
		const tasks = await screen.findByRole('button', { name: 'Ready-made tasks' })
		expect(tasks.getAttribute('aria-expanded')).toBe('true')
		await userEvent.click(tasks)
		await waitFor(() => expect(saved.at(-1)?.foldedSections).toEqual(['tasks']))
		expect(
			screen.getByRole('button', { name: 'Ready-made tasks' }).getAttribute('aria-expanded'),
		).toBe('false')
	})

	it('keeps an update notice, unchecked again, while it folds', async () => {
		const { host } = makeHost([], sharedFolder().team)
		let checks = 0
		render(
			<NgomateApp
				host={{
					...host,
					checkForUpdate: async () => {
						checks++
						return { version: '9.9.9', notes: null, install: async () => {} }
					},
				}}
			/>,
		)
		expect(await screen.findByText(/9\.9\.9 is ready/)).toBeTruthy()
		await userEvent.click(screen.getByRole('button', { name: 'Hide the sidebar' }))
		expect(await screen.findByText(/9\.9\.9 is ready/)).toBeTruthy()
		expect(checks).toBe(1)
	})
})
