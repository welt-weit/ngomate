import type { ChatMessage, PromptDefinition, TaskFile } from '@ngomate/core'
import { type FormEvent, type KeyboardEvent, useEffect, useRef, useState } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { AnswerNotice, NgomateHost, PickedDocument } from './host.js'
import { type ChatDeps, type PendingWrite, documentBlock, useChat } from './useChat.js'

function WriteConfirmation({ request }: { request: PendingWrite }) {
	const isMemory = request.tool === 'save_memory'
	return (
		<div className="ngm-confirm" role="alertdialog" aria-label="Confirm this action">
			<strong>{isMemory ? 'Save this note?' : `Allow ${request.tool}?`}</strong>
			{isMemory ? (
				<>
					<p className="ngm-muted">Name: {String(request.args.name ?? '')}</p>
					<pre className="ngm-pre">{String(request.args.text ?? '')}</pre>
				</>
			) : (
				<pre className="ngm-pre">{JSON.stringify(request.args, null, 2)}</pre>
			)}
			<div className="ngm-row">
				<button type="button" className="ngm-primary" onClick={() => request.resolve(true)}>
					Allow
				</button>
				<button type="button" onClick={() => request.resolve(false)}>
					Don't allow
				</button>
			</div>
		</div>
	)
}

function Notice({ notice }: { notice: AnswerNotice }) {
	return (
		<div className="ngm-notice">
			{notice.stopped && <p>{notice.stopped}</p>}
			{notice.checkFigures && (
				<p>Check every name and figure against your material. The model can mix them up.</p>
			)}
			{notice.unsourcedDates.length > 0 && (
				<p>
					Not found in your material or in any tool's result, so check them:{' '}
					{notice.unsourcedDates.join(', ')}
				</p>
			)}
			{notice.unsourcedLinks.length > 0 && (
				<p>
					These links did not come from your material or any tool, and may not exist:{' '}
					{notice.unsourcedLinks.join(', ')}
				</p>
			)}
		</div>
	)
}

function CopyAndSave({
	host,
	text,
	onProblem,
}: { host: NgomateHost; text: string; onProblem: (err: unknown) => void }) {
	const [copied, setCopied] = useState(false)
	return (
		<div className="ngm-row ngm-answer-actions">
			<button
				type="button"
				className="ngm-quiet"
				onClick={() => navigator.clipboard.writeText(text).then(() => setCopied(true), onProblem)}
			>
				{copied ? 'Copied' : 'Copy'}
			</button>
			<button
				type="button"
				className="ngm-quiet"
				onClick={() => host.saveDocument('draft.md', text).catch(onProblem)}
			>
				Save as file
			</button>
		</div>
	)
}

function MessageView({
	message,
	notice,
	host,
	onProblem,
}: {
	message: ChatMessage
	notice?: AnswerNotice
	host: NgomateHost
	onProblem: (err: unknown) => void
}) {
	if (message.role === 'user') return <div className="ngm-message ngm-user">{message.content}</div>
	if (message.role !== 'assistant') return null
	if (message.toolCalls?.length) {
		return (
			<p className="ngm-tool-line">Used {message.toolCalls.map((call) => call.name).join(', ')}</p>
		)
	}
	if (!message.content) return null
	return (
		<div className="ngm-message ngm-assistant">
			{/* Model text is never rendered as HTML, and its links do not navigate this window. */}
			<Markdown
				remarkPlugins={[remarkGfm]}
				components={{
					a: ({ href, children }) => (
						<a href={href} target="_blank" rel="noreferrer noopener">
							{children}
						</a>
					),
					img: ({ alt }) => <span>{alt}</span>,
				}}
			>
				{message.content}
			</Markdown>
			{notice && <Notice notice={notice} />}
			<CopyAndSave host={host} text={message.content} onProblem={onProblem} />
		</div>
	)
}

export type ChatStart = { task?: TaskFile; prompt?: { definition: PromptDefinition; text: string } }

export function Chat({
	deps,
	conversationId,
	start,
	onStarted,
}: { deps: ChatDeps; conversationId: string; start: ChatStart | null; onStarted: () => void }) {
	const chat = useChat(deps, conversationId)
	const [text, setText] = useState('')
	const [documents, setDocuments] = useState<PickedDocument[]>([])
	const [task, setTask] = useState<TaskFile | undefined>()
	const [prompt, setPrompt] = useState<ChatStart['prompt']>()
	const [fileProblem, setFileProblem] = useState<string | null>(null)
	const bottom = useRef<HTMLDivElement>(null)
	const onProblem = (err: unknown) =>
		setFileProblem(err instanceof Error ? err.message : String(err))

	useEffect(() => {
		if (!start) return
		setTask(start.task)
		setPrompt(start.prompt)
		onStarted()
	}, [start, onStarted])

	// biome-ignore lint/correctness/useExhaustiveDependencies: scrolls when any of these change
	useEffect(() => {
		bottom.current?.scrollIntoView?.({ block: 'end' })
	}, [chat.conversation.messages.length, chat.streaming, chat.pendingWrite])

	const submit = async (event?: FormEvent) => {
		event?.preventDefault()
		if (chat.busy || (!text.trim() && !documents.length && !prompt)) return
		const options = {
			task,
			documents,
			prompt: prompt ? { title: prompt.definition.name, text: prompt.text } : undefined,
		}
		setText('')
		setDocuments([])
		setTask(undefined)
		setPrompt(undefined)
		await chat.send(text.trim(), options)
	}

	const onKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
		if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
			event.preventDefault()
			submit()
		}
	}

	const attach = async () => {
		setFileProblem(null)
		try {
			const picked = await deps.host.pickDocument()
			if (picked) setDocuments((known) => [...known, picked])
		} catch (err) {
			onProblem(err)
		}
	}

	const { messages, notices } = chat.conversation
	return (
		<div className="ngm-chat">
			<div className="ngm-messages" aria-live="polite">
				{messages.length === 0 && !chat.busy && (
					<div className="ngm-empty">
						<h2>What are we working on?</h2>
						<p className="ngm-muted">
							Everything stays on this computer unless you connect an add-on. Attach a document or
							pick a ready-made task to start.
						</p>
					</div>
				)}
				{messages.map((message, index) => (
					// biome-ignore lint/suspicious/noArrayIndexKey: messages only ever grow at the end
					<MessageView
						key={index}
						message={message}
						notice={notices[index]}
						host={deps.host}
						onProblem={onProblem}
					/>
				))}
				{chat.streaming && (
					<div className="ngm-message ngm-assistant">
						<Markdown
							remarkPlugins={[remarkGfm]}
							components={{ img: ({ alt }) => <span>{alt}</span> }}
						>
							{chat.streaming}
						</Markdown>
					</div>
				)}
				{chat.busy && !chat.streaming && !chat.pendingWrite && (
					<output className="ngm-tool-line ngm-working">
						{chat.activity ? `Using ${chat.activity}…` : 'Thinking…'}
					</output>
				)}
				{chat.pendingWrite && <WriteConfirmation request={chat.pendingWrite} />}
				{chat.error && (
					<p className="ngm-error" role="alert">
						{chat.error}
					</p>
				)}
				{fileProblem && (
					<p className="ngm-error" role="alert">
						{fileProblem}
					</p>
				)}
				{chat.problems.length > 0 && (
					<p className="ngm-notice">
						Could not reach: {chat.problems.join(', ')}. Carried on without them.
					</p>
				)}
				<div ref={bottom} />
			</div>

			<form className="ngm-composer" onSubmit={submit}>
				{task && (
					<div className="ngm-chip-line">
						<span className="ngm-chip">{task.title}</span>
						<button type="button" className="ngm-quiet" onClick={() => setTask(undefined)}>
							Remove
						</button>
						<span className="ngm-muted">{task.ask}</span>
					</div>
				)}
				{prompt && (
					<div className="ngm-chip-line">
						<span className="ngm-chip">{prompt.definition.name}</span>
						<button type="button" className="ngm-quiet" onClick={() => setPrompt(undefined)}>
							Remove
						</button>
					</div>
				)}
				{documents.map((document, index) => (
					// biome-ignore lint/suspicious/noArrayIndexKey: two files can share a name
					<div className="ngm-chip-line" key={index}>
						<span className="ngm-chip">{document.name}</span>
						<button
							type="button"
							className="ngm-quiet"
							onClick={() => setDocuments((known) => known.filter((_, at) => at !== index))}
						>
							Remove
						</button>
						{documentBlock(document).cut && (
							<span className="ngm-muted">Too long: only the first part will be read.</span>
						)}
					</div>
				))}
				<textarea
					aria-label="Message"
					value={text}
					rows={3}
					placeholder={task ? task.ask : 'Write a message'}
					onChange={(event) => setText(event.target.value)}
					onKeyDown={onKey}
				/>
				<div className="ngm-row ngm-composer-actions">
					<button type="button" onClick={attach} disabled={chat.busy}>
						Attach document
					</button>
					<span className="ngm-grow" />
					{chat.busy ? (
						<button type="button" onClick={chat.stop}>
							Stop
						</button>
					) : (
						<button type="submit" className="ngm-primary">
							Send
						</button>
					)}
				</div>
			</form>
		</div>
	)
}
