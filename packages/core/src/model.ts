export type ToolCall = {
	id: string
	name: string
	/** Raw JSON text as the model wrote it. Small models get this wrong, so it is parsed by the agent. */
	arguments: string
}

export type ChatMessage =
	| { role: 'system' | 'user'; content: string }
	| { role: 'assistant'; content: string | null; toolCalls?: ToolCall[] }
	| { role: 'tool'; content: string; toolCallId: string }

export type ToolDefinition = {
	name: string
	description: string
	inputSchema: Record<string, unknown>
	/** What the server says about the tool. A hint, never proof: anything unmarked counts as a write. */
	annotations?: { readOnly?: boolean; destructive?: boolean }
}

export type ModelReply = {
	content: string | null
	toolCalls: ToolCall[]
	promptTokens: number | null
	completionTokens: number | null
}

export type ChatRequest = {
	messages: ChatMessage[]
	tools: ToolDefinition[]
	/** Called with each piece of the answer as it arrives. Thinking is never passed on. */
	onText?: (text: string) => void
	signal?: AbortSignal
}

export interface ModelClient {
	chat(request: ChatRequest): Promise<ModelReply>
}

export type OpenAiCompatibleOptions = {
	/** e.g. http://127.0.0.1:11434/v1 (Ollama) or http://127.0.0.1:8080/v1 (llama-server) */
	baseUrl: string
	model: string
	apiKey?: string
	/** Hosts whose webview cannot call out directly (CORS) inject their own, e.g. Tauri's. */
	fetch?: typeof fetch
	/** Generous by default: one turn on a CPU-only laptop can take minutes. */
	timeoutMs?: number
	temperature?: number
	/** Sent as is, e.g. `{ reasoning_effort: 'none' }`: a thinking model can spend minutes on one turn. */
	extraBody?: Record<string, unknown>
}

type WireToolCall = {
	index?: number
	id?: string
	function?: { name?: string; arguments?: unknown }
}

type WireReply = {
	choices?: {
		message?: {
			content?: string | null
			tool_calls?: WireToolCall[]
		}
	}[]
	usage?: { prompt_tokens?: number; completion_tokens?: number }
}

/** Reasoning models put their thinking in the content. It is not an answer, and must not count as one. */
export function stripThinking(content: string): string {
	return content.replace(/<think>[\s\S]*?(<\/think>|$)/g, '').trim()
}

function toWire(message: ChatMessage) {
	if (message.role === 'tool') {
		return { role: 'tool', content: message.content, tool_call_id: message.toolCallId }
	}
	if (message.role === 'assistant' && message.toolCalls?.length) {
		return {
			role: 'assistant',
			content: message.content,
			tool_calls: message.toolCalls.map((call) => ({
				id: call.id,
				type: 'function',
				function: { name: call.name, arguments: call.arguments },
			})),
		}
	}
	return { role: message.role, content: message.content }
}

/** Passes on what is outside <think> blocks, including when a tag is split across two pieces. */
export function createThinkingFilter(emit: (text: string) => void): (piece: string) => void {
	const OPEN = '<think>'
	const CLOSE = '</think>'
	let buffer = ''
	let thinking = false

	const heldBack = (text: string, tag: string): number => {
		for (let length = Math.min(tag.length - 1, text.length); length > 0; length--) {
			if (text.endsWith(tag.slice(0, length))) return length
		}
		return 0
	}

	return (piece) => {
		buffer += piece
		while (buffer) {
			const tag = thinking ? CLOSE : OPEN
			const at = buffer.indexOf(tag)
			if (at >= 0) {
				if (!thinking && at > 0) emit(buffer.slice(0, at))
				buffer = buffer.slice(at + tag.length)
				thinking = !thinking
				continue
			}
			const keep = heldBack(buffer, tag)
			if (!thinking && buffer.length > keep) emit(buffer.slice(0, buffer.length - keep))
			buffer = keep ? buffer.slice(-keep) : ''
			return
		}
	}
}

async function readStream(response: Response, onText: (text: string) => void): Promise<WireReply> {
	if (!response.body) throw new Error('Model endpoint returned no stream')
	const emit = createThinkingFilter(onText)
	const decoder = new TextDecoder()
	const toolCalls = new Map<number, { id?: string; name: string; arguments: string }>()
	let content = ''
	let usage: WireReply['usage']
	let pending = ''

	const handle = (line: string) => {
		if (!line.startsWith('data:')) return
		const data = line.slice(5).trim()
		if (!data || data === '[DONE]') return
		const chunk = JSON.parse(data) as {
			choices?: { delta?: { content?: string | null; tool_calls?: WireToolCall[] } }[]
			usage?: WireReply['usage']
		}
		if (chunk.usage) usage = chunk.usage
		const delta = chunk.choices?.[0]?.delta
		if (delta?.content) {
			content += delta.content
			emit(delta.content)
		}
		for (const [position, call] of (delta?.tool_calls ?? []).entries()) {
			const index = call.index ?? position
			const known = toolCalls.get(index) ?? { name: '', arguments: '' }
			if (call.id) known.id = call.id
			if (call.function?.name) known.name += call.function.name
			const piece = call.function?.arguments
			if (piece !== undefined)
				known.arguments += typeof piece === 'string' ? piece : JSON.stringify(piece)
			toolCalls.set(index, known)
		}
	}

	const reader = response.body.getReader()
	for (;;) {
		const { done, value } = await reader.read()
		if (done) break
		pending += decoder.decode(value, { stream: true })
		const lines = pending.split('\n')
		pending = lines.pop() ?? ''
		for (const line of lines) handle(line.trimEnd())
	}
	handle(pending.trimEnd())

	return {
		choices: [
			{
				message: {
					content,
					tool_calls: [...toolCalls.values()].map((call) => ({
						id: call.id,
						function: { name: call.name, arguments: call.arguments },
					})),
				},
			},
		],
		usage,
	}
}

/** Speaks the chat completions format, which Ollama and llama-server both serve. */
export function createOpenAiCompatibleClient(options: OpenAiCompatibleOptions): ModelClient {
	const doFetch = options.fetch ?? fetch
	const url = `${options.baseUrl.replace(/\/$/, '')}/chat/completions`

	return {
		async chat({ messages, tools, onText, signal }) {
			// By hand: the WebKit in older macOS versions has neither AbortSignal.any nor .timeout.
			const controller = new AbortController()
			const abort = () => controller.abort()
			const timer = setTimeout(abort, options.timeoutMs ?? 600_000)
			if (signal?.aborted) abort()
			signal?.addEventListener('abort', abort, { once: true })
			try {
				const response = await doFetch(url, {
					method: 'POST',
					headers: {
						'content-type': 'application/json',
						...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}),
					},
					body: JSON.stringify({
						...options.extraBody,
						model: options.model,
						temperature: options.temperature ?? 0,
						messages: messages.map(toWire),
						...(onText ? { stream: true, stream_options: { include_usage: true } } : {}),
						...(tools.length
							? {
									tools: tools.map((tool) => ({
										type: 'function',
										function: {
											name: tool.name,
											description: tool.description,
											parameters: tool.inputSchema,
										},
									})),
								}
							: {}),
					}),
					signal: controller.signal,
				})
				if (!response.ok) {
					throw new Error(
						`Model endpoint answered ${response.status}: ${(await response.text()).slice(0, 300)}`,
					)
				}

				const body = onText
					? await readStream(response, onText)
					: ((await response.json()) as WireReply)
				const message = body.choices?.[0]?.message
				if (!message) throw new Error('Model endpoint returned no message')

				const content = message.content ? stripThinking(message.content) : ''
				return {
					content: content || null,
					toolCalls: (message.tool_calls ?? []).map((call, index) => ({
						id: call.id ?? `call_${index}`,
						name: call.function?.name ?? '',
						// Some servers hand back an object where the format says a JSON string.
						arguments:
							typeof call.function?.arguments === 'string'
								? call.function.arguments
								: JSON.stringify(call.function?.arguments ?? {}),
					})),
					promptTokens: body.usage?.prompt_tokens ?? null,
					completionTokens: body.usage?.completion_tokens ?? null,
				}
			} finally {
				clearTimeout(timer)
				signal?.removeEventListener('abort', abort)
			}
		},
	}
}
