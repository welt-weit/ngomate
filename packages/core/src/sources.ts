import type { PromptDefinition, ToolResult, ToolSource } from './mcp.js'
import type { ToolDefinition } from './model.js'

export type NamedToolSource = { id: string; source: ToolSource }

/** A tool from a source that could not be reached is left out, and named here for the host to show. */
export type CombineOptions = { onSourceError?: (id: string, error: unknown) => void }

/**
 * Several sources as one. When two sources offer the same name, the later one's tool is called
 * `source__name`, so a model's call always reaches the source it was shown.
 */
export function combineToolSources(
	sources: NamedToolSource[],
	options: CombineOptions = {},
): ToolSource {
	const tools = new Map<string, { source: ToolSource; name: string }>()
	const prompts = new Map<string, { source: ToolSource; name: string }>()

	const unique = (taken: Map<string, unknown>, id: string, name: string) =>
		taken.has(name) ? `${id}__${name}` : name

	return {
		async listTools() {
			tools.clear()
			const all: ToolDefinition[] = []
			for (const { id, source } of sources) {
				let listed: ToolDefinition[]
				try {
					listed = await source.listTools()
				} catch (error) {
					options.onSourceError?.(id, error)
					continue
				}
				for (const tool of listed) {
					const name = unique(tools, id, tool.name)
					tools.set(name, { source, name: tool.name })
					all.push({ ...tool, name })
				}
			}
			return all
		},

		async callTool(name, args): Promise<ToolResult> {
			const target = tools.get(name)
			if (!target) return { text: `${name} is not available.`, isError: true }
			return target.source.callTool(target.name, args)
		},

		async listPrompts() {
			prompts.clear()
			const all: PromptDefinition[] = []
			for (const { id, source } of sources) {
				let listed: PromptDefinition[]
				try {
					listed = (await source.listPrompts?.()) ?? []
				} catch (error) {
					options.onSourceError?.(id, error)
					continue
				}
				for (const prompt of listed) {
					const name = unique(prompts, id, prompt.name)
					prompts.set(name, { source, name: prompt.name })
					all.push({ ...prompt, name })
				}
			}
			return all
		},

		async getPrompt(name, args) {
			const target = prompts.get(name)
			if (!target?.source.getPrompt) throw new Error(`${name} is not available.`)
			return target.source.getPrompt(target.name, args)
		},

		async close() {
			await Promise.allSettled(sources.map(({ source }) => source.close()))
		},
	}
}

const DESTRUCTIVE_NAME = /(^|_)(delete|remove|archive|destroy|drop|purge|erase)(_|$)/i

/** Off unless the person turns it on: small models pick the wrong tool, and these cannot be undone. */
export function isDestructiveTool(tool: ToolDefinition): boolean {
	return tool.annotations?.destructive === true || DESTRUCTIVE_NAME.test(tool.name)
}

/** The same source, showing only the tools the predicate keeps. A hidden tool cannot be called. */
export function filterToolSource(
	source: ToolSource,
	keep: (tool: ToolDefinition) => boolean,
): ToolSource {
	const visible = new Set<string>()
	return {
		...source,
		async listTools() {
			const tools = (await source.listTools()).filter(keep)
			visible.clear()
			for (const tool of tools) visible.add(tool.name)
			return tools
		},
		async callTool(name, args) {
			if (!visible.has(name)) return { text: `${name} is not available.`, isError: true }
			return source.callTool(name, args)
		},
		listPrompts: source.listPrompts?.bind(source),
		getPrompt: source.getPrompt?.bind(source),
		close: () => source.close(),
	}
}
