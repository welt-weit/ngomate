import {
	type JobFile,
	type Schedule,
	type TaskFile,
	WEEKDAYS,
	type Weekday,
	describeSchedule,
	destinationNote,
	isTimeZone,
	jobId,
	parseSchedule,
} from '@ngomate/core'
import { useId, useState } from 'react'
import type { JobDraft } from './drafts.js'
import { usePrimitives } from './primitives.js'
import { isOwnTask } from './useOwnTasks.js'

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/

/** Why a note cannot have this name on every kind of storage, or null when it can. */
export function noteNameProblem(name: string): string | null {
	if (/[\\/:*?"<>|]/.test(name))
		return 'The note name (the job\'s name, if no note is given) cannot hold any of / \\ : * ? " < > |.'
	if (name.startsWith('.') || name.includes('..'))
		return 'A note name cannot start with a dot or hold two in a row.'
	if (new TextEncoder().encode(name).length > 200) return 'That note name is too long. Shorten it.'
	return null
}

const DAY_LABELS: Record<Weekday, string> = {
	mon: 'Monday',
	tue: 'Tuesday',
	wed: 'Wednesday',
	thu: 'Thursday',
	fri: 'Friday',
	sat: 'Saturday',
	sun: 'Sunday',
}

/** A task the job can run, and the team's version of it when it comes from the team. */
export type JobTaskChoice = { task: TaskFile; fromTeam: boolean; version: string | null }

/**
 * Makes a job: a ready-made task, what it asks for given once, a schedule and the note the result goes
 * to. Nothing else is written: what the model asks to change is listed for the person instead.
 */
export function JobDialog({
	tasks,
	takenIds,
	teamId,
	canWriteTeamNotes,
	canShareWithTeam,
	initial,
	editing = false,
	zone: givenZone,
	onCreate,
	onClose,
}: {
	tasks: JobTaskChoice[]
	/** Job ids in use, this person's and the team's apart. */
	takenIds: { own: string[]; team: string[] }
	/** This computer's id for the open team: a job of this person's own that uses it keeps it. */
	teamId: string | null
	canWriteTeamNotes: boolean
	/** The team's storage can share jobs, so one can run on whichever member's computer is on. */
	canShareWithTeam: boolean
	/** Filled in from a draft made in words, or from the job being changed. */
	initial?: JobDraft
	/** Changing a job that exists: who it is for stays as it is. */
	editing?: boolean
	/** The zone of a team job being changed, kept whoever changes it. */
	zone?: string
	onCreate: (job: JobFile, options: { team: boolean; taskVersion: string | null }) => Promise<void>
	onClose: () => void
}) {
	const { Button, Input, TextArea, Select, Dialog } = usePrimitives()
	// A task that is not here (deleted, or another team's) stays named, and must be picked again: the
	// job is never quietly given another one.
	const missingTask =
		initial?.task && !tasks.some((each) => each.task.id === initial.task) ? initial.task : null
	const [taskId, setTaskId] = useState(initial?.task ?? tasks[0]?.task.id ?? '')
	const choice = tasks.find((each) => each.task.id === taskId)
	const start = (() => {
		try {
			return initial?.schedule ? parseSchedule(initial.schedule) : null
		} catch {
			return null
		}
	})()
	const [title, setTitle] = useState(initial?.title ?? choice?.task.title ?? '')
	const [inputs, setInputs] = useState(initial?.inputs ?? '')
	const [every, setEvery] = useState<Schedule['every']>(start?.every ?? 'week')
	const [weekday, setWeekday] = useState<Weekday>(start?.every === 'week' ? start.day : 'mon')
	const [monthDay, setMonthDay] = useState(start?.every === 'month' ? start.day : 1)
	const [time, setTime] = useState(start?.time ?? '09:00')
	// A job for one person writes to that person's notes unless they choose the team's.
	const [where, setWhere] = useState<'note' | 'team-note'>(
		initial?.writeTo === 'team-notes' ? 'team-note' : 'note',
	)
	const [noteName, setNoteName] = useState(initial?.note ?? '')
	const [teamChosen, setForTeam] = useState(Boolean(initial?.forTeam))
	// Only where the team can share jobs; a job being changed stays what it was.
	const forTeam = teamChosen && (canShareWithTeam || editing)
	// A team job keeps the zone it was made in, so its time is the same moment for every member. A
	// system that names its zone by an abbreviation others may not know uses UTC, and says so.
	const ownZone = Intl.DateTimeFormat().resolvedOptions().timeZone
	const zone = givenZone ?? (isTimeZone(ownZone) ? ownZone : 'UTC')
	const [problem, setProblem] = useState<string | null>(null)
	const [saving, setSaving] = useState(false)
	const formId = useId()

	const schedule: Schedule =
		every === 'day'
			? { every, time }
			: every === 'week'
				? { every, day: weekday, time }
				: { every, day: monthDay, time }

	if (!tasks.length) {
		return (
			<Dialog title="New job" onClose={onClose} actions={<Button onClick={onClose}>Close</Button>}>
				<p>There are no ready-made tasks to run on a schedule.</p>
			</Dialog>
		)
	}

	return (
		<Dialog
			title={editing ? `Change ${initial?.title ?? 'the job'}` : 'New job'}
			onClose={onClose}
			problem={problem}
			actions={
				<>
					<Button onClick={onClose}>Cancel</Button>
					<Button type="submit" form={formId} variant="primary" disabled={saving || !choice}>
						{editing ? 'Save the changes' : 'Make the job'}
					</Button>
				</>
			}
		>
			<form
				id={formId}
				className="ngm-form"
				onSubmit={async (event) => {
					event.preventDefault()
					if (!choice) {
						setProblem('Pick the task this job runs.')
						return
					}
					if (forTeam && isOwnTask(choice.task.id)) {
						setProblem(
							"A job for the team cannot run one of your own tasks: the others' computers do not have it.",
						)
						return
					}
					const name = title.trim() || choice.task.title
					const destination = {
						kind: forTeam ? ('team-note' as const) : where,
						name: noteName.trim() || name,
					}
					// A job of this person's own that uses the team's notes or task runs only with that team open.
					const usesTeam = !forTeam && (destination.kind === 'team-note' || choice.fromTeam)
					const wrong = !inputs.trim()
						? `Write what the task needs: ${choice.task.ask.toLowerCase()}.`
						: every === 'month' && !(Number.isInteger(monthDay) && monthDay >= 1 && monthDay <= 28)
							? 'Give the day of the month as a number from 1 to 28.'
							: !TIME.test(time)
								? 'Give the time as hours and minutes, such as 09:00.'
								: noteNameProblem(destinationNote(destination, new Date()))
					setProblem(wrong)
					if (wrong) return
					setSaving(true)
					try {
						await onCreate(
							{
								id: jobId(name, forTeam ? takenIds.team : takenIds.own),
								title: name,
								task: choice.task.id,
								schedule,
								destination,
								inputs: inputs.trim(),
								...(forTeam && zone ? { zone } : {}),
								...(usesTeam && teamId ? { team: teamId } : {}),
							},
							{ team: forTeam, taskVersion: choice.fromTeam ? choice.version : null },
						)
						onClose()
					} catch (err) {
						setProblem(err instanceof Error ? err.message : String(err))
					} finally {
						setSaving(false)
					}
				}}
			>
				<label>
					Task
					<Select
						value={taskId}
						onChange={(event) => {
							const next = tasks.find((each) => each.task.id === event.target.value)
							setTaskId(event.target.value)
							if (next && (!title || title === choice?.task.title)) setTitle(next.task.title)
						}}
					>
						{missingTask && (
							<option value={missingTask} disabled>
								{missingTask} (not here now: pick a task)
							</option>
						)}
						{tasks
							// A team job runs on any member's computer, which has none of this person's own tasks.
							.filter((each) => !forTeam || !isOwnTask(each.task.id))
							.map((each) => (
								<option key={each.task.id} value={each.task.id}>
									{each.task.title}
									{each.fromTeam ? ' (your team)' : isOwnTask(each.task.id) ? ' (yours)' : ''}
								</option>
							))}
					</Select>
				</label>
				{choice && <p className="ngm-muted">{choice.task.description}</p>}
				{!canShareWithTeam && canWriteTeamNotes && (
					<p className="ngm-muted">
						Jobs for the whole team need its storage on S3 or WebDAV: a synced folder or a connector
						cannot make sure only one computer runs each date.
					</p>
				)}
				{canShareWithTeam && !editing && (
					<label>
						For
						<Select
							value={forTeam ? 'team' : 'me'}
							onChange={(event) => {
								const team = event.target.value === 'team'
								setForTeam(team)
								// A team job cannot run one of this person's own tasks: another is picked.
								if (team && isOwnTask(taskId))
									setTaskId(tasks.find((each) => !isOwnTask(each.task.id))?.task.id ?? '')
							}}
						>
							<option value="me">Just me, on this computer</option>
							<option value="team">The team, on whichever member's computer is on</option>
						</Select>
					</label>
				)}
				<label>
					Name
					<Input required value={title} onChange={(event) => setTitle(event.target.value)} />
				</label>
				<label>
					{choice?.task.ask ?? 'What the task needs'}
					<TextArea
						required
						rows={4}
						value={inputs}
						onChange={(event) => setInputs(event.target.value)}
					/>
				</label>
				<div className="ngm-row">
					<label>
						How often
						<Select
							value={every}
							onChange={(event) => setEvery(event.target.value as Schedule['every'])}
						>
							<option value="day">Every day</option>
							<option value="week">Every week</option>
							<option value="month">Every month</option>
						</Select>
					</label>
					{every === 'week' && (
						<label>
							On
							<Select
								value={weekday}
								onChange={(event) => setWeekday(event.target.value as Weekday)}
							>
								{WEEKDAYS.map((day) => (
									<option key={day} value={day}>
										{DAY_LABELS[day]}
									</option>
								))}
							</Select>
						</label>
					)}
					{every === 'month' && (
						<label>
							On day
							{/* Up to 28, so it is in every month. */}
							<Input
								type="number"
								min="1"
								max="28"
								step="1"
								required
								value={Number.isNaN(monthDay) ? '' : monthDay}
								onChange={(event) => setMonthDay(event.target.valueAsNumber)}
							/>
						</label>
					)}
					<label>
						At
						<Input
							type="time"
							required
							value={time}
							onChange={(event) => setTime(event.target.value)}
						/>
					</label>
				</div>
				<p className="ngm-muted">
					{forTeam
						? `${describeSchedule(schedule)} (${zone} time), on the first team member's computer that has this app open. Everyone in the team sees the job and its results.`
						: `${describeSchedule(schedule)}, while this app is open. A time missed while the computer was off runs once when it is back.`}
				</p>
				{!forTeam && (
					<label>
						Write the result to
						<Select
							value={where}
							onChange={(event) => setWhere(event.target.value as 'note' | 'team-note')}
						>
							<option value="note">My notes</option>
							{(canWriteTeamNotes || where === 'team-note') && (
								// Shown as it is, even with that team closed: the form never says one thing and
								// saves another.
								<option value="team-note">
									{canWriteTeamNotes
										? "The team's notes"
										: "The team's notes (that team is not open)"}
								</option>
							)}
						</Select>
					</label>
				)}
				<label>
					{forTeam ? 'Team note' : 'Note'}
					<Input
						placeholder={title || choice?.task.title || ''}
						value={noteName}
						onChange={(event) => setNoteName(event.target.value)}
					/>
				</label>
				<p className="ngm-muted">
					Each run replaces that note. Put {'{date}'} in its name to keep one note per run. If the
					assistant asks to change anything else, such as something in a connected service, nothing
					happens until you allow it.
				</p>
			</form>
		</Dialog>
	)
}
