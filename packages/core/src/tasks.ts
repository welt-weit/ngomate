import type { TaskProfile } from './agent.js'

/**
 * A ready-made task as a file: `key: value` lines between `---` lines, then the instructions. Plain
 * text, so a task can be read and changed without touching code.
 */
export type TaskFile = {
	id: string
	title: string
	description: string
	/** What the person is asked for before the task runs. */
	ask: string
	/** Tools the task may use: `none`, `all`, or a comma-separated list. */
	tools: 'none' | 'all' | string[]
	/** `addon`: the task cannot work without a connector, so the host says so instead of asking the model. */
	needs?: 'addon'
	instructions: string
}

export function parseTaskFile(source: string): TaskFile {
	const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/)
	if (!match) throw new Error('A task file starts with a block between two --- lines')
	const fields = new Map<string, string>()
	for (const line of (match[1] as string).split(/\r?\n/)) {
		const at = line.indexOf(':')
		if (at > 0) fields.set(line.slice(0, at).trim(), line.slice(at + 1).trim())
	}
	const required = (key: string) => {
		const value = fields.get(key)
		if (!value) throw new Error(`A task file needs ${key}`)
		return value
	}
	const tools = fields.get('tools') ?? 'none'
	const instructions = (match[2] as string).trim()
	if (!instructions) throw new Error('A task file needs instructions')
	return {
		id: required('id'),
		title: required('title'),
		description: required('description'),
		ask: required('ask'),
		tools:
			tools === 'none' || tools === 'all'
				? tools
				: tools
						.split(',')
						.map((name) => name.trim())
						.filter(Boolean),
		...(fields.get('needs') === 'addon' ? { needs: 'addon' as const } : {}),
		instructions,
	}
}

/** Named tools count as reads: a write has to be offered by a source that marks it otherwise. */
export function taskFileToProfile(task: TaskFile): TaskProfile {
	return {
		id: task.id,
		instructions: task.instructions,
		readTools: Array.isArray(task.tools) ? task.tools : [],
		writeTools: [],
		allTools: task.tools === 'all',
		toolHint: `${task.title}. ${task.description}`,
		instructionsInRequest: true,
	}
}
