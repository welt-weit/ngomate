const LINK = /https?:\/\/[^\s"'<>()[\]{}\\]+/gi

function normalize(link: string): string {
	const trimmed = link.replace(/[.,;:!?*_]+$/, '')
	try {
		const url = new URL(trimmed)
		url.hash = ''
		return url.href.replace(/\/$/, '')
	} catch {
		return trimmed
	}
}

/** Every web address written in the text, without trailing punctuation or a fragment. */
export function extractLinks(text: string): string[] {
	return [...new Set((text.match(LINK) ?? []).map(normalize))]
}

/** Links that appear in none of the sources. A shortened or edited address counts as not appearing. */
export function findUnsourcedLinks(links: string[], sources: string[]): string[] {
	const known = new Set(extractLinks(sources.join('\n')))
	return links.filter((link) => !known.has(link))
}
