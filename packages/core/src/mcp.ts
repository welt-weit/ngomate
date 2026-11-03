import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { ToolDefinition } from './model.js'

export type ToolResult = { text: string; isError: boolean }

export interface ToolSource {
	listTools(): Promise<ToolDefinition[]>
	callTool(name: string, args: Record<string, unknown>): Promise<ToolResult>
	close(): Promise<void>
}

export type McpToolSourceOptions = {
	url: string
	/** Asked on every connection, so a host can refresh. The core never stores a token. */
	getAccessToken?: () => Promise<string>
	/** Hosts whose webview cannot call out directly (CORS) inject their own, e.g. Tauri's. */
	fetch?: typeof fetch
	clientName?: string
}

export async function connectMcpToolSource(options: McpToolSourceOptions): Promise<ToolSource> {
	const token = await options.getAccessToken?.()
	const transport = new StreamableHTTPClientTransport(new URL(options.url), {
		...(options.fetch ? { fetch: options.fetch } : {}),
		...(token ? { requestInit: { headers: { authorization: `Bearer ${token}` } } } : {}),
	})
	const client = new Client({ name: options.clientName ?? 'ngomate', version: '0.0.1' })
	await client.connect(transport)

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

		close: () => client.close(),
	}
}
