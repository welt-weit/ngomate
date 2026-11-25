import {
	type JobFile,
	type TaskFile,
	type ToolDefinition,
	type ToolSource,
	describeSchedule,
	formatSchedule,
	jobId,
	parseSchedule,
} from '@ngomate/core'
import { noteNameProblem } from './JobDialog.js'

/**
 * A task or job being made in a chat, in the person's own words: the assistant fills it in with
 * `draft_task` or `draft_job`, the person reads it as a card above the chat and saves it there or in
 * the form. The assistant never saves anything.
 */
export type TaskDraft = {
	title?: string
	description?: string
	ask?: string
	instructions?: string
	/**
	 * `all` lets it use the person's connected tools; it gets only what they give it otherwise. A task
	 * that names its tools keeps them as they are: the assistant can only choose `none` or `all`.
	 */
	tools?: TaskFile['tools']
}

export type JobDraft = {
	title?: string
	/** A task's id, or `NEW_TASK` for the task drafted beside the job. */
	task?: string
	inputs?: string
	/** In the job file's own words, such as `weekly mon 09:00`. */
	schedule?: string
	note?: string
	writeTo?: 'my-notes' | 'team-notes'
	forTeam?: boolean
}

export type Draft = {
	kind: 'task' | 'job'
	/** The task, or for a job the new task it needs, if it needs one. */
	task: TaskDraft
	job: JobDraft
	/** When this changes something that exists: its key. */
	editing?: string
	/** For a team task being changed: its version when the change began, so a newer one is not overwritten. */
	editingVersion?: string | null
	/** Once saved: the key of what was made. */
	saved?: string
}

/** A job's task that is drafted beside it rather than one that exists. */
export const NEW_TASK = 'new'

/** What the assistant may draft from: the tasks there are, and what the open team allows. */
export type MakingContext = {
	tasks: { id: string; title: string; ask: string }[]
	/** A team is open whose notes can be written. */
	teamNotes: boolean
	/** The open team can share jobs. */
	teamJobs: boolean
}

export const emptyDraft = (kind: Draft['kind']): Draft => ({ kind, task: {}, job: {} })

export const draftToolName = (kind: Draft['kind']) => (kind === 'task' ? 'draft_task' : 'draft_job')

const TASK_PROPERTIES = {
	title: { type: 'string', description: 'A short name, such as "Funder page check".' },
	description: { type: 'string', description: 'One line on what it is for.' },
	ask: {
		type: 'string',
		description:
			'What it asks the person for before it starts, such as "The funder and its web page".',
	},
	instructions: {
		type: 'string',
		description: 'What the assistant does each time it runs, written to the assistant.',
	},
	tools: {
		type: 'string',
		enum: ['none', 'all'],
		description: 'none: only what the person gives it. all: it may use their connected tools.',
	},
}

/** Every field `draft_job` takes, whether or not the open team offers it. */
const JOB_FIELDS = {
	title: 1,
	task: 1,
	inputs: 1,
	schedule: 1,
	note: 1,
	write_to: 1,
	for_team: 1,
	new_task: 1,
}

function draftTool(kind: Draft['kind'], context: MakingContext): ToolDefinition {
	if (kind === 'task')
		return {
			name: 'draft_task',
			description:
				'Fill in the task being made, or change it. Give only the fields you know or that changed. Nothing is saved: the person reads it and saves it.',
			inputSchema: { type: 'object', properties: TASK_PROPERTIES },
			annotations: { readOnly: true },
		}
	return {
		name: 'draft_job',
		description:
			'Fill in the job being made, or change it. Give only the fields you know or that changed. Nothing is saved: the person reads it and saves it.',
		inputSchema: {
			type: 'object',
			properties: {
				title: { type: 'string', description: 'A short name, such as "Funding this week".' },
				task: {
					type: 'string',
					enum: [...context.tasks.map((task) => task.id), NEW_TASK],
					description: `The task it runs, by id. "${NEW_TASK}" when none fits and you describe one in new_task.`,
				},
				inputs: { type: 'string', description: "The answer to the task's question, given once." },
				schedule: {
					type: 'string',
					description:
						'When it runs: "daily HH:MM", "weekly mon HH:MM" (mon to sun) or "monthly D HH:MM" (D from 1 to 28), 24-hour time.',
				},
				note: {
					type: 'string',
					description: 'The note it writes to. {date} in it keeps one note per run.',
				},
				...(context.teamNotes
					? {
							write_to: {
								type: 'string',
								enum: ['my-notes', 'team-notes'],
								description: "The person's own notes, or the team's.",
							},
						}
					: {}),
				...(context.teamJobs
					? {
							for_team: {
								type: 'boolean',
								description: "True when it runs for the whole team, on any member's computer.",
							},
						}
					: {}),
				new_task: {
					type: 'object',
					properties: TASK_PROPERTIES,
					description: `The task to make with it, when task is "${NEW_TASK}".`,
				},
			},
		},
		annotations: { readOnly: true },
	}
}

/** A text field from the model: trimmed, bounded, and left out when empty. */
const text = (value: unknown, max: number) =>
	typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : undefined

function readTask(args: Record<string, unknown>, before: TaskDraft, problems: string[]): TaskDraft {
	let tools: TaskDraft['tools'] =
		args.tools === 'none' || args.tools === 'all' ? args.tools : undefined
	if (args.tools !== undefined && tools === undefined) problems.push('tools is "none" or "all".')
	// A task that names its tools keeps them: only the person changes that, in the form.
	if (tools && Array.isArray(before.tools)) {
		problems.push('This task names its own tools; they stay as they are.')
		tools = undefined
	}
	for (const key of Object.keys(args))
		if (!(key in TASK_PROPERTIES)) problems.push(`A task has no field ${key}.`)
	return {
		...before,
		...strip({
			title: text(args.title, 80),
			description: text(args.description, 200),
			ask: text(args.ask, 200),
			instructions: text(args.instructions, 6000),
			tools,
		}),
	}
}

const strip = <T extends Record<string, unknown>>(record: T): Partial<T> =>
	Object.fromEntries(
		Object.entries(record).filter(([, value]) => value !== undefined),
	) as Partial<T>

/**
 * A draft with what the model sent merged in, and what in it could not be taken. A field that does not
 * pass is left as it was, never guessed, so a weak model cannot make a broken item.
 */
export function applyDraftCall(
	draft: Draft,
	args: Record<string, unknown>,
	context: MakingContext,
): { draft: Draft; problems: string[] } {
	const problems: string[] = []
	// What a small model sends wrongly is said back to it, so it can send it again the right way.
	for (const [key, value] of Object.entries(args)) {
		if (
			value !== undefined &&
			value !== null &&
			!(key in (draft.kind === 'task' ? TASK_PROPERTIES : JOB_FIELDS))
		)
			problems.push(
				draft.kind === 'job' && key in TASK_PROPERTIES
					? `${key} belongs inside new_task.`
					: `There is no field ${key}.`,
			)
	}
	if (draft.kind === 'task')
		return { draft: { ...draft, task: readTask(args, draft.task, problems) }, problems }
	const job: JobDraft = { ...draft.job }
	const title = text(args.title, 80)
	if (title) job.title = title
	const inputs = text(args.inputs, 4000)
	if (inputs) job.inputs = inputs
	if (typeof args.task === 'string') {
		if (args.task === NEW_TASK || context.tasks.some((task) => task.id === args.task))
			job.task = args.task
		else problems.push(`There is no task "${args.task}".`)
	}
	const schedule = text(args.schedule, 40)
	if (schedule) {
		try {
			// A small model writes "Weekly Monday 9:00" as often as the file's own form.
			const plain = schedule
				.toLowerCase()
				.replace(/^(weekly\s+)(mon|tue|wed|thu|fri|sat|sun)[a-z]*/, '$1$2')
				.replace(/(^|\s)(\d):(\d\d)$/, '$10$2:$3')
			job.schedule = formatSchedule(parseSchedule(plain))
		} catch {
			problems.push(
				`"${schedule}" is not a schedule. Write daily 09:00, weekly mon 09:00 or monthly 1 09:00.`,
			)
		}
	}
	const note = text(args.note, 200)
	if (note) {
		const problem = noteNameProblem(note)
		if (problem) problems.push(problem)
		else job.note = note
	}
	if (args.write_to !== undefined) {
		if (!context.teamNotes) problems.push('write_to is not available: no team is open.')
		else if (args.write_to === 'my-notes' || args.write_to === 'team-notes')
			job.writeTo = args.write_to
		else problems.push('write_to is "my-notes" or "team-notes".')
	}
	if (args.for_team !== undefined) {
		if (!context.teamJobs)
			problems.push('for_team is not available: the open team cannot share jobs.')
		else if (typeof args.for_team === 'boolean') job.forTeam = args.for_team
		else problems.push('for_team is true or false.')
	}
	// Sent as text by some models, as an object by most.
	let given: unknown = args.new_task
	if (typeof given === 'string') {
		try {
			given = JSON.parse(given)
		} catch {
			problems.push('new_task must be an object with title, description, ask and instructions.')
		}
	}
	const newTask =
		given && typeof given === 'object' && !Array.isArray(given)
			? readTask(given as Record<string, unknown>, draft.task, problems)
			: draft.task
	return { draft: { ...draft, job, task: newTask }, problems }
}

const TASK_LABELS: [keyof TaskDraft, string][] = [
	['title', 'a name'],
	['description', 'what it is for'],
	['ask', 'what it asks for'],
	['instructions', 'what it should do'],
]

/** What the draft still lacks before it can be saved, in words. */
export function missingFromDraft(draft: Draft): string[] {
	const task = (prefix: string) =>
		TASK_LABELS.filter(([key]) => !draft.task[key]).map(([, label]) => `${prefix}${label}`)
	if (draft.kind === 'task') return task('')
	const missing = [
		...(!draft.job.task ? ['which task it runs'] : []),
		...(!draft.job.inputs ? ['what the task needs'] : []),
		...(!draft.job.schedule ? ['when it runs'] : []),
	]
	if (draft.job.task === NEW_TASK) missing.push(...task('the new task: '))
	return missing
}

/** The draft as the model is told it, so each turn starts from what is there. */
function draftForModel(draft: Draft): string {
	return JSON.stringify(draft.kind === 'task' ? draft.task : { ...draft.job, new_task: draft.task })
}

/** What the assistant is told in a chat where something is being made. Short, for a small model. */
export function makingInstructions(draft: Draft, context: MakingContext): string {
	const tool = draftToolName(draft.kind)
	const save = draft.editing ? 'Save the changes' : 'Make it'
	// Nothing drafted yet: the first call is the whole draft.
	const empty = Object.keys(draft.kind === 'task' ? draft.task : draft.job).length === 0
	const missing = missingFromDraft(draft)
	// A small model asks before it drafts unless told otherwise; people would rather see a draft and
	// change it than answer questions first. So it drafts at once, and asks only what it cannot propose.
	const task = [
		'Help the person make a ready-made task: instructions the assistant follows each time it is run, and what it asks the person for first.',
		`${empty ? 'Right away, before anything else, call' : 'Call'} ${tool} with a complete draft made from what they said: a short name, one line on what it is for, what it asks the person for each time it runs, and the instructions, written to the assistant as clear steps. Propose all of it yourself: do not ask first. Leave tools out unless they ask for connected tools.`,
		'Then say in one or two short sentences what it does, and ask whether to change anything.',
		`Whenever they ask for a change, call ${tool} again with the fields that change.`,
	]
	const job = [
		'Help the person make a job: a ready-made task that runs on a schedule while the app is open and writes its result to a note.',
		`${empty ? 'Right away, before anything else, call' : 'Call'} ${tool} with what you can propose from what they said: a short title, the task that fits best from the list below, and the note it writes to. If no task fits, set task to "${NEW_TASK}" and write a complete new_task yourself.`,
		'Never invent when it runs or what the task is given: if they have not said, ask for those, one short question at a time, after drafting.',
		`Whenever they ask for a change, call ${tool} again with the fields that change.`,
		context.tasks.length
			? `Tasks there are: ${context.tasks.map((each) => `${each.id} (${each.title}; asks for: ${each.ask})`).join('; ')}.`
			: `There are no tasks yet, so set task to "${NEW_TASK}" and write one in new_task.`,
	]
	return [
		...(draft.kind === 'task' ? task : job),
		empty
			? ''
			: missing.length
				? `Still missing: ${missing.join(', ')}.`
				: `It is complete: they can save it with ${save}, or change anything first.`,
		'You never save anything. Do not say it is saved.',
		`The draft now: ${draftForModel(draft)}`,
	]
		.filter(Boolean)
		.join('\n')
}

/** The one tool a making chat has: it changes the draft and says what is still missing. */
export function draftToolSource(
	context: MakingContext,
	current: () => Draft,
	onDraft: (draft: Draft) => void,
): ToolSource {
	return {
		listTools: async () => [draftTool(current().kind, context)],
		async callTool(name, args) {
			if (name !== draftToolName(current().kind))
				return { text: `There is no tool ${name}.`, isError: true }
			const { draft, problems } = applyDraftCall(current(), args, context)
			onDraft(draft)
			const missing = missingFromDraft(draft)
			return {
				text: [
					'The person sees the draft above the chat.',
					problems.length ? `Not taken: ${problems.join(' ')}` : '',
					missing.length
						? `Still missing: ${missing.join(', ')}.`
						: 'It is complete and can be saved with Make it.',
				]
					.filter(Boolean)
					.join(' '),
				isError: false,
			}
		},
		close: async () => {},
	}
}

/** The task a complete draft makes, under an id not yet taken. */
export function taskFromDraft(draft: TaskDraft, id: string): TaskFile {
	return {
		id,
		title: draft.title ?? '',
		description: draft.description ?? '',
		ask: draft.ask ?? '',
		tools: draft.tools ?? 'none',
		...(draft.tools === 'all' ? { needs: 'addon' as const } : {}),
		instructions: draft.instructions ?? '',
	}
}

/** The job a complete draft makes. `taskId` is the task it runs, the new one once saved. */
export function jobFromDraft(
	draft: JobDraft,
	options: {
		taskId: string
		/** Ids taken in the store it goes to; for a change, the job's own id is kept. */
		taken: string[]
		keepId?: string
		zone: string
		teamId: string | null
		fromTeamTask: boolean
	},
): JobFile {
	const title = draft.title?.trim() || 'Job'
	const forTeam = Boolean(draft.forTeam)
	const kind = forTeam || draft.writeTo === 'team-notes' ? 'team-note' : 'note'
	const usesTeam = !forTeam && (kind === 'team-note' || options.fromTeamTask)
	return {
		id: options.keepId ?? jobId(title, options.taken),
		title,
		task: options.taskId,
		schedule: parseSchedule(draft.schedule ?? ''),
		destination: { kind, name: draft.note?.trim() || title },
		inputs: draft.inputs ?? '',
		...(forTeam ? { zone: options.zone } : {}),
		...(usesTeam && options.teamId ? { team: options.teamId } : {}),
	}
}

/**
 * A chat drafts notes only. A folder or connector tool to write to, and sending on its own, are set in
 * the form, so a change made in the chat keeps them as they were; a new name for the file is taken.
 */
export function keepFormSettings(
	drafted: JobFile,
	before: JobFile | undefined,
	note?: string,
): JobFile {
	const kept = before?.destination
	return {
		...drafted,
		...(kept?.kind === 'file'
			? { destination: { ...kept, name: note?.trim() || kept.name } }
			: kept?.kind === 'tool'
				? { destination: kept }
				: {}),
		...(before?.send ? { send: before.send } : {}),
	}
}

/** A task as a draft, to change or copy it. Named tools stay named: nothing is widened by a change. */
export function draftFromTask(
	task: TaskFile,
	editing?: { key: string; version?: string | null },
): Draft {
	return {
		kind: 'task',
		task: {
			title: task.title,
			description: task.description,
			ask: task.ask,
			instructions: task.instructions,
			tools: task.tools,
		},
		job: {},
		...(editing
			? {
					editing: editing.key,
					...(editing.version !== undefined ? { editingVersion: editing.version } : {}),
				}
			: {}),
	}
}

export function draftFromJob(job: JobFile, team: boolean, editing?: string): Draft {
	return {
		kind: 'job',
		task: {},
		job: {
			title: job.title,
			task: job.task,
			inputs: job.inputs,
			schedule: formatSchedule(job.schedule),
			note: job.destination.name,
			writeTo: job.destination.kind === 'team-note' ? 'team-notes' : 'my-notes',
			forTeam: team,
		},
		...(editing ? { editing } : {}),
	}
}

/** The draft in plain words, for the card. */
export function describeDraft(draft: Draft, taskTitle: (id: string) => string | undefined): string {
	if (draft.kind === 'task') {
		const { title, description } = draft.task
		return [title, description].filter(Boolean).join(': ') || 'Filling in as we talk.'
	}
	const { job } = draft
	const parts: string[] = []
	if (job.schedule) {
		try {
			parts.push(describeSchedule(parseSchedule(job.schedule)))
		} catch {}
	}
	const task = job.task === NEW_TASK ? draft.task.title : job.task ? taskTitle(job.task) : undefined
	if (task) parts.push(`runs ${task}`)
	const note = job.note || job.title
	if (note) {
		const where = job.forTeam || job.writeTo === 'team-notes' ? 'the team note' : 'the note'
		parts.push(`writes to ${where} ${note}`)
	}
	return parts.length ? `${parts.join(', ')}.` : 'Filling in as we talk.'
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value)

const stringsOf = (value: unknown, keys: string[]): Record<string, string> =>
	isRecord(value)
		? Object.fromEntries(
				keys.flatMap((key) => (typeof value[key] === 'string' ? [[key, value[key]]] : [])),
			)
		: {}

/**
 * A draft read back from a stored conversation, which a newer app or a person may have written: only
 * what this app knows is kept, and anything else makes it an ordinary chat again.
 */
export function parseDraft(value: unknown): Draft | undefined {
	if (!isRecord(value) || (value.kind !== 'task' && value.kind !== 'job')) return undefined
	const task = isRecord(value.task) ? value.task : {}
	const tools = task.tools
	const job = isRecord(value.job) ? value.job : {}
	return {
		kind: value.kind,
		task: {
			...stringsOf(task, ['title', 'description', 'ask', 'instructions']),
			...(tools === 'none' || tools === 'all'
				? { tools }
				: Array.isArray(tools) && tools.every((name) => typeof name === 'string')
					? { tools: tools as string[] }
					: {}),
		},
		job: {
			...stringsOf(job, ['title', 'task', 'inputs', 'schedule', 'note']),
			...(job.writeTo === 'my-notes' || job.writeTo === 'team-notes'
				? { writeTo: job.writeTo }
				: {}),
			...(typeof job.forTeam === 'boolean' ? { forTeam: job.forTeam } : {}),
		},
		...(typeof value.editing === 'string' ? { editing: value.editing } : {}),
		...(typeof value.editingVersion === 'string' || value.editingVersion === null
			? { editingVersion: value.editingVersion as string | null }
			: {}),
		...(typeof value.saved === 'string' ? { saved: value.saved } : {}),
	}
}
