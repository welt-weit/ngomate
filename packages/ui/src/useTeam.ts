import {
	DEFAULT_TEAM_LIMITS,
	type TaskFile,
	type TeamFile,
	type TeamNotes,
	type TeamStore,
	createConnectorTeamStore,
	createTeamNotes,
	parseTaskFile,
} from '@ngomate/core'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Addon, NgomateHost, TeamLocation, TeamMembership } from './host.js'

/** A ready-made task from the team's storage, with the version it was read at. */
export type TeamTask = { task: TaskFile; version: string | null; text: string }

export type Team = {
	/** Every team this person is in, and which is active. */
	memberships: TeamMembership[]
	activeId: string | null
	/** The active team's file has been looked for, so its policy, if any, is known. */
	fileRead: boolean
	/** False when the active team's storage lets the last save win over someone else's change. */
	refusesOverwrites: boolean
	switchTo(id: string): Promise<void>
	location: TeamLocation | null
	file: TeamFile | null
	/** The team file's version, for changing it. */
	version: string | null
	/** False when the team's settings are kept by its service, as with a connector. */
	settingsEditable: boolean
	/** Why the team storage cannot be used right now, in words a person can act on. */
	problem: string | null
	/** The storage in use, once reachable. */
	store: TeamStore | null
	notes: TeamNotes | null
	tasks: TeamTask[]
	/** Team tasks that could not be read, by name. */
	brokenTasks: string[]
	refresh(): Promise<void>
}

const TEAM_TASK_PREFIX = 'team:'

export function isTeamTask(task: TaskFile): boolean {
	return task.id.startsWith(TEAM_TASK_PREFIX)
}

function message(err: unknown): string {
	return err instanceof Error ? err.message : String(err)
}

/**
 * The storage behind a location: the host's own, or a connector the app opens itself. A connector is
 * closed again when the location or the connector changes.
 */
function useTeamStore(host: NgomateHost, location: TeamLocation | null, addons: Addon[]) {
	const [connected, setConnected] = useState<{ store: TeamStore | null; problem: string | null }>({
		store: null,
		problem: null,
	})
	const addonId = location?.type === 'connector' ? location.addonId : null
	const addon = addonId ? addons.find((candidate) => candidate.id === addonId) : undefined
	// Settings change often (the layout is kept in them); only a change to this connector reconnects.
	const addonRef = useRef(addon)
	addonRef.current = addon
	const addonKey = addon ? JSON.stringify(addon.connection) : null

	useEffect(() => {
		const addon = addonRef.current
		if (!addonId) return
		if (!addon || !addonKey) {
			setConnected({
				store: null,
				problem:
					'The connector this team uses is no longer under Connectors. Connect it again, or leave the team.',
			})
			return
		}
		let closed = false
		let close: (() => Promise<void>) | null = null
		host
			.connectAddon(addon)
			.then((source) => {
				close = () => source.close()
				if (closed) return close()
				setConnected({ store: createConnectorTeamStore(source), problem: null })
			})
			.catch((err) =>
				setConnected({
					store: null,
					problem: `The team's connector cannot be reached: ${message(err)}`,
				}),
			)
		return () => {
			closed = true
			close?.()
			setConnected({ store: null, problem: null })
		}
	}, [host, addonId, addonKey])

	if (!location || !host.team) return { store: null, problem: null }
	if (location.type !== 'connector') return { store: host.team.store, problem: null }
	return connected
}

/** The team the host is set up for, read again on `refresh`. */
export function useTeam(host: NgomateHost, addons: Addon[] = []): Team {
	const [memberships, setMemberships] = useState<TeamMembership[]>([])
	const [activeId, setActiveId] = useState<string | null>(null)
	const [location, setLocation] = useState<TeamLocation | null>(null)
	const [file, setFile] = useState<TeamFile | null>(null)
	// The team whose file was last looked for, found or not: until then its policy is not known yet.
	const [readFor, setReadFor] = useState<string | null | undefined>(undefined)
	const [version, setVersion] = useState<string | null>(null)
	const [problem, setProblem] = useState<string | null>(null)
	const [tasks, setTasks] = useState<TeamTask[]>([])
	const [brokenTasks, setBrokenTasks] = useState<string[]>([])
	const limits = useRef(DEFAULT_TEAM_LIMITS)
	limits.current = file?.limits ?? DEFAULT_TEAM_LIMITS
	const { store, problem: storeProblem } = useTeamStore(host, location, addons)
	const isConnector = location?.type === 'connector'

	// A refresh still under way when the team changes must not overwrite what the newer one found.
	const generation = useRef(0)

	const refresh = useCallback(async () => {
		const mine = ++generation.current
		const current = () => mine === generation.current
		const reset = () => {
			setFile(null)
			setVersion(null)
			setTasks([])
			setBrokenTasks([])
		}
		if (!host.team) return
		const listed = await host.team.teams().catch(() => ({ active: null, teams: [] }))
		if (!current()) return
		setMemberships(listed.teams)
		setActiveId(listed.active)
		const active = listed.teams.find((membership) => membership.id === listed.active)
		const where = active?.location ?? null
		setLocation((before) => (JSON.stringify(before) === JSON.stringify(where) ? before : where))
		if (!where) {
			reset()
			setProblem(null)
			setReadFor(listed.active)
			return
		}
		if (!store) {
			reset()
			return
		}
		try {
			const read = isConnector
				? await store.readTeamFile().then((team) => (team ? { team, version: null } : null))
				: await host.team.readTeamFile()
			if (!current()) return
			if (!read) {
				reset()
				setProblem(
					isConnector
						? 'The connector has no team set up for your account.'
						: 'There is no team here. If it was just shared with you, wait for your sync app to finish.',
				)
				return
			}
			setFile(read.team)
			setVersion(read.version)
			// For the switcher, which must name teams it cannot reach right now.
			if (active && active.name !== read.team.name) {
				const name = read.team.name
				setMemberships((all) =>
					all.map((membership) =>
						membership.id === active.id ? { ...membership, name } : membership,
					),
				)
				host.team.label(name).catch(() => {})
			}
			setProblem(null)
			const found: TeamTask[] = []
			const broken: string[] = []
			for (const entry of await store.list('tasks')) {
				const task = await store.read('tasks', entry.name).catch(() => null)
				if (!task) continue
				try {
					found.push({
						task: { ...parseTaskFile(task.text), id: `${TEAM_TASK_PREFIX}${entry.name}` },
						version: task.version,
						text: task.text,
					})
				} catch {
					broken.push(entry.name)
				}
			}
			if (!current()) return
			setTasks(found)
			setBrokenTasks(broken)
		} catch (err) {
			if (current()) setProblem(message(err))
		} finally {
			if (current()) setReadFor(listed.active)
		}
	}, [host, store, isConnector])

	useEffect(() => {
		refresh()
	}, [refresh])

	const usable = Boolean(store && file && !problem && !storeProblem)
	// One per team: two teams in folders, S3 or WebDAV share the host's store, and what one team's
	// notes said must never be read as another's.
	// biome-ignore lint/correctness/useExhaustiveDependencies: a new team gets new notes
	const notes = useMemo(
		() =>
			store && usable
				? createTeamNotes(
						store,
						() => limits.current,
						undefined,
						activeId ? host.team?.noteCopies?.(activeId) : undefined,
					)
				: null,
		[store, usable, activeId],
	)

	// Fetched when the team opens rather than when the first question is sent, which then joins it.
	useEffect(() => {
		notes?.readAll().catch(() => {})
	}, [notes])

	const switchTo = useCallback(
		async (id: string) => {
			await host.team?.switchTo(id)
			await refresh()
		},
		[host, refresh],
	)

	return {
		memberships,
		activeId,
		fileRead: readFor !== undefined && readFor === activeId,
		refusesOverwrites:
			memberships.find((membership) => membership.id === activeId)?.refusesOverwrites ?? true,
		switchTo,
		location,
		file,
		version,
		settingsEditable: !isConnector,
		problem: storeProblem ?? problem,
		store: usable ? store : null,
		notes,
		tasks,
		brokenTasks,
		refresh,
	}
}
