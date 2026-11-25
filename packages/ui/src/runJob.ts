import {
	type JobChange,
	type JobFile,
	type JobRun,
	type JobState,
	type MemoryStore,
	type TaskFile,
	TeamConflict,
	afterFailure,
	afterRun,
	describeChange,
	destinationNote,
	latenessNote,
} from '@ngomate/core'
import { makeId } from './format.js'
import type { AnswerNotice } from './host.js'
import { type ChatDeps, answerRequest, makeChange, newConversation } from './useChat.js'
import type { TeamTask } from './useTeam.js'

/** A job's runs are kept as conversations named after it, listed under the job rather than the chats. */
export const jobRunPrefix = (jobId: string) => `job-${jobId}-`

/** What the checks found, in a line each, for the top of what a job writes. Empty when they found nothing. */
export function checkLines(notice: AnswerNotice | null): string[] {
	if (!notice) return []
	const lines: string[] = []
	if (notice.stopped) lines.push(notice.stopped)
	if (notice.cutOff) lines.push('The answer reached the length limit and was cut off.')
	if (notice.knowledgeUnavailable)
		lines.push('The knowledge base did not answer, so this was written without it.')
	for (const item of notice.figureProblems ?? []) {
		lines.push(
			item.problem === 'different'
				? `${item.figure}: the material says ${item.material?.join(', ')}.`
				: `${item.figure}: not found in the material.`,
		)
	}
	if (notice.unsourcedDates.length)
		lines.push(`Dates no tool or material gave: ${notice.unsourcedDates.join(', ')}.`)
	if (notice.unsourcedLinks.length)
		lines.push(
			`Links no tool or material gave, which may not exist: ${notice.unsourcedLinks.join(', ')}.`,
		)
	return lines
}

const dayOf = (date: Date) =>
	date.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })

/** The note a run writes: who wrote it, what the checks found and what it wanted, then the answer. */
export function jobNote(options: {
	job: JobFile
	ranAt: Date
	answer: string
	checks: string[]
	wants: string[]
	/** Messages going on their own to the recipients fixed for the job. */
	sending?: string[]
	late: string | null
}): string {
	const { job, ranAt, answer, checks, wants, sending = [], late } = options
	return [
		`Written by NGOmate, an AI assistant, for the job "${job.title}" on ${dayOf(ranAt)}. Check it before relying on it.`,
		late ?? '',
		checks.length ? `Check these first:\n${checks.map((line) => `- ${line}`).join('\n')}` : '',
		wants.length
			? `It asked to make these changes, which wait for you in the app:\n${wants.map((line) => `- ${line}`).join('\n')}`
			: '',
		sending.length
			? `Sent on its own to the recipients fixed for this job:\n${sending.map((line) => `- ${line}`).join('\n')}`
			: '',
		'---',
		answer.trim(),
	]
		.filter(Boolean)
		.join('\n\n')
}

/** Keys a tool may name people or places to send to by. Any of them not fixed for the job stops it going alone. */
const RECIPIENT_KEYS =
	/^(to|cc|bcc|recipients?|emails?|addresses?|channels?|channel_id|chat_id|users?|user_id|phones?|numbers?|groups?|lists?|audience)$/i

/** A value as a set of recipients: lower case, split at commas, sorted, so "B, a" equals "a,b". */
const recipients = (value: unknown) =>
	(Array.isArray(value) ? value : [value])
		.flatMap((each) => String(each ?? '').split(','))
		.map((each) => each.trim().toLowerCase())
		.filter(Boolean)
		.sort()
		.join(',')

/**
 * Whether a call goes only to the recipients fixed for the job: the fixed tool, every fixed argument as
 * fixed, and no other argument naming someone to send to. Anything else waits for the person.
 */
export function sendsOnlyTo(
	request: { tool: string; args: Record<string, unknown> },
	send: { tool: string; to: Record<string, string> },
): boolean {
	if (request.tool !== send.tool) return false
	for (const [key, value] of Object.entries(send.to)) {
		if (recipients(request.args[key]) !== recipients(value)) return false
	}
	return Object.entries(request.args).every(
		([key, value]) => key in send.to || !RECIPIENT_KEYS.test(key) || !recipients(value),
	)
}

/** A run with nobody's personal notes, for a team job. */
const NO_NOTES: MemoryStore = {
	list: async () => [],
	read: async () => null,
	write: async () => {
		throw new Error('A team job does not save personal notes.')
	},
	remove: async () => {},
}

/**
 * What a team job runs with on whichever member's computer is on: none of that person's notes, and only
 * the connectors the team file suggests, so its result does not depend on who ran it, and no member's
 * own mail or files reach a note the team reads.
 */
export function forTeamRun(chat: ChatDeps, teamConnectors: string[]): ChatDeps {
	return {
		...chat,
		host: { ...chat.host, memory: NO_NOTES },
		settings: {
			...chat.settings,
			addons: chat.settings.addons.filter(
				(addon) =>
					addon.connection.kind === 'http' && teamConnectors.includes(addon.connection.url),
			),
		},
	}
}

export type JobRunDeps = {
	chat: ChatDeps
	/** The app's ready-made tasks. */
	tasks: TaskFile[]
	/** The active team's tasks, with the version each was read at. */
	teamTasks: TeamTask[]
	/** This computer's id for the active team, if one is open. */
	teamId?: string
	/** The addresses of the connectors the active team suggests: the only ones a team job uses. */
	teamConnectors?: string[]
	/** For a team job: the name of the member whose computer runs it. */
	by?: string
}

/**
 * Runs a job once and returns its state after: the next date, and this run at the top of its list.
 * Nothing is ever changed on the model's say-so: a change it asks for is refused and listed in what the
 * run writes. A run that could not write is tried again shortly, then left until the next date.
 */
export async function runJob(
	deps: JobRunDeps,
	job: JobFile,
	state: JobState,
	signal: AbortSignal,
	now: () => Date = () => new Date(),
): Promise<JobState> {
	const dueAt = new Date(state.nextDue)
	const ranAt = now()
	const run: JobRun = {
		dueAt: state.nextDue,
		ranAt: ranAt.toISOString(),
		outcome: 'done',
		seen: false,
		...(deps.by ? { by: deps.by } : {}),
	}
	const held = (reason: string, waitsFor?: JobRun['waitsFor']) =>
		afterRun(
			state,
			job,
			{ ...run, outcome: 'held', reason, ...(waitsFor ? { waitsFor } : {}) },
			ranAt,
		)
	const failed = (reason: string, conversationId?: string) =>
		afterFailure(state, job, { ...run, outcome: 'failed', reason, conversationId }, ranAt)

	// A job of this person's own that uses a team's notes or task, while another team or none is open:
	// it would write to the wrong team, or run another team's task of the same name.
	if (deps.by === undefined && job.team !== undefined && job.team !== deps.teamId)
		return held('This job uses a team that is not open now. Open that team for it to run.')
	const teamTask = deps.teamTasks.find((item) => item.task.id === job.task)
	const task = deps.tasks.find((each) => each.id === job.task) ?? teamTask?.task
	// Tried again rather than held: a team's tasks are read a moment after the team opens, and a date
	// passed over here would be lost.
	if (!task)
		return failed(
			`The task "${job.task}" is not there. If it is gone for good, delete this job and make it again.`,
		)
	// Anyone in the team can change a team task, so a changed one is read by the person before it runs.
	if (teamTask && !deps.tasks.some((each) => each.id === job.task)) {
		// A task whose storage gives no version cannot be told changed, so it is not held for that.
		if (teamTask.version !== null && teamTask.version !== state.taskVersion)
			return held(
				'Someone in your team changed the task this job runs. Read it, then run the job again.',
				'task',
			)
	}
	// A team job runs on whichever member's computer is on, so its result goes where every member sees it:
	// the team's notes, or a connector tool the team suggests. Never a note or a folder on one computer.
	if (
		deps.by !== undefined &&
		job.destination.kind !== 'team-note' &&
		job.destination.kind !== 'tool'
	)
		return held(
			"A team job writes to the team's notes or a team connector. Make it again with one of those.",
		)
	if (job.destination.kind === 'file' && !deps.chat.host.files)
		return held('This app cannot write files to a folder. Make the job again with a note.')
	const notes = deps.chat.team?.notes
	if (job.destination.kind === 'team-note' && !notes)
		return held("This job writes to the team's notes, and no team is open.")

	const conversation = {
		...newConversation(`${jobRunPrefix(job.id)}${makeId('run')}`),
		title: `${job.title}, ${dayOf(ranAt)}`,
	}
	const changes: JobChange[] = []
	const last = state.runs.find((each) => each.outcome !== 'failed' && each.outcome !== 'held')
	const late = latenessNote(dueAt, ranAt)
	const context = [
		'This is a job that runs on a schedule. Nobody is watching it run, so do not ask questions: do what you can and say what is missing.',
		last
			? `It last ran on ${last.ranAt.slice(0, 10)}. Say what is new since then, and keep what is unchanged short.`
			: '',
	]
		.filter(Boolean)
		.join(' ')

	const chat = deps.by === undefined ? deps.chat : forTeamRun(deps.chat, deps.teamConnectors ?? [])
	const result = await answerRequest(
		chat,
		conversation,
		job.inputs,
		// Its fixed send tool is offered even when the job's words do not name it, or it could never send.
		{ task, context, ...(job.send ? { offerTools: [job.send.tool] } : {}) },
		{
			signal,
			// Nobody is there to ask, so every change is refused here and waits for the person, save a message
			// to the recipients fixed for this job, which may go on its own once the result is saved.
			confirmWrite: async (request) => {
				const auto = job.send && sendsOnlyTo(request, job.send)
				changes.push({
					tool: request.tool,
					args: request.args,
					decision: 'waiting',
					...(auto ? { auto: true } : {}),
				})
				return false
			},
			// Named for the job and the day, not for the task, so its runs can be told apart.
			save: async (next) => {
				await deps.chat.host.writeConversation({ ...next, title: conversation.title })
				deps.chat.onSaved()
			},
		},
	)
	// Only a conversation that was kept: a run refused before it started has nothing to open.
	const conversationId = result.conversation.messages.length ? result.conversation.id : undefined
	// Stopped because the app closed or the team changed: not a try, so the job runs again as it was.
	if (signal.aborted) return state
	if (!result.answer) return failed(result.error ?? 'The model gave no answer.', conversationId)

	const checks = checkLines(result.notice)
	// A message for the fixed recipients goes on its own only when the checks found nothing: otherwise
	// the person reads the result first, as for any change.
	for (const change of changes) {
		if (change.auto && checks.length)
			change.held =
				'The checks found something in this run, so it waits for you instead of going on its own.'
	}
	const sending = changes.filter((change) => change.auto && !change.held)
	const wants = changes.filter((change) => !sending.includes(change)).map(describeChange)
	const text = jobNote({
		job,
		ranAt,
		answer: result.answer,
		checks,
		wants,
		sending: sending.map(describeChange),
		late,
	})
	let note = destinationNote(job.destination, dueAt, job.zone)
	const where =
		job.destination.kind === 'file' ? 'file' : job.destination.kind === 'tool' ? 'tool' : 'note'
	try {
		const destination = job.destination
		if (destination.kind === 'note') await deps.chat.host.memory.write(note, text)
		else if (destination.kind === 'file') {
			// A new file every run, never over one there: the host adds a number to a name already taken.
			note = (await deps.chat.host.files?.writeNew(destination.folder, `${note}.md`, text)) ?? note
		} else if (destination.kind === 'tool') {
			// The one write approved when the job was made: the tool, its fixed arguments, the result in one.
			await makeChange(chat, {
				tool: destination.name,
				args: { ...destination.args, [destination.field]: text },
			})
		} else {
			try {
				await notes?.save(note, text)
			} catch (err) {
				// Someone changed the note since this computer last read it: theirs stays, this run gets its own.
				if (!(err instanceof TeamConflict)) throw err
				// No colon: no storage takes one in a name.
				note = `${note} (${ranAt.toISOString().slice(0, 16).replace('T', ' ').replace(':', '.')})`
				await notes?.save(note, text)
			}
		}
	} catch (err) {
		return failed(
			`The result could not be written to the ${where} "${note}": ${err instanceof Error ? err.message : String(err)}`,
			conversationId,
		)
	}
	// Sent only now that the result is saved: a run tried again after a failed save never sends twice.
	for (const change of sending) {
		try {
			await makeChange(chat, change)
			change.decision = 'made'
		} catch (err) {
			change.error = err instanceof Error ? err.message : String(err)
		}
	}
	const waiting = changes.some((change) => change.decision === 'waiting')
	const outcome = waiting ? 'waiting' : checks.length ? 'warnings' : 'done'
	return afterRun(
		state,
		job,
		{ ...run, outcome, conversationId, note, ...(changes.length ? { changes } : {}) },
		ranAt,
	)
}
