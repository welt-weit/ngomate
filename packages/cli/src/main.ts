import { createInterface } from 'node:readline/promises'
import { parseArgs } from 'node:util'
import { type ConfirmWrite, connectMcpToolSource, createOpenAiCompatibleClient, runTask } from '@ngomate/core'
import { TASKS } from './tasks.js'

const { values, positionals } = parseArgs({
	allowPositionals: true,
	options: {
		model: { type: 'string', default: 'qwen3:8b' },
		'model-url': { type: 'string', default: 'http://127.0.0.1:11434/v1' },
		'mcp-url': { type: 'string', default: 'http://localhost:9085/v1/mcp' },
		think: { type: 'boolean', default: false },
		json: { type: 'boolean', default: false },
		'decline-writes': { type: 'boolean', default: false },
		call: { type: 'string' },
	},
})

const [taskId, ...rest] = positionals
const task = taskId ? TASKS[taskId] : undefined
const input = rest.join(' ')
if (!task || !input) {
	console.error(
		`Usage: ngomate <${Object.keys(TASKS).join('|')}> "what you want" [--model name] [--call opportunity-id]`,
	)
	process.exit(2)
}
if (task.id === 'call-to-tasks' && !values.call) {
	console.error('call-to-tasks needs --call with the id of one funding call.')
	process.exit(2)
}
const profile = values.call
	? {
			...task,
			preload: [
				{ tool: 'get_opportunity', args: { opportunityId: values.call } },
				...(task.preload ?? []),
			],
		}
	: task

// From the environment only, so a token never lands in shell history or a process list.
const token = process.env.NGOMATE_MCP_TOKEN
if (!token) {
	console.error('Set NGOMATE_MCP_TOKEN to an access token for the MCP server.')
	process.exit(2)
}

const log = (line: string) => {
	if (!values.json) console.error(line)
}

const confirmWrite: ConfirmWrite = async ({ tool, args }) => {
	if (values['decline-writes']) return false
	const prompt = createInterface({ input: process.stdin, output: process.stderr })
	const answer = await prompt.question(`\nAllow ${tool}?\n${JSON.stringify(args, null, 2)}\n[y/N] `)
	prompt.close()
	return answer.trim().toLowerCase() === 'y'
}

const tools = await connectMcpToolSource({ url: values['mcp-url'], getAccessToken: async () => token })
try {
	const run = await runTask({
		model: createOpenAiCompatibleClient({
			baseUrl: values['model-url'],
			model: values.model,
			extraBody: values.think ? undefined : { reasoning_effort: 'none' },
		}),
		tools,
		profile,
		input,
		confirmWrite,
		onEvent: (event) => {
			if (event.type === 'turn') {
				log(`turn ${event.turn}: ${(event.ms / 1000).toFixed(1)}s, ${event.promptTokens ?? '?'} tokens in`)
			} else if (event.type === 'tool_call') {
				log(`  ${event.kind} ${event.tool} ${JSON.stringify(event.args)}`)
			} else if (event.type === 'tool_result') {
				log(`  ${event.isError ? 'error' : 'ok'}, ${event.chars} chars`)
			} else {
				log(`  refused ${event.tool}: ${event.reason}`)
			}
		},
	})
	if (values.json) {
		console.log(JSON.stringify({ model: values.model, task: profile.id, ...run }, null, 2))
	} else {
		console.log(`\n${run.answer ?? `[${run.status}] ${run.error ?? ''}`}`)
		console.error(`\n${run.status}, ${run.turns} turns, ${(run.totalMs / 1000).toFixed(1)}s`)
		if (run.missingTools.length) console.error(`Not offered by this server: ${run.missingTools.join(', ')}`)
	}
	process.exitCode = run.status === 'completed' ? 0 : 1
} finally {
	await tools.close()
}
