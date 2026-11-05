import { wordsOf } from './toolChoice.js'

const PASSAGE_CHARS = 900
const OMITTED = '\n\n[…]\n\n'
const WHOLE_WORDS =
	/^(summar|overview|outline|gist|recap|zusammenfass|überblick|resumen|résumé|résumer|synthèse|synthesi[sz]e)/
const WHOLE_PHRASES = /\b(main|key) points?\b/

/**
 * By words and not by a pattern with `\b`, which treats é and Ü as breaks between words. Not with
 * lookbehind either: the WebKit of older macOS versions cannot even parse it.
 */
function wantsTheWhole(request: string): boolean {
	const lower = request.toLowerCase()
	return (
		WHOLE_PHRASES.test(lower) ||
		lower.split(/[^\p{L}\p{N}]+/u).some((word) => WHOLE_WORDS.test(word))
	)
}

/** Splits text into pieces of about one screen, at paragraphs where it can. */
export function splitPassages(text: string, size = PASSAGE_CHARS): string[] {
	const passages: string[] = []
	let current = ''
	const flush = () => {
		if (current.trim()) passages.push(current.trim())
		current = ''
	}
	for (const paragraph of text.split(/\n\s*\n/)) {
		if (current && current.length + paragraph.length > size) flush()
		if (paragraph.length <= size) {
			current += `${paragraph}\n\n`
			continue
		}
		// Extracted PDF text can be one long paragraph, so cut where a sentence or word ends, or a fact is lost.
		let rest = paragraph
		while (rest.length > size) {
			const part = rest.slice(0, size)
			const end = Math.max(part.lastIndexOf('. ') + 1, part.lastIndexOf('\n'))
			const cut = end > size / 2 ? end : Math.max(part.lastIndexOf(' '), size / 2)
			current = rest.slice(0, cut)
			flush()
			rest = rest.slice(cut).trimStart()
		}
		current = rest
		flush()
	}
	flush()
	return passages
}

export type DocumentRead = {
	text: string
	/** How much of the document was sent. */
	mode: 'whole' | 'relevant' | 'overview'
}

/** A little of every passage, so a summary can speak to the whole document. */
function overview(passages: string[], maxChars: number): string {
	const smallest = 120 + OMITTED.length
	// A very long document has more passages than there is room for, so take them evenly from end to end.
	const room = Math.max(1, Math.floor(maxChars / smallest))
	const taken =
		passages.length <= room
			? passages
			: Array.from(
					{ length: room },
					(_, index) => passages[Math.floor((index * passages.length) / room)] as string,
				)
	const each = Math.floor(maxChars / taken.length) - OMITTED.length
	return taken
		.map((passage) => {
			const cut = passage.slice(0, each)
			const end = cut.lastIndexOf('. ')
			return passage.length <= each ? passage : end > each / 3 ? cut.slice(0, end + 1) : cut
		})
		.join(OMITTED)
}

/**
 * What of a long document to send for this request. Reading costs time and tokens for every character,
 * so a question gets the passages that share its words, the rarest words counting most. A request for
 * the whole, or one whose words appear nowhere, gets a little of every passage.
 */
export function readDocument(text: string, request: string, maxChars: number): DocumentRead {
	if (text.length <= maxChars) return { text, mode: 'whole' }
	const passages = splitPassages(text)
	const wanted = wordsOf(request)
	if (wantsTheWhole(request) || wanted.size === 0) {
		return { text: overview(passages, maxChars), mode: 'overview' }
	}

	const inPassage = passages.map((passage) => wordsOf(passage, false))
	const asked = wordsOf(request, false)
	const rarity = new Map<string, number>()
	for (const word of wanted) {
		const found = inPassage.filter((words) => words.has(word)).length
		// A related word helps, but never counts like the word the person actually used.
		if (found) rarity.set(word, Math.log(1 + passages.length / found) * (asked.has(word) ? 1 : 0.3))
	}
	const scored = inPassage.map((words, index) => {
		let score = 0
		for (const [word, weight] of rarity) if (words.has(word)) score += weight
		return { index, score }
	})
	if (scored.every((entry) => entry.score === 0)) {
		return { text: overview(passages, maxChars), mode: 'overview' }
	}

	// The opening says what the document is, whatever the question.
	const chosen = new Set<number>([0])
	let used = passages[0]?.length ?? 0
	for (const { index, score } of [...scored].sort((a, b) => b.score - a.score)) {
		if (score === 0) break
		const size = (passages[index] as string).length + OMITTED.length
		if (chosen.has(index) || used + size > maxChars) continue
		chosen.add(index)
		used += size
	}
	const parts = [...chosen].sort((a, b) => a - b).map((index) => passages[index] as string)
	return { text: parts.join(OMITTED), mode: 'relevant' }
}
