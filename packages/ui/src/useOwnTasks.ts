import { type TaskFile, parseTaskFile, serializeTaskFile } from '@ngomate/core'
import { useCallback, useEffect, useState } from 'react'
import type { NgomateHost } from './host.js'

/** A task this person made is known by this prefix, apart from built-in and team tasks of one name. */
export const OWN_TASK_PREFIX = 'mine:'

export const isOwnTask = (id: string) => id.startsWith(OWN_TASK_PREFIX)

export type OwnTasks = {
	/** False when the host keeps no tasks of the person's own. */
	available: boolean
	tasks: TaskFile[]
	/** Files in the tasks folder that could not be read, by name. */
	broken: string[]
	/** The ids of every file there is, unreadable ones included, read now rather than from the list. */
	takenIds(): Promise<string[]>
	/** Saves a task under its id, over the one there. The id is the file's, without the prefix. */
	save(task: TaskFile): Promise<void>
	remove(id: string): Promise<void>
}

/** The tasks a person made, kept by the host as Markdown files like the built-in ones. */
export function useOwnTasks(host: NgomateHost): OwnTasks {
	const store = host.ownTasks
	const [tasks, setTasks] = useState<TaskFile[]>([])
	const [broken, setBroken] = useState<string[]>([])

	const reload = useCallback(async () => {
		if (!store) return
		const found: TaskFile[] = []
		const bad: string[] = []
		for (const entry of await store.list()) {
			try {
				found.push({ ...parseTaskFile(entry.text), id: `${OWN_TASK_PREFIX}${entry.id}` })
			} catch {
				bad.push(entry.id)
			}
		}
		setTasks(found.sort((a, b) => a.title.localeCompare(b.title)))
		setBroken(bad)
	}, [store])

	useEffect(() => {
		reload().catch((err) => console.error('Your tasks could not be read:', err))
	}, [reload])

	return {
		available: Boolean(store),
		tasks,
		broken,
		takenIds: async () => ((await store?.list()) ?? []).map((entry) => entry.id),
		save: async (task) => {
			if (!store) throw new Error('This app cannot keep tasks of your own.')
			await store.write(task.id, serializeTaskFile(task))
			// Saved: a list that fails to read again now must not make it look as if it was not.
			await reload().catch((err) => console.error('Your tasks could not be read:', err))
		},
		remove: async (id) => {
			if (!store) return
			await store.remove(id)
			await reload().catch((err) => console.error('Your tasks could not be read:', err))
		},
	}
}
