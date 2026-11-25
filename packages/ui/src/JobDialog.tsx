import {
	type JobDestination,
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
import { useEffect, useId, useState } from 'react'
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

/** A connector tool a job can write to or send with: its text fields, for what is fixed when it is made. */
export type ToolOption = {
	name: string
	description: string
	fields: { name: string; label: string; required: boolean }[]
}

/** Field names that say who a message goes to: asked for when a job sends on its own. */
const RECIPIENT_FIELD =
	/^(to|cc|bcc|recipients?|emails?|addresses?|channels?|channel_id|chat_id|users?|user_id|phones?|numbers?|groups?|lists?|audience)$/i

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
	existing,
	chooseFolder,
	listTools,
	canWake = false,
	wake: initialWake = false,
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
	/** The job being changed, for where its result goes and what it sends on its own. */
	existing?: JobFile
	/** Asks for a folder. Left out, results go to notes or connectors only. */
	chooseFolder?: () => Promise<string | null>
	/** The connectors' tools, read when the person picks a tool. Left out, no tools are offered. */
	listTools?: () => Promise<ToolOption[]>
	/** This computer can start NGOmate for a job at its time. */
	canWake?: boolean
	wake?: boolean
	onCreate: (
		job: JobFile,
		options: { team: boolean; taskVersion: string | null; wake: boolean },
	) => Promise<void>
	onClose: () => void
}) {
	const { Button, Input, TextArea, Select, Dialog, Checkbox } = usePrimitives()
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
	// A job for one person writes to that person's notes unless they choose otherwise.
	const before = existing?.destination
	const [where, setWhere] = useState<'note' | 'team-note' | 'file' | 'tool'>(
		before && before.kind !== 'note'
			? before.kind
			: initial?.writeTo === 'team-notes'
				? 'team-note'
				: 'note',
	)
	const [folder, setFolder] = useState(before?.kind === 'file' ? before.folder : '')
	const [toolName, setToolName] = useState(before?.kind === 'tool' ? before.name : '')
	const [toolField, setToolField] = useState(before?.kind === 'tool' ? before.field : '')
	const [toolArgs, setToolArgs] = useState<Record<string, string>>(
		before?.kind === 'tool' ? before.args : {},
	)
	// Sending on its own is the person's choice, here only: ready-made jobs and chat drafts never set it.
	const [sendMode, setSendMode] = useState<'ask' | 'own'>(existing?.send ? 'own' : 'ask')
	const [sendTool, setSendTool] = useState(existing?.send?.tool ?? '')
	const [sendTo, setSendTo] = useState<Record<string, string>>(existing?.send?.to ?? {})
	const [wake, setWake] = useState(initialWake)
	const [tools, setTools] = useState<ToolOption[] | null>(null)
	const [toolsProblem, setToolsProblem] = useState<string | null>(null)
	const needsTools = where === 'tool' || sendMode === 'own'
	useEffect(() => {
		if (!needsTools || tools || !listTools) return
		listTools().then(setTools, (err) =>
			setToolsProblem(err instanceof Error ? err.message : String(err)),
		)
	}, [needsTools, tools, listTools])
	const destinationTool = tools?.find((each) => each.name === toolName)
	const senderTool = tools?.find((each) => each.name === sendTool)
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

	const destinationChoices = [
		!forTeam,
		forTeam || canWriteTeamNotes || where === 'team-note',
		!forTeam && Boolean(chooseFolder || where === 'file'),
		Boolean(listTools || where === 'tool'),
	].filter(Boolean).length
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
					// A team job writes where every member sees it: the team's notes or a connector tool.
					const kind = forTeam ? (where === 'tool' ? 'tool' : 'team-note') : where
					const destination: JobDestination =
						kind === 'file'
							? { kind, name: noteName.trim() || name, folder }
							: kind === 'tool'
								? { kind, name: toolName, field: toolField, args: fixedOf(toolArgs) }
								: { kind, name: noteName.trim() || name }
					const send =
						sendMode === 'own' && sendTool ? { tool: sendTool, to: fixedOf(sendTo) } : undefined
					const missingArgs = destinationTool?.fields.filter(
						(field) => field.required && field.name !== toolField && !toolArgs[field.name]?.trim(),
					)
					// A job of this person's own that uses the team's notes or task runs only with that team open.
					const usesTeam = !forTeam && (destination.kind === 'team-note' || choice.fromTeam)
					const wrong = !inputs.trim()
						? `Write what the task needs: ${choice.task.ask.toLowerCase()}.`
						: every === 'month' && !(Number.isInteger(monthDay) && monthDay >= 1 && monthDay <= 28)
							? 'Give the day of the month as a number from 1 to 28.'
							: !TIME.test(time)
								? 'Give the time as hours and minutes, such as 09:00.'
								: kind === 'file' && !folder
									? 'Choose the folder the results go to.'
									: kind === 'tool' && (!toolName || !toolField)
										? 'Pick the connector tool and the field the result goes into.'
										: kind === 'tool' && missingArgs?.length
											? `Fill in ${missingArgs.map((field) => field.label).join(', ')}.`
											: sendMode === 'own' && (!send || !Object.keys(send.to).length)
												? 'Pick the tool it sends with, and who it sends to.'
												: kind === 'tool'
													? null
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
								...(send ? { send } : {}),
							},
							{ team: forTeam, taskVersion: choice.fromTeam ? choice.version : null, wake },
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
				{/* Only when there is a choice: a team job with no connector can only write the team's notes. */}
				{destinationChoices > 1 && (
					<label>
						Write the result to
						<Select
							value={forTeam && where !== 'tool' ? 'team-note' : where}
							onChange={(event) => setWhere(event.target.value as typeof where)}
						>
							{!forTeam && <option value="note">My notes</option>}
							{(forTeam || canWriteTeamNotes || where === 'team-note') && (
								// Shown as it is, even with that team closed: the form never says one thing and
								// saves another.
								<option value="team-note">
									{forTeam || canWriteTeamNotes
										? "The team's notes"
										: "The team's notes (that team is not open)"}
								</option>
							)}
							{/* A folder is on one computer: a team job, run on any member's, cannot use one. */}
							{!forTeam && (chooseFolder || where === 'file') && (
								<option value="file">A new file in a folder</option>
							)}
							{(listTools || where === 'tool') && <option value="tool">A connector tool</option>}
						</Select>
					</label>
				)}
				{where === 'file' && !forTeam && (
					<div className="ngm-row">
						<span className={folder ? undefined : 'ngm-muted'}>
							{folder || 'No folder chosen yet'}
						</span>
						<Button
							onClick={async () => {
								const picked = await chooseFolder?.()
								if (picked) setFolder(picked)
							}}
						>
							{folder ? 'Choose another folder' : 'Choose a folder…'}
						</Button>
					</div>
				)}
				{where === 'tool' ? (
					<ToolFields
						tools={tools}
						problem={toolsProblem}
						tool={toolName}
						onTool={(name) => {
							setToolName(name)
							setToolField('')
							setToolArgs({})
						}}
						field={toolField}
						onField={setToolField}
						values={toolArgs}
						onValues={setToolArgs}
						selectLabel="Connector tool"
						fields={(option) => option.fields}
						resultField
					/>
				) : (
					<label>
						{where === 'file' ? 'File name' : forTeam ? 'Team note' : 'Note'}
						<Input
							placeholder={title || choice?.task.title || ''}
							value={noteName}
							onChange={(event) => setNoteName(event.target.value)}
						/>
					</label>
				)}
				<p className="ngm-muted">
					{where === 'file'
						? 'Each run writes a new file, never over one that is there. '
						: where === 'tool'
							? 'Each run calls this tool once, with what you fill in here and the result. '
							: 'Each run replaces that note. '}
					{where === 'tool' ? '' : <>Put {'{date}'} in the name to keep one per run. </>}
					If the assistant asks to change anything else, such as something in a connected service,
					nothing happens until you allow it.
				</p>
				{listTools && (
					<label>
						When it wants to send something to people
						<Select
							value={sendMode}
							onChange={(event) => setSendMode(event.target.value as 'ask' | 'own')}
						>
							<option value="ask">Ask me before sending</option>
							<option value="own">Send on its own, only to people I set here</option>
						</Select>
					</label>
				)}
				{sendMode === 'own' && (
					<>
						<ToolFields
							tools={
								tools?.filter((option) =>
									option.fields.some((field) => RECIPIENT_FIELD.test(field.name)),
								) ?? null
							}
							none="No connector offers a tool that sends to people, with a field that says who."
							problem={toolsProblem}
							tool={sendTool}
							onTool={(name) => {
								setSendTool(name)
								setSendTo({})
							}}
							values={sendTo}
							onValues={setSendTo}
							selectLabel="It sends with"
							fields={(option) => option.fields.filter((field) => RECIPIENT_FIELD.test(field.name))}
						/>
						<p className="ngm-muted">
							It sends on its own only with this tool, only to these, and only when the checks found
							nothing in that run. Anything else waits for you.
						</p>
						{senderTool && !senderTool.fields.some((field) => RECIPIENT_FIELD.test(field.name)) && (
							<p className="ngm-error">
								This tool has no field that says who it sends to. Pick another, or let it ask.
							</p>
						)}
					</>
				)}
				{canWake && (
					<label className="ngm-inline">
						<Checkbox checked={wake} onChange={(event) => setWake(event.target.checked)} /> Start
						NGOmate for this job when the app is closed
					</label>
				)}
				{canWake && wake && (
					<p className="ngm-muted">
						On this computer only. At the job's time NGOmate opens without a window, runs it, and
						closes again. The computer has to be on.
					</p>
				)}
			</form>
		</Dialog>
	)
}

/** Only what was filled in, trimmed: an empty field is not fixed. */
function fixedOf(values: Record<string, string>): Record<string, string> {
	return Object.fromEntries(
		Object.entries(values)
			.map(([key, value]) => [key, value.trim()] as const)
			.filter(([, value]) => value),
	)
}

/** Picks a connector tool and fills in what is fixed for it: for a destination, or for sending. */
function ToolFields({
	tools,
	problem,
	tool,
	onTool,
	field,
	onField,
	values,
	onValues,
	selectLabel,
	fields,
	resultField = false,
	none = 'No connector offers a tool. Add one under Connectors first.',
}: {
	tools: ToolOption[] | null
	problem: string | null
	tool: string
	onTool: (name: string) => void
	field?: string
	onField?: (name: string) => void
	values: Record<string, string>
	onValues: (values: Record<string, string>) => void
	selectLabel: string
	fields: (option: ToolOption) => ToolOption['fields']
	/** Ask which field takes the result. */
	resultField?: boolean
	/** Said when no connector offers a tool that fits. */
	none?: string
}) {
	const { Input, Select } = usePrimitives()
	if (problem)
		return <p className="ngm-error">The connectors' tools could not be read: {problem}</p>
	if (!tools) return <p className="ngm-muted">Reading the connectors' tools…</p>
	if (!tools.length) return <p className="ngm-muted">{none}</p>
	const option = tools.find((each) => each.name === tool)
	const shown = option ? fields(option).filter((each) => each.name !== field) : []
	return (
		<>
			<label>
				{selectLabel}
				<Select value={tool} onChange={(event) => onTool(event.target.value)}>
					<option value="">Pick a tool</option>
					{tools.map((each) => (
						<option key={each.name} value={each.name}>
							{each.name}
						</option>
					))}
				</Select>
			</label>
			{option && <p className="ngm-muted">{option.description}</p>}
			{option && resultField && onField && (
				<label>
					The result goes into
					<Select value={field ?? ''} onChange={(event) => onField(event.target.value)}>
						<option value="">Pick a field</option>
						{option.fields.map((each) => (
							<option key={each.name} value={each.name}>
								{each.label}
							</option>
						))}
					</Select>
				</label>
			)}
			{shown.map((each) => (
				<label key={each.name}>
					{each.label}
					{each.required ? '' : ' (if you like)'}
					<Input
						value={values[each.name] ?? ''}
						onChange={(event) => onValues({ ...values, [each.name]: event.target.value })}
					/>
				</label>
			))}
		</>
	)
}

/** Names a tool that removes something goes by. */
const DELETES = /^(delete|remove|archive|revoke|purge|clear)_/i

/** The connectors' tools as the form offers them: each with its text fields, the required ones marked. */
export function toolOptions(
	tools: {
		name: string
		description: string
		inputSchema: Record<string, unknown>
		annotations?: { readOnly?: boolean; destructive?: boolean }
	}[],
): ToolOption[] {
	// Only a tool that writes, and deletes nothing: a result or a message goes INTO it. A tool named as a
	// delete is left out too, since a connector may not mark it destructive.
	const writers = tools.filter(
		(tool) =>
			!tool.annotations?.readOnly && !tool.annotations?.destructive && !DELETES.test(tool.name),
	)
	return writers
		.map((tool) => {
			const schema = tool.inputSchema as {
				properties?: Record<string, { type?: unknown; description?: unknown }>
				required?: unknown
			}
			const required = Array.isArray(schema.required) ? schema.required : []
			return {
				name: tool.name,
				description: tool.description,
				fields: Object.entries(schema.properties ?? {})
					.filter(([, property]) => property.type === undefined || property.type === 'string')
					.map(([name, property]) => ({
						name,
						label:
							typeof property.description === 'string' && property.description
								? `${name}: ${property.description.slice(0, 80)}`
								: name,
						required: required.includes(name),
					})),
			}
		})
		.filter((option) => option.fields.length > 0)
}
