import type { TaskFile } from '@ngomate/core'
import { useId, useState } from 'react'
import type { TaskDraft } from './drafts.js'
import { usePrimitives } from './primitives.js'

export type TaskForm = Required<Omit<TaskDraft, 'tools'>> & { tools: TaskFile['tools'] }

/**
 * The form lane for a task: name, what it is for, what it asks first, what the assistant does, and
 * whether it may use connected tools. Kept for this person, or for the team when one is open.
 */
export function TaskDialog({
	title,
	initial,
	canSaveForTeam,
	forTeam: fixedForTeam,
	onSave,
	onClose,
}: {
	/** "New task", "Change …" or "Copy of …". */
	title: string
	initial?: TaskDraft
	/** A team is open whose tasks can be written. */
	canSaveForTeam: boolean
	/** Set when changing a task: where it is kept stays as it is. */
	forTeam?: boolean
	onSave: (task: TaskForm, forTeam: boolean) => Promise<void>
	onClose: () => void
}) {
	const { Button, Input, TextArea, Select, Dialog } = usePrimitives()
	const [form, setForm] = useState<TaskForm>({
		title: initial?.title ?? '',
		description: initial?.description ?? '',
		ask: initial?.ask ?? '',
		instructions: initial?.instructions ?? '',
		tools: initial?.tools ?? 'none',
	})
	const [forTeam, setForTeam] = useState(fixedForTeam ?? false)
	const named = Array.isArray(initial?.tools) ? initial.tools : null
	const [problem, setProblem] = useState<string | null>(null)
	const [saving, setSaving] = useState(false)
	const formId = useId()
	const set = (key: keyof TaskForm) => (event: { target: { value: string } }) =>
		setForm((current) => ({ ...current, [key]: event.target.value }))

	return (
		<Dialog
			title={title}
			onClose={onClose}
			problem={problem}
			actions={
				<>
					<Button onClick={onClose}>Cancel</Button>
					<Button type="submit" form={formId} variant="primary" disabled={saving}>
						{fixedForTeam === undefined ? 'Make the task' : 'Save the changes'}
					</Button>
				</>
			}
		>
			<form
				id={formId}
				className="ngm-form"
				onSubmit={async (event) => {
					event.preventDefault()
					const trimmed = {
						...form,
						title: form.title.trim(),
						description: form.description.trim(),
						ask: form.ask.trim(),
						instructions: form.instructions.trim(),
					}
					const missing = !trimmed.title
						? 'Give the task a name.'
						: !trimmed.description
							? 'Say in a line what the task is for.'
							: !trimmed.ask
								? 'Say what the task asks for before it starts.'
								: !trimmed.instructions
									? 'Write what the assistant should do.'
									: null
					setProblem(missing)
					if (missing) return
					setSaving(true)
					try {
						await onSave(trimmed, forTeam)
						onClose()
					} catch (err) {
						setProblem(err instanceof Error ? err.message : String(err))
					} finally {
						setSaving(false)
					}
				}}
			>
				<label>
					Name
					<Input data-autofocus value={form.title} onChange={set('title')} />
				</label>
				<label>
					What it is for
					<Input
						placeholder="Checks funder pages for anything new"
						value={form.description}
						onChange={set('description')}
					/>
				</label>
				<label>
					What it asks you for before it starts
					<Input
						placeholder="The funders and their web pages"
						value={form.ask}
						onChange={set('ask')}
					/>
				</label>
				<label>
					What the assistant should do
					<TextArea rows={8} value={form.instructions} onChange={set('instructions')} />
				</label>
				<label>
					It may use
					<Select
						value={Array.isArray(form.tools) ? 'named' : form.tools}
						onChange={(event) => {
							const value = event.target.value
							setForm((current) => ({
								...current,
								tools: value === 'named' && named ? named : value === 'all' ? 'all' : 'none',
							}))
						}}
					>
						<option value="none">Only what you give it</option>
						<option value="all">Your connected tools too</option>
						{/* A task that names its tools keeps them unless the person picks otherwise. */}
						{named && <option value="named">Only these tools: {named.join(', ')}</option>}
					</Select>
				</label>
				{canSaveForTeam && fixedForTeam === undefined && (
					<label>
						Keep it for
						<Select
							value={forTeam ? 'team' : 'me'}
							onChange={(event) => setForTeam(event.target.value === 'team')}
						>
							<option value="me">Just me</option>
							<option value="team">The team</option>
						</Select>
					</label>
				)}
				{forTeam && (
					<p className="ngm-muted">
						Everyone in the team sees it and can change it. After a change, each member reads it
						before it runs.
					</p>
				)}
			</form>
		</Dialog>
	)
}
