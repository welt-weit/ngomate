import { useId, useState } from 'react'
import { type Draft, NEW_TASK, describeDraft, missingFromDraft } from './drafts.js'
import { ICONS, Icon } from './icons.js'
import { usePrimitives } from './primitives.js'

const KIND = { task: 'Task', job: 'Job' } as const

/**
 * The task or job a chat is making, pinned above it: what it does in plain words, what is still
 * missing, and the person's own buttons to save it. It fills in as the conversation goes on.
 */
export function DraftCard({
	draft,
	taskTitle,
	savedTitle,
	busy,
	onMake,
	onForm,
	onDiscard,
	onOpen,
	onChange,
}: {
	draft: Draft
	taskTitle: (id: string) => string | undefined
	/** The saved item's name, once saved. */
	savedTitle?: string
	/** An answer is being written: what the card shows may still change. */
	busy: boolean
	onMake: () => Promise<void>
	onForm: () => void
	onDiscard: () => void
	onOpen: () => void
	onChange: () => void
}) {
	const { Button } = usePrimitives()
	const [problem, setProblem] = useState<string | null>(null)
	const [saving, setSaving] = useState(false)
	const kind = KIND[draft.kind]

	if (draft.saved) {
		return (
			<section className="ngm-draft-card" aria-label={`${kind} made in this chat`}>
				<p className="ngm-draft-head">
					<strong>{kind}</strong> · Saved{savedTitle ? ` as ${savedTitle}` : ''}
				</p>
				<div className="ngm-row">
					<Button className="ngm-ai" onClick={onChange} disabled={busy}>
						<Icon path={ICONS.spark} size={14} />
						Change in chat
					</Button>
					<Button variant="quiet" onClick={onOpen}>
						{draft.kind === 'job' ? 'Open in Jobs' : 'Open in Tasks'}
					</Button>
				</div>
			</section>
		)
	}

	const missing = missingFromDraft(draft)
	const fields =
		draft.kind === 'task'
			? [
					['Name', draft.task.title],
					['For', draft.task.description],
					['Asks for', draft.task.ask],
					[
						'Uses',
						draft.task.tools === 'all'
							? 'Your connected tools too'
							: Array.isArray(draft.task.tools)
								? `Only these tools: ${draft.task.tools.join(', ')}`
								: undefined,
					],
				]
			: [
					['Name', draft.job.title],
					['Gives the task', draft.job.inputs],
					['Runs for', draft.job.forTeam ? 'The whole team' : undefined],
					[
						'New task',
						draft.job.task === NEW_TASK
							? [draft.task.title, draft.task.description].filter(Boolean).join(': ')
							: undefined,
					],
				]
	return (
		<section className="ngm-draft-card" aria-label={`${kind} being made in this chat`}>
			<p className="ngm-draft-head">
				<strong>{kind}</strong> · {draft.editing ? 'Changes not saved yet' : 'Draft, not saved yet'}
			</p>
			{/* Said aloud as it changes: the card fills in while the person talks, outside the messages. */}
			<output className="ngm-draft-line">{describeDraft(draft, taskTitle)}</output>
			<dl className="ngm-draft-fields">
				{fields
					.filter(([, value]) => value)
					.map(([label, value]) => (
						<div key={label}>
							<dt>{label}</dt>
							<dd>{value}</dd>
						</div>
					))}
			</dl>
			{draft.kind === 'task' && draft.task.instructions && (
				// Open when it may use connected tools, so what it would do with them is read before saving.
				<details open={draft.task.tools === 'all'}>
					<summary>What the assistant will do</summary>
					<p className="ngm-pre-wrap">{draft.task.instructions}</p>
				</details>
			)}
			{missing.length > 0 && <p className="ngm-muted">Still to say: {missing.join(', ')}.</p>}
			{problem && (
				<p className="ngm-error" role="alert">
					{problem}
				</p>
			)}
			<div className="ngm-row">
				<Button
					variant="primary"
					disabled={missing.length > 0 || busy || saving}
					onClick={async () => {
						setProblem(null)
						setSaving(true)
						try {
							await onMake()
						} catch (err) {
							setProblem(err instanceof Error ? err.message : String(err))
						} finally {
							setSaving(false)
						}
					}}
				>
					{draft.editing ? 'Save the changes' : 'Make it'}
				</Button>
				<Button onClick={onForm} disabled={busy}>
					Open in the form
				</Button>
				<Button variant="quiet" onClick={onDiscard} disabled={busy}>
					Discard
				</Button>
			</div>
		</section>
	)
}

/**
 * The start of making a task or job: say it in your own words, which opens a chat, or fill in the
 * form. The words come first, because most people would rather say what they want.
 */
export function MakeChooser({
	kind,
	onWords,
	onForm,
	onClose,
}: {
	kind: Draft['kind']
	onWords: (text: string) => void
	/** With what was typed so far, so switching to the form loses nothing. */
	onForm: (text: string) => void
	onClose: () => void
}) {
	const { Button, TextArea, Dialog } = usePrimitives()
	const [text, setText] = useState('')
	const formId = useId()
	const example =
		kind === 'job'
			? 'For example: every Monday morning, look for new funding for our water projects and put it in a note.'
			: 'For example: check a funder’s web page and tell me what changed since last time.'
	return (
		<Dialog
			title={kind === 'job' ? 'New job' : 'New task'}
			onClose={onClose}
			alternative={
				<Button variant="quiet" onClick={() => onForm(text.trim())}>
					Fill it in myself
				</Button>
			}
			actions={
				<>
					<Button onClick={onClose}>Cancel</Button>
					<Button
						type="submit"
						form={formId}
						variant="primary"
						className="ngm-ai"
						disabled={!text.trim()}
					>
						<Icon path={ICONS.spark} size={14} />
						Start
					</Button>
				</>
			}
		>
			<form
				id={formId}
				className="ngm-form"
				onSubmit={(event) => {
					event.preventDefault()
					if (text.trim()) onWords(text.trim())
				}}
			>
				<label>
					Tell me what you want
					<TextArea
						data-autofocus
						rows={4}
						placeholder={example}
						value={text}
						onChange={(event) => setText(event.target.value)}
					/>
				</label>
				<p className="ngm-muted">
					A chat opens where we make it together. You see it above the chat as it takes shape, and
					nothing is saved until you say so.
				</p>
			</form>
		</Dialog>
	)
}
