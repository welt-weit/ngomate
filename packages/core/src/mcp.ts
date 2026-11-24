import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { ToolDefinition } from './model.js'

export type ToolResult = {
	text: string
	isError: boolean
	/** Time on the network for an HTTP connector, answer read in full. Absent for other connectors. */
	httpMs?: number
}

/** A ready-made task a connector offers. */
export type PromptDefinition = {
	name: string
	/** The name for people, when the server gives one. */
	title?: string
	description: string
	arguments: { name: string; description: string; required: boolean }[]
}

/** What the person decided while confirming a write, passed beside the model's arguments. */
export type CallContext = { choice?: string }

export interface ToolSource {
	listTools(): Promise<ToolDefinition[]>
	callTool(name: string, args: Record<string, unknown>, context?: CallContext): Promise<ToolResult>
	/** Absent or empty when the source offers no ready-made tasks. */
	listPrompts?(): Promise<PromptDefinition[]>
	getPrompt?(name: string, args: Record<string, string>): Promise<string>
	close(): Promise<void>
}

export type McpToolSourceOptions = {
	url?: string
	/** For a server that is not reached over HTTP. Takes the place of `url`. */
	transport?: Transport
	/** Asked on every connection, so a host can refresh. The core never stores a token. */
	getAccessToken?: () => Promise<string>
	/** Hosts whose webview cannot call out directly (CORS) inject their own, e.g. Tauri's. */
	fetch?: typeof fetch
	clientName?: string
}

/** No body allowed with these, so one read in full is not put back. */
const NO_BODY = [101, 103, 204, 205, 304]

/**
 * Counts the time requests spend on the network, so a slow tool call can be told apart from a slow
 * server. A JSON answer is read here, to count reading it too; an event stream is passed on as it is,
 * since it may stay open.
 */
function timedFetch(base: typeof fetch, spent: { ms: number }): typeof fetch {
	return async (input, init) => {
		const start = performance.now()
		try {
			const response = await base(input, init)
			if (!response.headers.get('content-type')?.includes('application/json')) return response
			const body = await response.arrayBuffer()
			return new Response(NO_BODY.includes(response.status) || !body.byteLength ? null : body, {
				status: response.status,
				statusText: response.statusText,
				headers: response.headers,
			})
		} finally {
			spent.ms += performance.now() - start
		}
	}
}

async function httpTransport(
	options: McpToolSourceOptions,
	spent: { ms: number },
): Promise<Transport> {
	if (!options.url) throw new Error('An MCP server needs a url or a transport')
	const token = await options.getAccessToken?.()
	const { StreamableHTTPClientTransport } = await import(
		'@modelcontextprotocol/sdk/client/streamableHttp.js'
	)
	return new StreamableHTTPClientTransport(new URL(options.url), {
		fetch: timedFetch(options.fetch ?? fetch, spent),
		...(token ? { requestInit: { headers: { authorization: `Bearer ${token}` } } } : {}),
	}) as Transport
}

export async function connectMcpToolSource(options: McpToolSourceOptions): Promise<ToolSource> {
	const spent = { ms: 0 }
	const transport = options.transport ?? (await httpTransport(options, spent))
	const overHttp = !options.transport
	// Loaded on first use: someone with no connectors should not spend memory on the protocol library.
	const [{ Client }, { CfWorkerJsonSchemaValidator }] = await Promise.all([
		import('@modelcontextprotocol/sdk/client/index.js'),
		import('@modelcontextprotocol/sdk/validation/cfworker'),
	])
	// The default validator compiles schemas with eval, which a desktop app's security policy blocks.
	const client = new Client(
		{ name: options.clientName ?? 'ngomate', version: '0.0.1' },
		{ jsonSchemaValidator: new CfWorkerJsonSchemaValidator() },
	)
	try {
		await client.connect(transport)
	} catch (err) {
		// A program connector is already running by now, and nothing else would stop it.
		await transport.close().catch(() => {})
		throw err
	}

	return {
		async listTools() {
			const tools: ToolDefinition[] = []
			let cursor: string | undefined
			do {
				const page = await client.listTools(cursor ? { cursor } : {})
				for (const tool of page.tools) {
					tools.push({
						name: tool.name,
						description: tool.description ?? '',
						inputSchema: tool.inputSchema as Record<string, unknown>,
						annotations: {
							readOnly: tool.annotations?.readOnlyHint,
							destructive: tool.annotations?.destructiveHint,
						},
					})
				}
				cursor = page.nextCursor
			} while (cursor)
			return tools
		},

		async callTool(name, args) {
			const before = spent.ms
			const result = await client.callTool({ name, arguments: args })
			const content = Array.isArray(result.content) ? result.content : []
			const text = content
				.map((part) => (part.type === 'text' ? part.text : `[${part.type} content omitted]`))
				.join('\n')
			return {
				text,
				isError: result.isError === true,
				...(overHttp ? { httpMs: Math.round(spent.ms - before) } : {}),
			}
		},

		async listPrompts() {
			if (!client.getServerCapabilities()?.prompts) return []
			const prompts: PromptDefinition[] = []
			let cursor: string | undefined
			do {
				const page = await client.listPrompts(cursor ? { cursor } : {})
				for (const prompt of page.prompts) {
					prompts.push({
						...(typeof prompt.title === 'string' && prompt.title ? { title: prompt.title } : {}),
						name: prompt.name,
						description: prompt.description ?? '',
						arguments: (prompt.arguments ?? []).map((argument) => ({
							name: argument.name,
							description: argument.description ?? '',
							required: argument.required === true,
						})),
					})
				}
				cursor = page.nextCursor
			} while (cursor)
			return prompts
		},

		async getPrompt(name, args) {
			const prompt = await client.getPrompt({ name, arguments: args })
			return prompt.messages
				.map((message) => (message.content.type === 'text' ? message.content.text : ''))
				.filter(Boolean)
				.join('\n\n')
		},

		close: () => client.close(),
	}
}
