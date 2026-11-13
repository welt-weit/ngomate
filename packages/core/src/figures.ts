/**
 * Small models copy figures from a person's material and attach them to the wrong thing: 14 schools
 * where the notes say 9, 24 tanks where they say 20. This finds each figure in an answer, with the word
 * it counts, and compares it with the material, so the person is shown where to look.
 */

export type FigureProblem = {
	/** The figure as the answer writes it, such as "14 schools". */
	figure: string
	/** `different`: the material has this thing with other numbers. `missing`: the number is nowhere in it. */
	problem: 'different' | 'missing'
	/** What the material says about the same thing, for `different`. */
	material?: string[]
}

/** `units`: up to two words that may name what is counted, as in "20 rainwater tanks". */
type Figure = { value: string; written: string; units: string[] }

// A number with optional thousands separators and decimals, and a percent sign or a currency in front.
// Not part of a date, a time, a version or an id.
const NUMBER =
	/(?<![\w.,/:-])([$€£]\s?)?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?(\s?%)?(?![\w/-]|[.,:]\d)/g
// "41 of 62 schools" counts schools, as does "41 schools".
const OF = /^\s+(?:out\s+)?of\s+[$€£]?\d[\d,.]*\s+([a-z][a-z-]*)/i
const WORDS = /^\s+([a-z][a-z-]*)(?:\s+([a-z][a-z-]*))?/i
// Words after a number that say nothing about what is counted.
const NOT_A_UNIT = new Set(
	'a an and are as at be but by for from had has have in into is it its of on or per than that the then these this those to was were will with'.split(
		' ',
	),
)
const MAX_SHOWN = 3

/** Singular and lower case, so "Schools" and "school" match. */
function unitOf(word: string): string {
	const lower = word.toLowerCase()
	if (lower.endsWith('ies') && lower.length > 4) return `${lower.slice(0, -3)}y`
	if (lower.endsWith('ses') || lower.endsWith('xes')) return lower.slice(0, -2)
	if (lower.endsWith('s') && !lower.endsWith('ss') && lower.length > 3) return lower.slice(0, -1)
	return lower
}

/** Each figure in the text, with the words that may say what it counts. Years are left out. */
export function extractFigures(text: string): Figure[] {
	const figures: Figure[] = []
	for (const match of text.matchAll(NUMBER)) {
		const [whole, currency, digits, decimals, percent] = match
		const value = `${(digits as string).replace(/,/g, '')}${decimals ? `.${decimals}` : ''}`
		const year = /^\d{4}$/.test(value) && Number(value) >= 1900 && Number(value) <= 2100
		if (year && !currency && !percent) continue
		if (percent) {
			figures.push({ value, written: whole.replace(/\s+/g, ''), units: ['%'] })
			continue
		}
		const end = (match.index ?? 0) + whole.length
		const after = text.slice(end, end + 60)
		const of = OF.exec(after)
		const words = of ? null : WORDS.exec(after)
		// A second word only after one that is not already a plural thing: "20 rainwater tanks" and
		// "2 million people" read on, "62 schools got" stops at schools.
		const first = of?.[1] ?? words?.[1]
		const units: string[] = []
		let written = whole
		if (first && !NOT_A_UNIT.has(first.toLowerCase())) {
			units.push(unitOf(first))
			written += of ? of[0] : ` ${first}`
			const second = words?.[2]
			if (second && !/s$/i.test(first) && !NOT_A_UNIT.has(second.toLowerCase())) {
				units.push(unitOf(second))
				written += ` ${second}`
			}
		}
		figures.push({ value, written: written.replace(/\s+/g, ' ').trim(), units })
	}
	return figures
}

/**
 * Figures in an answer that the material does not back. A figure is backed when the material has the
 * same number counting one of the same words. A single digit counting nothing is left alone, because
 * "step 2" or "question 3" would only add noise.
 */
export function checkFigures(answer: string, material: string[]): FigureProblem[] {
	const known = extractFigures(material.join('\n'))
	const values = new Set(known.map((figure) => figure.value))
	const pairs = new Set(
		known.flatMap((figure) => figure.units.map((unit) => `${figure.value} ${unit}`)),
	)
	const byUnit = new Map<string, string[]>()
	for (const figure of known) {
		for (const unit of figure.units) {
			const shown = byUnit.get(unit) ?? []
			if (!shown.includes(figure.written)) shown.push(figure.written)
			byUnit.set(unit, shown)
		}
	}
	const problems = new Map<string, FigureProblem>()
	for (const figure of extractFigures(answer)) {
		if (!figure.units.length && figure.value.length < 2) continue
		if (problems.has(figure.written)) continue
		if (figure.units.some((unit) => pairs.has(`${figure.value} ${unit}`))) continue
		const other = [...new Set(figure.units.flatMap((unit) => byUnit.get(unit) ?? []))]
		if (other.length) {
			const shown = other.slice(0, MAX_SHOWN)
			problems.set(figure.written, {
				figure: figure.written,
				problem: 'different',
				material: shown,
			})
		} else if (!values.has(figure.value)) {
			problems.set(figure.written, { figure: figure.written, problem: 'missing' })
		}
	}
	return [...problems.values()]
}
