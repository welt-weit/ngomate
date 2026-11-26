import type { ChatMessage, ModelClient } from '@ngomate/core'

/**
 * Taking out who a conversation is about before it leaves this computer: each name, email address or
 * phone number is swapped for a stand-in such as `[PERSON_1]` in everything the model server or a
 * connector gets, and put back in the answer shown here. The table of who is who never leaves.
 *
 * What is found is only ever offered: email addresses and phone numbers are found by their shape, names
 * only when the person adds them. Nothing here can see a role and a place that identify someone.
 */

export type IdentifierKind = 'name' | 'email' | 'phone'

/** Something in the text that may say who someone is. */
export type Identifier = { text: string; kind: IdentifierKind }

/** One real value and what goes out instead. */
export type StandIn = { real: string; stand: string }

const EMAIL = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.\p{L}{2,}/gu
const DATE = /^\d{1,2}[./-]\d{1,2}[./-]\d{2,4}$/
// Bounded, so a long run of digits and spaces cannot make the search slow, and never ending where
// more of the same number follows: a part of a number found would leave the rest of it unswapped.
const PHONE = /(?:\+|\b0)[\d\s().\/-]{7,40}\d(?![\s().\/-]*\d)/g

const LABEL: Record<IdentifierKind, string> = { name: 'PERSON', email: 'EMAIL', phone: 'PHONE' }

/** Email addresses and phone numbers (8 digits or more) in some texts, each once. */
export function findIdentifiers(texts: string[]): Identifier[] {
	const found = new Map<string, Identifier>()
	for (const text of texts) {
		// Only words holding an @ are searched: the pattern is slow over a long run of letters without one.
		for (const word of text.split(/\s+/))
			if (word.includes('@') && word.length <= 320)
				for (const match of word.matchAll(EMAIL))
					found.set(match[0], { text: match[0], kind: 'email' })
		for (const match of text.matchAll(PHONE)) {
			const phone = match[0].trim()
			// A date such as 01.12.2026 has the same shape; swapping it would hide a deadline.
			if (phone.replace(/\D/g, '').length >= 8 && !DATE.test(phone))
				found.set(phone, { text: phone, kind: 'phone' })
		}
	}
	return [...found.values()]
}

/** The table with stand-ins added for what is not in it yet, numbered on from what is. */
export function addStandIns(table: StandIn[], take: Identifier[]): StandIn[] {
	const next = [...table]
	for (const each of take) {
		const real = each.text.trim()
		if (!real || next.some((known) => known.real === real)) continue
		const label = LABEL[each.kind]
		const count = next.filter((known) => known.stand.startsWith(`[${label}_`)).length
		next.push({ real, stand: `[${label}_${count + 1}]` })
	}
	return next
}

const literal = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Replaces every value in a text in one pass, so a replacement is never matched again, longest first,
 * so a name inside an email address is not split.
 */
function swap(
	text: string,
	pairs: [string, string][],
	options: { wholeWords: boolean; anyCase: boolean },
): string {
	if (!pairs.length) return text
	const to = new Map(
		pairs.map(([from, into]) => [options.anyCase ? from.toLowerCase() : from, into]),
	)
	const alternatives = [...pairs]
		.sort((a, b) => b[0].length - a[0].length)
		.map(([from]) => literal(from))
		.join('|')
	const pattern = options.wholeWords
		? `(?<![\\p{L}\\p{N}])(?:${alternatives})(?![\\p{L}\\p{N}])`
		: `(?:${alternatives})`
	return text.replace(
		new RegExp(pattern, options.anyCase ? 'giu' : 'gu'),
		(found) => to.get(options.anyCase ? found.toLowerCase() : found) ?? found,
	)
}

/**
 * What leaves: every real value replaced by its stand-in, as a whole word (Ada is not taken out of
 * Canada) and in any case (ADA is).
 */
export const standIn = (text: string, table: StandIn[]) =>
	swap(
		text,
		table.map((each) => [each.real, each.stand]),
		{ wholeWords: true, anyCase: true },
	)

/** What is shown here: every stand-in the model wrote back replaced by the real value, as written. */
export const putBack = (text: string, table: StandIn[]) =>
	swap(
		text,
		table.map((each) => [each.stand, each.real]),
		{ wholeWords: false, anyCase: false },
	)

/** A tool call's arguments with every stand-in in their text put back. */
export function putBackArgs(
	args: Record<string, unknown>,
	table: StandIn[],
): Record<string, unknown> {
	return putBackValue(args, table) as Record<string, unknown>
}

/** Every string in a value, nested in lists and objects too. */
function putBackValue(value: unknown, table: StandIn[]): unknown {
	if (typeof value === 'string') return putBack(value, table)
	if (Array.isArray(value)) return value.map((each) => putBackValue(each, table))
	if (value && typeof value === 'object')
		return Object.fromEntries(
			Object.entries(value).map(([key, each]) => [key, putBackValue(each, table)]),
		)
	return value
}

function outgoing(message: ChatMessage, table: StandIn[]): ChatMessage {
	if (message.role === 'assistant')
		return {
			...message,
			content: message.content === null ? null : standIn(message.content, table),
			...(message.toolCalls
				? {
						toolCalls: message.toolCalls.map((call) => ({
							...call,
							arguments: standIn(call.arguments, table),
						})),
					}
				: {}),
		}
	return { ...message, content: standIn(message.content, table) }
}

/**
 * A model client that only ever sees stand-ins. The answer is put back as it streams, holding back a
 * piece that may be the start of a stand-in until it is whole. A tool call's arguments keep the
 * stand-ins, so a connector gets them too.
 */
export function withStandIns(client: ModelClient, table: StandIn[]): ModelClient {
	if (!table.length) return client
	return {
		async chat(request) {
			let held = ''
			const onText = request.onText
			const emit = (final: boolean) => {
				const open = held.lastIndexOf('[')
				const waiting =
					!final && open !== -1 && !held.slice(open).includes(']') && held.length - open < 24
				const ready = waiting ? held.slice(0, open) : held
				held = waiting ? held.slice(open) : ''
				if (ready) onText?.(putBack(ready, table))
			}
			let reply: Awaited<ReturnType<ModelClient['chat']>>
			try {
				reply = await client.chat({
					...request,
					messages: request.messages.map((message) => outgoing(message, table)),
					...(onText
						? {
								onText: (piece: string) => {
									held += piece
									emit(false)
								},
							}
						: {}),
				})
			} finally {
				// Stopped or failed too: what was held back still reaches the answer kept so far.
				emit(true)
			}
			return { ...reply, content: reply.content === null ? null : putBack(reply.content, table) }
		},
	}
}
