import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/cfworker'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { connectMcpToolSource } from '../src/mcp.js'

async function connect() {
	const server = new McpServer({ name: 'test', version: '1.0.0' })
	server.registerTool(
		'read_it',
		{
			description: 'A read',
			inputSchema: { q: z.string() },
			outputSchema: { title: z.string() },
			annotations: { readOnlyHint: true },
		},
		async () => ({
			content: [{ type: 'text', text: 'A title' }],
			structuredContent: { title: 'A title' },
		}),
	)
	server.registerTool('change_it', { description: 'A write', inputSchema: {} }, async () => ({
		content: [{ type: 'text', text: 'done' }],
	}))
	server.registerPrompt(
		'status',
		{ description: 'A status', argsSchema: { project: z.string().describe('Project name') } },
		({ project }) => ({
			messages: [{ role: 'user', content: { type: 'text', text: `Status of ${project}` } }],
		}),
	)
	const [client, side] = InMemoryTransport.createLinkedPair()
	await server.connect(side)
	return connectMcpToolSource({ transport: client })
}

describe('connectMcpToolSource', () => {
	it('validates output with the validator that needs no eval, which the app forbids', async () => {
		const getValidator = vi.spyOn(CfWorkerJsonSchemaValidator.prototype, 'getValidator')
		const tools = await connect()
		await tools.listTools()
		expect(getValidator).toHaveBeenCalled()
		expect(await tools.callTool('read_it', { q: 'x' })).toEqual({ text: 'A title', isError: false })
		await tools.close()
		getValidator.mockRestore()
	})

	it('reads the read-only mark, and leaves an unmarked tool unmarked', async () => {
		const tools = await connect()
		const listed = await tools.listTools()
		expect(listed.find((tool) => tool.name === 'read_it')?.annotations?.readOnly).toBe(true)
		expect(listed.find((tool) => tool.name === 'change_it')?.annotations?.readOnly).toBeUndefined()
		await tools.close()
	})

	it('lists a prompt with its arguments and fills it in', async () => {
		const tools = await connect()
		const [prompt] = (await tools.listPrompts?.()) ?? []
		expect(prompt).toMatchObject({
			name: 'status',
			arguments: [{ name: 'project', description: 'Project name', required: true }],
		})
		expect(await tools.getPrompt?.('status', { project: 'Water' })).toBe('Status of Water')
		await tools.close()
	})
})
