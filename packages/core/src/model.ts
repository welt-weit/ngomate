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
}

export type ModelReply = {
	content: string | null
	toolCalls: ToolCall[]
	promptTokens: number | null
	completionTokens: number | null
}

export interface ModelClient {
	chat(request: { messages: ChatMessage[]; tools: ToolDefinition[] }): Promise<ModelReply>
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

type WireReply = {
	choices?: {
		message?: {
			content?: string | null
			tool_calls?: { id?: string; function?: { name?: string; arguments?: unknown } }[]
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

/** Speaks the chat completions format, which Ollama and llama-server both serve. */
export function createOpenAiCompatibleClient(options: OpenAiCompatibleOptions): ModelClient {
	const doFetch = options.fetch ?? fetch
	const url = `${options.baseUrl.replace(/\/$/, '')}/chat/completions`

	return {
		async chat({ messages, tools }) {
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
				signal: AbortSignal.timeout(options.timeoutMs ?? 600_000),
			})
			if (!response.ok) {
				throw new Error(`Model endpoint answered ${response.status}: ${(await response.text()).slice(0, 300)}`)
			}

			const body = (await response.json()) as WireReply
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
		},
	}
}
