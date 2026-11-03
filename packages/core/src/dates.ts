const MONTHS = [
	'january',
	'february',
	'march',
	'april',
	'may',
	'june',
	'july',
	'august',
	'september',
	'october',
	'november',
	'december',
]
const MONTH = `(${MONTHS.join('|')}|${MONTHS.map((month) => month.slice(0, 3)).join('|')})\\.?`

const ISO_DATE = /\b(\d{4})-(\d{2})-(\d{2})/g
const DAY_MONTH_YEAR = new RegExp(
	`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+${MONTH},?\\s+(\\d{4})\\b`,
	'gi',
)
const MONTH_DAY_YEAR = new RegExp(
	`\\b${MONTH}\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b`,
	'gi',
)

function isoDate(year: string, month: number, day: string): string {
	return `${year}-${String(month).padStart(2, '0')}-${day.padStart(2, '0')}`
}

function monthNumber(name: string): number {
	return MONTHS.findIndex((month) => month.startsWith(name.toLowerCase().slice(0, 3))) + 1
}

/** Every calendar date written in the text, as YYYY-MM-DD. */
export function extractDates(text: string): Set<string> {
	const dates = new Set<string>()
	for (const [, year, month, day] of text.matchAll(ISO_DATE)) {
		dates.add(isoDate(year as string, Number(month), day as string))
	}
	for (const [, day, month, year] of text.matchAll(DAY_MONTH_YEAR)) {
		dates.add(isoDate(year as string, monthNumber(month as string), day as string))
	}
	for (const [, month, day, year] of text.matchAll(MONTH_DAY_YEAR)) {
		dates.add(isoDate(year as string, monthNumber(month as string), day as string))
	}
	return dates
}

function collectStrings(value: unknown, strings: string[]): void {
	if (typeof value === 'string') strings.push(value)
	else if (Array.isArray(value)) for (const item of value) collectStrings(item, strings)
	else if (value && typeof value === 'object') {
		for (const item of Object.values(value)) collectStrings(item, strings)
	}
}

/** Dates in a write's arguments that appear in none of the sources. */
export function findUnsourcedDates(args: Record<string, unknown>, sources: string[]): string[] {
	const strings: string[] = []
	collectStrings(args, strings)
	const known = extractDates(sources.join('\n'))
	return [...extractDates(strings.join('\n'))].filter((date) => !known.has(date))
}
