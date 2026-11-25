import { wordsOf } from './toolChoice.js'

/** The file at the top of a team's storage that says what the team is. */
export const TEAM_FILE = 'ngomate-team.json'
const TEAM_FORMAT = 1

/** Jobs the team shares sit beside its tasks, and count with them toward the tasks limit. */
export type TeamArea = 'notes' | 'tasks' | 'jobs' | 'job-states'

export type TeamLimits = {
	/** All team notes together. */
	notesBytes: number
	/** One team note. */
	noteBytes: number
	/** All team tasks together. */
	tasksBytes: number
}

export const DEFAULT_TEAM_LIMITS: TeamLimits = {
	notesBytes: 10_000_000,
	noteBytes: 200_000,
	tasksBytes: 1_000_000,
}

/** A connector the team suggests. An address only: a token is personal and never shared. */
export type RecommendedConnector = { name: string; url: string }

export type TeamFile = {
	format: typeof TEAM_FORMAT
	name: string
	/** The name the person who set the team up typed. Information, not a role. */
	createdBy: string | null
	limits: TeamLimits
	connectors: RecommendedConnector[]
}

export function newTeamFile(name: string, createdBy: string | null): TeamFile {
	const trimmed = name.trim()
	if (!trimmed) throw new Error('A team needs a name.')
	return {
		format: TEAM_FORMAT,
		name: trimmed.slice(0, 80),
		createdBy: createdBy?.trim().slice(0, 80) || null,
		limits: { ...DEFAULT_TEAM_LIMITS },
		connectors: [],
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function limit(value: unknown, fallback: number): number {
	return typeof value === 'number' && Number.isFinite(value) && value > 0
		? Math.floor(value)
		: fallback
}

/** A web address a connector or server may have: https, or http on this computer only. */
export function isAllowedAddress(raw: string): boolean {
	try {
		const url = new URL(raw)
		if (url.username || url.password) return false
		if (url.protocol === 'https:') return true
		return url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
	} catch {
		return false
	}
}

/**
 * Reads the team file. Anyone with access to the storage can change it, so only known fields are kept,
 * and nothing in it is ever taken as a secret or an instruction.
 */
export function parseTeamFile(text: string): TeamFile {
	let data: unknown
	try {
		data = JSON.parse(text)
	} catch {
		throw new Error('The team file is not readable.')
	}
	if (!isRecord(data)) throw new Error('The team file is not readable.')
	if (data.format !== TEAM_FORMAT) {
		throw new Error('This team was set up with a newer version of the app. Update the app first.')
	}
	const name = typeof data.name === 'string' ? data.name.trim().slice(0, 80) : ''
	if (!name) throw new Error('The team file has no team name.')
	const limits = isRecord(data.limits) ? data.limits : {}
	const connectors = Array.isArray(data.connectors) ? data.connectors : []
	return {
		format: TEAM_FORMAT,
		name,
		createdBy:
			typeof data.createdBy === 'string' && data.createdBy.trim()
				? data.createdBy.trim().slice(0, 80)
				: null,
		limits: {
			notesBytes: limit(limits.notesBytes, DEFAULT_TEAM_LIMITS.notesBytes),
			noteBytes: limit(limits.noteBytes, DEFAULT_TEAM_LIMITS.noteBytes),
			tasksBytes: limit(limits.tasksBytes, DEFAULT_TEAM_LIMITS.tasksBytes),
		},
		connectors: connectors
			.filter(isRecord)
			.map((item) => ({
				name: typeof item.name === 'string' ? item.name.trim().slice(0, 80) : '',
				url: typeof item.url === 'string' ? item.url.trim() : '',
			}))
			.filter((item) => item.name && isAllowedAddress(item.url))
			.slice(0, 20),
	}
}

export function serializeTeamFile(team: TeamFile): string {
	return `${JSON.stringify(team, null, 2)}\n`
}

/** A note or task as a team storage lists it. `version` is the storage's own marker, or a hash. */
export type TeamEntry = {
	name: string
	version: string | null
	updatedAt: string | null
	bytes: number
}

/** Someone else changed the note since it was read, so saving would overwrite their change. */
export class TeamConflict extends Error {
	constructor(
		readonly area: TeamArea,
		readonly note: string,
	) {
		super(`Someone in the team changed ${note} since it was read.`)
		this.name = 'TeamConflict'
	}
}

/**
 * Where a team keeps its notes and tasks. Every storage type implements it the same way. A write names
 * the version it replaces, null for a note that must not exist yet, and is refused with a
 * `TeamConflict` when the storage holds something else.
 */
export interface TeamStore {
	list(area: TeamArea): Promise<TeamEntry[]>
	read(area: TeamArea, name: string): Promise<{ text: string; version: string | null } | null>
	write(
		area: TeamArea,
		name: string,
		text: string,
		expected: string | null,
	): Promise<{ version: string | null }>
	remove(area: TeamArea, name: string, expected: string | null): Promise<void>
	readTeamFile(): Promise<TeamFile | null>
}

export function bytesOf(text: string): number {
	return new TextEncoder().encode(text).length
}

export function formatTeamBytes(bytes: number): string {
	if (bytes < 1_000) return `${bytes} bytes`
	if (bytes < 1_000_000) return `${Math.round(bytes / 1_000)} KB`
	return `${(bytes / 1_000_000).toFixed(1).replace(/\.0$/, '')} MB`
}

export type TeamUsage = { used: number; limit: number; nearlyFull: boolean; full: boolean }

export function teamUsage(limits: TeamLimits, area: TeamArea, entries: TeamEntry[]): TeamUsage {
	const used = entries.reduce((sum, entry) => sum + entry.bytes, 0)
	const max = area === 'notes' ? limits.notesBytes : limits.tasksBytes
	return { used, limit: max, nearlyFull: used >= max * 0.8, full: used >= max }
}

/**
 * Why saving this to the team would go over a limit, or null when it fits. Replacing a note counts
 * only the difference. A note already over a limit stays readable; only growing is refused.
 */
export function teamLimitProblem(
	limits: TeamLimits,
	area: TeamArea,
	entries: TeamEntry[],
	name: string,
	text: string,
): string | null {
	const size = bytesOf(text)
	const label = area === 'notes' ? 'Team memory' : area === 'tasks' ? 'Team tasks' : 'Team jobs'
	if (area === 'notes' && size > limits.noteBytes) {
		return `This note is ${formatTeamBytes(size)}, and a team note can be at most ${formatTeamBytes(limits.noteBytes)}. Shorten it, or split it into several notes.`
	}
	const before = entries.find((entry) => entry.name === name)?.bytes ?? 0
	const { used, limit: max } = teamUsage(limits, area, entries)
	if (size > before && used - before + size > max) {
		return `${label} is full (${formatTeamBytes(used)} of ${formatTeamBytes(max)}). Shorten or remove some, or raise the limit under Team.`
	}
	return null
}

/**
 * Saves a team task over the version it was read at (null for a new one): someone else's change
 * meanwhile is refused with `TeamConflict`. Tasks count together with team jobs toward the tasks limit.
 */
export async function saveTeamTask(
	store: TeamStore,
	limits: TeamLimits,
	name: string,
	text: string,
	expected: string | null,
): Promise<void> {
	// A connector keeps no team jobs, and refuses to list them.
	const [tasks, jobs] = await Promise.all([
		store.list('tasks'),
		store.list('jobs').catch(() => [] as TeamEntry[]),
	])
	const pooled = [...tasks, ...jobs.map((job) => ({ ...job, name: `job:${job.name}` }))]
	const problem = teamLimitProblem(limits, 'tasks', pooled, name, text)
	if (problem) throw new Error(problem)
	await store.write('tasks', name, text, expected)
}

/** Where the team's storage is. Never a password or key: an invite gets forwarded and kept in chats. */
export type InviteStorage =
	| { type: 'folder'; folderName: string }
	| { type: 'webdav'; url: string }
	/** A Nextcloud folder: each person's own address to it differs, so only the server and its name. */
	| { type: 'nextcloud'; server: string; folder: string }
	| { type: 's3'; endpoint: string; region: string; bucket: string }
	| { type: 'connector'; url: string }

export type TeamInvite = { format: typeof TEAM_FORMAT; team: string; storage: InviteStorage }

const INVITE_LINK = 'ngomate://join?code='
const MAX_INVITE_CHARS = 2_000

function toBase64Url(text: string): string {
	let binary = ''
	for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte)
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64Url(code: string): string {
	const base64 = code.replace(/-/g, '+').replace(/_/g, '/')
	const binary = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4))
	return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)))
}

export function inviteCode(invite: TeamInvite): string {
	return toBase64Url(JSON.stringify(invite))
}

export function inviteLink(invite: TeamInvite): string {
	return `${INVITE_LINK}${inviteCode(invite)}`
}

function text(value: unknown, max = 200): string {
	return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

/** Only the fields an invite may carry are kept, so a crafted invite cannot smuggle anything else in. */
function readStorage(data: Record<string, unknown>): InviteStorage {
	switch (data.type) {
		case 'folder': {
			const folderName = text(data.folderName)
			if (!folderName) break
			return { type: 'folder', folderName }
		}
		case 'webdav':
		case 'connector': {
			const url = text(data.url, 500)
			if (!isAllowedAddress(url)) break
			return { type: data.type, url }
		}
		case 'nextcloud': {
			const server = text(data.server, 500)
			const folder = text(data.folder, 300)
			if (!isAllowedAddress(server) || !folder) break
			return { type: 'nextcloud', server, folder }
		}
		case 's3': {
			const endpoint = text(data.endpoint, 500)
			const region = text(data.region, 50)
			const bucket = text(data.bucket, 63)
			if (!isAllowedAddress(endpoint) || !bucket) break
			return { type: 's3', endpoint, region, bucket }
		}
	}
	throw new Error('This invite does not say where the team keeps its notes.')
}

/** Reads an invite pasted as a link or as a code. */
export function parseInvite(raw: string): TeamInvite {
	const trimmed = raw.trim()
	const code = trimmed.startsWith(INVITE_LINK) ? trimmed.slice(INVITE_LINK.length) : trimmed
	if (!code || code.length > MAX_INVITE_CHARS || !/^[A-Za-z0-9_-]+$/.test(code)) {
		throw new Error('This is not an invite. Paste the whole link or code you were sent.')
	}
	let data: unknown
	try {
		data = JSON.parse(fromBase64Url(code))
	} catch {
		throw new Error('This is not an invite. Paste the whole link or code you were sent.')
	}
	if (!isRecord(data)) throw new Error('This is not an invite.')
	if (data.format !== TEAM_FORMAT) {
		throw new Error('This invite is from a newer version of the app. Update the app first.')
	}
	const team = text(data.team, 80)
	if (!team || !isRecord(data.storage)) throw new Error('This invite is incomplete.')
	return { format: TEAM_FORMAT, team, storage: readStorage(data.storage) }
}

/** Team notes as the memory tools and the conversation see them, with the team's limits applied. */
export type TeamNotes = {
	list(): Promise<TeamEntry[]>
	read(name: string): Promise<string | null>
	/** Replaces the note, checking it was not changed since it was last read here. */
	save(name: string, text: string): Promise<void>
	/** Deletes the note, checking the same way. */
	remove(name: string): Promise<void>
	/** Every note's text, read again only when its version changed. For choosing by relevance. */
	readAll(): Promise<{ name: string; text: string; updatedAt: string | null }[]>
}

/** How long the list of team notes is reused for the conversation: one network round trip per message
 * on S3 or WebDAV adds up on a slow line, and a note saved here clears it at once. */
const LIST_REUSE_MS = 30_000

/** Reads at once when notes are fetched: on S3 or WebDAV each one is a request, and one after another
 * a large team keeps the first answer waiting. */
export const READS_AT_ONCE = 8

/** A note as last read: the version it was read at and its text. */
export type TeamNoteCopy = { version: string; text: string }

/**
 * Copies of one team's notes the host keeps between starts, so a new start fetches only the notes whose
 * version changed. Bound to one team by the host: never handed another team's copies.
 */
export interface TeamNoteCopies {
	load(): Promise<Record<string, TeamNoteCopy>>
	save(notes: Record<string, TeamNoteCopy>): Promise<void>
}

export async function eachAtMost<T>(items: T[], width: number, run: (item: T) => Promise<unknown>) {
	let next = 0
	const worker = async () => {
		while (next < items.length) await run(items[next++] as T)
	}
	await Promise.all(Array.from({ length: Math.min(width, items.length) }, worker))
}

export function createTeamNotes(
	store: TeamStore,
	limits: () => TeamLimits,
	now: () => number = Date.now,
	copies?: TeamNoteCopies,
): TeamNotes {
	const known = new Map<string, { version: string | null; text: string }>()
	let listed: { at: number; entries: TeamEntry[] } | null = null
	let loadedCopies: Promise<void> | null = null
	let savedCopies = ''
	let reading: Promise<{ name: string; text: string; updatedAt: string | null }[]> | null = null
	const loadCopies = () => {
		loadedCopies ??= (copies?.load() ?? Promise.resolve<Record<string, TeamNoteCopy>>({})).then(
			(saved) => {
				for (const [name, copy] of Object.entries(saved)) {
					if (!known.has(name)) known.set(name, copy)
				}
				savedCopies = JSON.stringify(saved)
			},
			// Without copies, every note is fetched, as on a first start.
			() => {},
		)
		return loadedCopies
	}
	const freshList = async () => {
		const entries = await store.list('notes')
		listed = { at: now(), entries }
		return entries
	}

	const read = async (name: string) => {
		const found = await store.read('notes', name)
		if (found) known.set(name, found)
		else known.delete(name)
		return found?.text ?? null
	}

	return {
		list: freshList,
		read,
		async save(name, text) {
			const entries = await freshList()
			const problem = teamLimitProblem(limits(), 'notes', entries, name, text)
			if (problem) throw new Error(problem)
			// Read here: it must still be what was read. Never read: replacing it is what was confirmed.
			// Not there at all: it must not appear meanwhile either.
			const expected = known.has(name)
				? (known.get(name)?.version ?? null)
				: (entries.find((entry) => entry.name === name)?.version ?? null)
			const { version } = await store.write('notes', name, text, expected)
			known.set(name, { version, text })
			listed = null
		},
		async remove(name) {
			const current = (await store.list('notes')).find((entry) => entry.name === name)
			if (!current) return
			const expected = known.has(name) ? (known.get(name)?.version ?? null) : current.version
			await store.remove('notes', name, expected)
			known.delete(name)
			listed = null
		},
		readAll() {
			// One read at a time: the app starts one when the team opens, and a first message joins it.
			reading ??= (async () => {
				await loadCopies()
				const entries =
					listed && now() - listed.at < LIST_REUSE_MS ? listed.entries : await freshList()
				const fresh = (entry: TeamEntry) => {
					const copy = known.get(entry.name)
					return copy && copy.version !== null && copy.version === entry.version
				}
				const failed = new Set<string>()
				await eachAtMost(
					entries.filter((entry) => !fresh(entry)),
					READS_AT_ONCE,
					(entry) => read(entry.name).catch(() => failed.add(entry.name)),
				)
				const all: { name: string; text: string; updatedAt: string | null }[] = []
				const keep: Record<string, TeamNoteCopy> = {}
				for (const entry of entries) {
					const copy = known.get(entry.name)
					// A note that could not be read now is left out rather than shown as it was before.
					if (!copy || failed.has(entry.name)) continue
					all.push({ name: entry.name, text: copy.text, updatedAt: entry.updatedAt })
					if (copy.version !== null) keep[entry.name] = { version: copy.version, text: copy.text }
				}
				const snapshot = JSON.stringify(keep)
				if (copies && snapshot !== savedCopies) {
					await copies.save(keep).then(
						() => {
							savedCopies = snapshot
						},
						// Copies are a shortcut; without them the next start fetches every note again.
						() => {},
					)
				}
				return all
			})().finally(() => {
				reading = null
			})
			return reading
		},
	}
}

/**
 * Whether a note looks like the copy a sync app made when two people changed one at once: Dropbox and
 * Nextcloud write "conflicted copy", Syncthing ".sync-conflict-", Google Drive "[Conflict]" (reported,
 * not documented by Google), and OneDrive adds the computer's name, so "Plan-DESKTOP-AB12" counts only
 * when "Plan" is there too. A note about conflict resolution is not one.
 */
export function isConflictCopy(name: string, others: string[]): boolean {
	if (/conflicted copy|\.sync-conflict-|\[conflict\]/i.test(name)) return true
	// A computer's name can hold dashes itself, so every split is tried.
	return [...name.matchAll(/-/g)].some(({ index }) => {
		const suffix = name.slice(index + 1)
		return /^[A-Z0-9][A-Z0-9-]{2,}$/.test(suffix) && others.includes(name.slice(0, index))
	})
}

/**
 * The team notes most relevant to a question, up to `maxChars`. Words shared with the question count,
 * rare ones most; with nothing in common, the newest come first. The rest are named for the model.
 */
export function chooseTeamNotes(
	notes: { name: string; text: string; updatedAt: string | null }[],
	question: string,
	maxChars: number,
): { included: { name: string; text: string }[]; omitted: string[] } {
	const wanted = wordsOf(question)
	const inNote = notes.map((note) => wordsOf(`${note.name} ${note.text}`, false))
	const weight = new Map<string, number>()
	for (const word of wanted) {
		const found = inNote.filter((words) => words.has(word)).length
		if (found) weight.set(word, Math.log(1 + notes.length / found))
	}
	const ranked = notes
		.map((note, index) => {
			let score = 0
			for (const [word, value] of weight) if (inNote[index]?.has(word)) score += value
			return { note, score }
		})
		.sort(
			(a, b) => b.score - a.score || (b.note.updatedAt ?? '').localeCompare(a.note.updatedAt ?? ''),
		)
	const included: { name: string; text: string }[] = []
	const omitted: string[] = []
	let used = 0
	for (const { note } of ranked) {
		if (used + note.text.length <= maxChars) {
			included.push({ name: note.name, text: note.text })
			used += note.text.length
		} else {
			omitted.push(note.name)
		}
	}
	return { included, omitted }
}

/**
 * The team memory tools: what a connector offers to hold a team's notes and tasks. Published as an
 * open interface, so any server can be a team's storage. Answers are JSON in the tool's text; a write
 * that found another version answers as an error with `"code": "conflict"`.
 */
export const TEAM_TOOLS = {
	list: 'list_notes',
	read: 'read_note',
	write: 'write_note',
	remove: 'delete_note',
	team: 'get_team',
} as const

/** True when a connector offers every team memory tool, so it can hold a team. */
export function offersTeamTools(tools: { name: string }[]): boolean {
	const names = new Set(tools.map((tool) => tool.name))
	return Object.values(TEAM_TOOLS).every((name) => names.has(name))
}

type ToolCaller = {
	callTool(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }>
}

function answer(result: { text: string; isError: boolean }, area: TeamArea, name: string): unknown {
	let data: unknown = null
	try {
		data = JSON.parse(result.text)
	} catch {
		// A plain-text answer is kept as the message.
	}
	if (result.isError) {
		if (isRecord(data) && data.code === 'conflict') throw new TeamConflict(area, name)
		const said = isRecord(data) && typeof data.message === 'string' ? data.message : result.text
		throw new Error(said.slice(0, 300) || 'The team storage refused this.')
	}
	return data
}

const version = (value: unknown) => (typeof value === 'string' && value ? value : null)

/**
 * A connector's team tools hold notes and tasks only (README, "A connector as team storage"). Asked for
 * jobs, a server that ignores the area would answer with its notes, and a job removed would be a note.
 */
function onlyNotesAndTasks(area: TeamArea) {
	if (area !== 'notes' && area !== 'tasks') throw new Error('A connector does not keep team jobs.')
}

/** A team's notes and tasks kept by a connector that offers the team memory tools. */
export function createConnectorTeamStore(source: ToolCaller): TeamStore {
	return {
		async list(area) {
			onlyNotesAndTasks(area)
			const data = answer(await source.callTool(TEAM_TOOLS.list, { area }), area, '')
			const items = Array.isArray(data)
				? data
				: isRecord(data) && Array.isArray(data.notes)
					? data.notes
					: []
			return items.filter(isRecord).flatMap((item) => {
				const name = typeof item.name === 'string' ? item.name : ''
				if (!name) return []
				return [
					{
						name,
						version: version(item.version),
						updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt : null,
						bytes: typeof item.bytes === 'number' ? item.bytes : 0,
					},
				]
			})
		},
		async read(area, name) {
			onlyNotesAndTasks(area)
			const result = await source.callTool(TEAM_TOOLS.read, { area, name })
			if (result.isError) {
				try {
					if ((JSON.parse(result.text) as { code?: string }).code === 'not_found') return null
				} catch {}
			}
			const data = answer(result, area, name)
			if (!isRecord(data) || typeof data.text !== 'string') return null
			return { text: data.text, version: version(data.version) }
		},
		async write(area, name, text, expected) {
			onlyNotesAndTasks(area)
			const data = answer(
				await source.callTool(TEAM_TOOLS.write, { area, name, text, expectedVersion: expected }),
				area,
				name,
			)
			return { version: isRecord(data) ? version(data.version) : null }
		},
		async remove(area, name, expected) {
			onlyNotesAndTasks(area)
			answer(
				await source.callTool(TEAM_TOOLS.remove, { area, name, expectedVersion: expected }),
				area,
				name,
			)
		},
		async readTeamFile() {
			const result = await source.callTool(TEAM_TOOLS.team, {})
			if (result.isError) return null
			return parseTeamFile(result.text)
		},
	}
}
