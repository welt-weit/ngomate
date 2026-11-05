import type { ToolDefinition } from './model.js'

const DESCRIPTION_CHARS = 200
const FIELD_DESCRIPTION_CHARS = 60

function firstSentences(text: string, maxChars: number): string {
	const clean = text.replace(/\s+/g, ' ').trim()
	if (clean.length <= maxChars) return clean
	const cut = clean.slice(0, maxChars)
	const end = cut.lastIndexOf('. ')
	return end > maxChars / 3 ? cut.slice(0, end + 1) : `${cut.slice(0, cut.lastIndexOf(' '))}…`
}

/** Only what a model needs to call the tool. Schema housekeeping costs tokens on every message. */
function compactSchema(schema: unknown): unknown {
	if (Array.isArray(schema)) return schema.map(compactSchema)
	if (!schema || typeof schema !== 'object') return schema
	const compact: Record<string, unknown> = {}
	for (const [key, value] of Object.entries(schema)) {
		if (['$schema', 'additionalProperties', 'title', 'examples', '$id'].includes(key)) continue
		if (key === 'description' && typeof value === 'string') {
			compact[key] = firstSentences(value, FIELD_DESCRIPTION_CHARS)
		} else if (key === 'properties' && value && typeof value === 'object') {
			compact[key] = Object.fromEntries(
				Object.entries(value).map(([name, field]) => [name, compactSchema(field)]),
			)
		} else {
			compact[key] = compactSchema(value)
		}
	}
	return compact
}

/** The same tool in fewer tokens. Names, types and required fields stay exactly as they were. */
export function compactTool(tool: ToolDefinition): ToolDefinition {
	return {
		...tool,
		description: firstSentences(tool.description, DESCRIPTION_CHARS),
		inputSchema: compactSchema(tool.inputSchema) as Record<string, unknown>,
	}
}

const STOP_WORDS = new Set(
	'about after all also and one two first second third any are can for from get give has have her his how into its let like make may more most need not now our out please she some than that the their them then there these they this too use very was what when where which who will with would you your'.split(
		' ',
	),
)

/** Words meaning much the same in this work, so a person need not guess a tool's wording. */
const RELATED_WORDS = [
	['funding', 'fund', 'grant', 'donor', 'funder', 'money', 'call', 'opportunity', 'finance'],
	['task', 'deliverable', 'todo', 'milestone'],
	['note', 'memory', 'remember', 'save'],
	['page', 'wiki', 'document', 'doc'],
	['project', 'workspace'],
	['search', 'find', 'look', 'lookup'],
]

/** The meaningful words of a text, with the related words of this field unless told not to. */
export function wordsOf(text: string, withRelated = true): Set<string> {
	const words = new Set<string>()
	for (const raw of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
		const word = raw.length > 3 ? raw.replace(/(ies|s)$/, (end) => (end === 'ies' ? 'y' : '')) : raw
		if (word.length < 3 || STOP_WORDS.has(word)) continue
		words.add(word)
		if (!withRelated) continue
		for (const group of RELATED_WORDS) {
			if (group.includes(word)) for (const related of group) words.add(related)
		}
	}
	return words
}

function relevance(tool: ToolDefinition, wanted: Set<string>): number {
	let score = 0
	for (const word of wordsOf(tool.name.replace(/_/g, ' '))) if (wanted.has(word)) score += 3
	for (const word of wordsOf(tool.description)) if (wanted.has(word)) score += 1
	return score
}

/** Beyond this a small model chooses worse, and each one costs tokens on every message. */
const MAX_TOOLS = 6

export type ToolChoice = {
	tools: ToolDefinition[]
	/** Relevant to the request, but there was no room for them. */
	didNotFit: string[]
}

/**
 * The tools worth sending with this request, within `maxChars`. Tool descriptions go with every message
 * and can take more room than the conversation. Nothing relevant means the wording may simply be in
 * another language, so read-only tools are offered, as far as they fit, rather than none.
 */
export function chooseTools(
	tools: ToolDefinition[],
	request: string,
	maxChars: number,
	usedBefore: string[] = [],
): ToolChoice {
	const wanted = wordsOf(request)
	const scored = tools.map((tool, order) => ({
		tool: compactTool(tool),
		order,
		score: relevance(tool, wanted) + (usedBefore.includes(tool.name) ? 100 : 0),
	}))
	const anyRelevant = scored.some((entry) => entry.score > 0)
	const candidates = scored
		.filter((entry) => (anyRelevant ? entry.score > 0 : entry.tool.annotations?.readOnly === true))
		.sort((a, b) => {
			const aRead = a.tool.annotations?.readOnly === true ? 1 : 0
			const bRead = b.tool.annotations?.readOnly === true ? 1 : 0
			return b.score - a.score || bRead - aRead || a.order - b.order
		})

	const chosen: typeof candidates = []
	const didNotFit: string[] = []
	let used = 0
	for (const entry of candidates) {
		if (chosen.length === MAX_TOOLS) break
		const size = JSON.stringify(entry.tool).length
		if (used + size > maxChars) {
			if (anyRelevant) didNotFit.push(entry.tool.name)
			continue
		}
		used += size
		chosen.push(entry)
	}
	// In the order the source gave, so the same tools make the same prompt and a model can reuse its work.
	return { tools: chosen.sort((a, b) => a.order - b.order).map((entry) => entry.tool), didNotFit }
}
