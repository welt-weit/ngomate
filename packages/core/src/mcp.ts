import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { ToolDefinition } from './model.js'

export type ToolResult = { text: string; isError: boolean }

/** A ready-made task a connector offers. */
export type PromptDefinition = {
	name: string
	description: string
	arguments: { name: string; description: string; required: boolean }[]
}

export interface ToolSource {
	listTools(): Promise<ToolDefinition[]>
	callTool(name: string, args: Record<string, unknown>): Promise<ToolResult>
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

async function httpTransport(options: McpToolSourceOptions): Promise<Transport> {
	if (!options.url) throw new Error('An MCP server needs a url or a transport')
	const token = await options.getAccessToken?.()
	const { StreamableHTTPClientTransport } = await import(
		'@modelcontextprotocol/sdk/client/streamableHttp.js'
	)
	return new StreamableHTTPClientTransport(new URL(options.url), {
		...(options.fetch ? { fetch: options.fetch } : {}),
		...(token ? { requestInit: { headers: { authorization: `Bearer ${token}` } } } : {}),
	}) as Transport
}

export async function connectMcpToolSource(options: McpToolSourceOptions): Promise<ToolSource> {
	const transport = options.transport ?? (await httpTransport(options))
	// Loaded on first use: someone with no add-ons should not spend memory on the protocol library.
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
		// A program add-on is already running by now, and nothing else would stop it.
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
			const result = await client.callTool({ name, arguments: args })
			const content = Array.isArray(result.content) ? result.content : []
			const text = content
				.map((part) => (part.type === 'text' ? part.text : `[${part.type} content omitted]`))
				.join('\n')
			return { text, isError: result.isError === true }
		},

		async listPrompts() {
			if (!client.getServerCapabilities()?.prompts) return []
			const prompts: PromptDefinition[] = []
			let cursor: string | undefined
			do {
				const page = await client.listPrompts(cursor ? { cursor } : {})
				for (const prompt of page.prompts) {
					prompts.push({
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
