/**
 * An AI-use policy: which data may go where, by how sensitive it is. One JSON document, the same format a
 * team or a platform can keep; NGOmate reads the parts about this computer and keeps the rest unchanged.
 * The JSON Schema is `schema/ai-use-policy.schema.json`.
 *
 * Format 1 (`schemaVersion: 1`) is fixed: fields may be added, never renamed, dropped or given a new
 * meaning. The classes and actions do not change either, since a reader refuses one it does not know.
 * Anything else is format 2, which this app refuses until it reads both.
 */

/** How sensitive data is, least to most. An organisation may rename them for display, never redefine them. */
export const DATA_CLASSES = [
	'public',
	'internal',
	'confidential',
	'personal',
	'sensitive_personal',
	'secret',
] as const
export type DataClass = (typeof DATA_CLASSES)[number]

/** What happens to data of a class at a place it would leave by, least to most restrictive. */
export const POLICY_ACTIONS = [
	'allow',
	'allow_with_review',
	'redact',
	'local_only',
	'block',
] as const
export type PolicyAction = (typeof POLICY_ACTIONS)[number]

/**
 * Where data goes from this computer: the local model, a model server the policy approves, or anything
 * else that leaves it (any other model server, a connector).
 */
export type Egress = 'desktop_local' | 'desktop_approved' | 'desktop_remote'

export type PolicyTemplate = 'open' | 'standard' | 'strict'

export type PolicyFile = {
	schemaVersion: 1
	template?: PolicyTemplate | 'custom'
	/** Goes up with every change, so a record of use names the rules it applied. */
	version: number
	/**
	 * What each class may do at each place. A place left out follows `desktop_remote` (as a platform reading
	 * this file does for its own places); `desktop_remote` and `desktop_local` left out allow.
	 */
	classes: Partial<Record<DataClass, Partial<Record<string, PolicyAction>>>>
	/** `observe` records what the policy would do and stops nothing. */
	rules?: { mode: 'observe' | 'enforce' }
	/** When the policy should be read again, as a date. */
	reviewBy?: string
	/**
	 * Model servers trusted more than others (an organisation's own, or one that keeps nothing), by
	 * address. A conversation to one of them follows `desktop_approved`, which falls back to
	 * `desktop_remote` where a class does not say.
	 */
	approvedServers?: string[]
	/** Everything else in the file (the platform's columns, providers, controls), kept as it was. */
	[key: string]: unknown
}

const rank = <T>(list: readonly T[], value: T) => list.indexOf(value)

/** The stricter of two actions. */
export function stricter(a: PolicyAction, b: PolicyAction): PolicyAction {
	return rank(POLICY_ACTIONS, a) >= rank(POLICY_ACTIONS, b) ? a : b
}

/** The most sensitive of some classes; `public` when there are none. */
export function mostSensitive(classes: Iterable<DataClass>): DataClass {
	let top: DataClass = 'public'
	for (const each of classes) if (rank(DATA_CLASSES, each) > rank(DATA_CLASSES, top)) top = each
	return top
}

/** Secrets never leave, and stay off the model altogether, in every template. */
const LOCAL: PolicyAction = 'allow'
type Leaving = [confidential: PolicyAction, personal: PolicyAction, sensitive: PolicyAction]
const remote = (
	[confidential, personal, sensitive]: Leaving,
	approved: Leaving = [confidential, personal, sensitive],
): PolicyFile['classes'] => ({
	public: { desktop_local: LOCAL, desktop_remote: 'allow' },
	internal: { desktop_local: LOCAL, desktop_remote: 'allow' },
	confidential: {
		desktop_local: LOCAL,
		desktop_approved: approved[0],
		desktop_remote: confidential,
	},
	personal: { desktop_local: LOCAL, desktop_approved: approved[1], desktop_remote: personal },
	sensitive_personal: {
		desktop_local: LOCAL,
		desktop_approved: approved[2],
		desktop_remote: sensitive,
	},
	secret: { desktop_local: 'block', desktop_remote: 'block' },
})

/**
 * The three templates on this computer, as the platform's design table sets them. An approved model
 * server may read personal data under Open and Standard; under Strict it is treated like any other.
 */
export const POLICY_TEMPLATES: Record<PolicyTemplate, PolicyFile['classes']> = {
	open: remote(['allow', 'redact', 'redact'], ['allow', 'allow', 'redact']),
	standard: remote(['allow', 'local_only', 'local_only'], ['allow', 'allow', 'local_only']),
	strict: remote(['local_only', 'local_only', 'local_only']),
}

/** A model server's address as policies compare it: scheme, host and path, no trailing slash. */
export function serverAddress(url: string): string | null {
	try {
		const parsed = new URL(url)
		return `${parsed.protocol}//${parsed.host}${parsed.pathname.replace(/\/+$/, '')}`.toLowerCase()
	} catch {
		return null
	}
}

/** Whether a policy approves a model server. */
export function approvesServer(policy: PolicyFile, url: string): boolean {
	const address = serverAddress(url)
	return Boolean(address && policy.approvedServers?.some((each) => serverAddress(each) === address))
}

/** A new policy from a template, watching before it stops anything. */
export function policyFromTemplate(template: PolicyTemplate, version = 1): PolicyFile {
	return {
		schemaVersion: 1,
		template,
		version,
		classes: structuredClone(POLICY_TEMPLATES[template]),
		rules: { mode: 'observe' },
	}
}

/**
 * What a policy does with data of a class at a place. On this computer nothing is taken out
 * automatically (guessing what is personal may only ever warn), so `redact` asks the person, once in a
 * conversation, to remove names and what else identifies people, and to confirm before it leaves.
 */
export function decide(policy: PolicyFile, dataClass: DataClass, egress: Egress): PolicyAction {
	const cell = policy.classes[dataClass]?.[egress]
	if (cell === undefined && egress === 'desktop_approved')
		return decide(policy, dataClass, 'desktop_remote')
	return cell ?? 'allow'
}

/** Two policies as one, for a person in a team: for every cell the stricter action wins. */
export function combinePolicies(own: PolicyFile, ceiling: PolicyFile): PolicyFile {
	const classes: PolicyFile['classes'] = {}
	for (const dataClass of DATA_CLASSES) {
		const cells: Partial<Record<string, PolicyAction>> = {}
		for (const egress of ['desktop_local', 'desktop_approved', 'desktop_remote'] as const)
			cells[egress] = stricter(decide(own, dataClass, egress), decide(ceiling, dataClass, egress))
		classes[dataClass] = cells
	}
	const enforce = own.rules?.mode === 'enforce' || ceiling.rules?.mode === 'enforce'
	// The ceiling's list is the most that is approved; one's own list, when it has one, narrows it.
	const approved = (ceiling.approvedServers ?? []).filter(
		(each) =>
			!own.approvedServers ||
			own.approvedServers.some((mine) => serverAddress(mine) === serverAddress(each)),
	)
	return {
		...own,
		template: 'custom',
		classes,
		rules: { mode: enforce ? 'enforce' : 'observe' },
		approvedServers: approved,
	}
}

/** Reads a policy file. Throws, saying what is wrong, rather than guess at a rule. */
export function parsePolicy(text: string): PolicyFile {
	let value: unknown
	try {
		value = JSON.parse(text)
	} catch {
		throw new Error('The policy is not valid JSON.')
	}
	if (!value || typeof value !== 'object' || Array.isArray(value))
		throw new Error('The policy must be a JSON object.')
	const file = value as Record<string, unknown>
	if (file.schemaVersion !== 1)
		throw new Error('This policy is in a format this app does not know.')
	if (typeof file.version !== 'number' || !Number.isInteger(file.version) || file.version < 1)
		throw new Error('The policy needs a version, a whole number from 1.')
	const classes = file.classes
	if (!classes || typeof classes !== 'object' || Array.isArray(classes))
		throw new Error('The policy needs its classes.')
	for (const [dataClass, cells] of Object.entries(classes)) {
		if (!(DATA_CLASSES as readonly string[]).includes(dataClass))
			throw new Error(`"${dataClass}" is not a class this app knows.`)
		if (!cells || typeof cells !== 'object' || Array.isArray(cells))
			throw new Error(`The rules for ${dataClass} must be an object.`)
		for (const [egress, action] of Object.entries(cells)) {
			if (!(POLICY_ACTIONS as readonly unknown[]).includes(action))
				throw new Error(`"${String(action)}" for ${dataClass} at ${egress} is not an action.`)
		}
	}
	const servers = file.approvedServers
	if (
		servers !== undefined &&
		(!Array.isArray(servers) ||
			servers.some((each) => typeof each !== 'string' || !serverAddress(each)))
	)
		throw new Error('approvedServers must be a list of web addresses.')
	const mode = (file.rules as { mode?: unknown } | undefined)?.mode
	if (file.rules !== undefined && mode !== 'observe' && mode !== 'enforce')
		throw new Error('rules.mode must be "observe" or "enforce".')
	return file as PolicyFile
}

/**
 * A policy someone else sets as the least this person keeps to (a team's, an organisation's), or
 * Strict and kept to when it cannot be read: a ceiling that fails must fail safe.
 */
export function ceilingPolicy(text: string): PolicyFile {
	try {
		return parsePolicy(text)
	} catch {
		return { ...policyFromTemplate('strict'), template: 'custom', rules: { mode: 'enforce' } }
	}
}

/** What a policy does at a place, by class, in words: for the settings and the record of use. */
export const ACTION_WORDS: Record<PolicyAction, string> = {
	allow: 'may leave',
	allow_with_review: 'leaves after you confirm',
	redact: 'leaves after you take out who it is about, and confirm',
	local_only: 'stays on the local model',
	block: 'never used',
}

export const CLASS_WORDS: Record<DataClass, string> = {
	public: 'Public',
	internal: 'Internal',
	confidential: 'Confidential',
	personal: 'Personal data',
	sensitive_personal: 'Sensitive personal data',
	secret: 'Secrets',
}
