import {
	ACTION_WORDS,
	CLASS_WORDS,
	DATA_CLASSES,
	type DataClass,
	type PolicyAction,
	type PolicyFile,
	approvesServer,
	combinePolicies,
	decide,
	mostSensitive,
	policyFromTemplate,
	stricter,
} from '@ngomate/core'
import type { ModelChoice, NgomateHost, PolicyLabels, PolicyNotice, ReviewedFor } from './host.js'
import { findIdentifiers } from './standIns.js'

/**
 * Whether the model runs on this computer: the bundled one, or a model server on this computer (Ollama, a
 * llama.cpp server started by hand). Anything else is somewhere the conversation leaves to.
 */
export function onThisComputer(model: ModelChoice | null | undefined): boolean {
	if (!model || model.kind === 'local') return true
	try {
		const host = new URL(model.baseUrl).hostname.replace(/^\[|\]$/g, '')
		return (
			host === 'localhost' || host.endsWith('.localhost') || host === '127.0.0.1' || host === '::1'
		)
	} catch {
		return false
	}
}

/** A label, or internal: what is not labelled counts as ordinary working material. */
export const labelled = (label: DataClass | undefined): DataClass => label ?? 'internal'

/** What a document counts as: its own label, else the one for documents, else internal. */
export const documentClass = (document: { dataClass?: DataClass }, labels?: PolicyLabels) =>
	document.dataClass ?? labelled(labels?.documents)

/**
 * What the policy does about one answer: the conversation reaching its model, and what the conversation
 * already held reaching a connector. A connector's own results going back to it are not leaving. Null when
 * nothing is held back, or there is no policy.
 */
export function policyNotice(
	policy: PolicyFile | undefined,
	check: {
		/** Everything the model read for this answer, and where it runs. */
		model: { classes: DataClass[]; local: boolean; approved?: boolean }
		/** What the conversation held when it called a connector; missing when it called none. */
		connector?: DataClass[]
	},
): PolicyNotice | null {
	if (!policy) return null
	const found: { action: PolicyAction; dataClass: DataClass; where: 'model' | 'connector' }[] = []
	const modelClass = mostSensitive(check.model.classes)
	const forModel = decide(
		policy,
		modelClass,
		check.model.local
			? 'desktop_local'
			: check.model.approved
				? 'desktop_approved'
				: 'desktop_remote',
	)
	if (forModel !== 'allow') found.push({ action: forModel, dataClass: modelClass, where: 'model' })
	if (check.connector) {
		const sent = mostSensitive(check.connector)
		const forConnector = decide(policy, sent, 'desktop_remote')
		if (forConnector !== 'allow')
			found.push({ action: forConnector, dataClass: sent, where: 'connector' })
	}
	if (!found.length) return null
	const action = found.map((each) => each.action).reduce(stricter)
	return {
		action,
		dataClass: mostSensitive(found.map((each) => each.dataClass)),
		where: found.map((each) => each.where),
		observed: policy.rules?.mode !== 'enforce',
		...(policy.template ? { template: policy.template } : {}),
	}
}

const TEMPLATE_WORDS: Record<string, string> = {
	open: 'Open',
	standard: 'Standard',
	strict: 'Strict',
	custom: 'own',
}

/** The line under an answer the person chose to keep on this computer. */
export function keptHereText(kept: { model?: string }): string {
	return kept.model
		? `Kept on this computer, as you chose: answered by ${kept.model} instead of your model server, which may answer less well, and no connector was called.`
		: 'Kept on this computer, as you chose: no connector was called.'
}

/** The line under an answer, in plain words: what the policy did, or would have done. */
export function policyNoticeText(notice: PolicyNotice): string {
	const name = TEMPLATE_WORDS[notice.template ?? 'custom'] ?? 'own'
	const under = `Under your ${name} policy`
	const held = `it holds ${CLASS_WORDS[notice.dataClass].toLowerCase()}`
	const would = notice.observed
	const model = notice.where.includes('model')
	const connector = notice.where.includes('connector')
	const what = [model ? 'the model server' : '', connector ? 'a connector' : '']
		.filter(Boolean)
		.join(' and ')
	if (notice.action === 'block')
		return `${under} this conversation ${would ? 'would have been' : 'was'} kept from ${what}: ${held}, which it never uses.`
	if (notice.action === 'allow_with_review')
		return `${under} you ${would ? 'would have been' : 'were'} asked before it went to ${what}: ${held}.`
	if (notice.action === 'redact')
		return `${under} you ${would ? 'would have been' : 'were'} asked to take out names and what else identifies people before it went to ${what}: ${held}.`
	const stayed = model
		? `${would ? 'would have stayed' : 'stayed'} on the local model instead of reaching the model server${connector ? ', and called no connector' : ''}`
		: `${would ? 'would have called' : 'called'} no connector`
	const by = notice.localModel
		? ` It was answered by ${notice.localModel} on this computer, which may answer less well than your model server.`
		: ''
	return `${under} this conversation ${stayed}: ${held}.${by}`
}

/** One line of the record of use: what was held back, never what the conversation said. */
export type PolicyRecordEntry = {
	at: string
	/** A chat, a ready-made task, or a job. */
	feature: 'chat' | 'task' | 'job'
	where: ('model' | 'connector')[]
	dataClass: DataClass
	action: PolicyAction
	observed: boolean
	template?: string
	version: number
}

/** How many entries the record keeps: the newest. */
export const RECORD_LIMIT = 1000

export async function readPolicyRecord(host: NgomateHost): Promise<PolicyRecordEntry[]> {
	const text = await host.policyRecord?.read().catch(() => null)
	if (!text) return []
	try {
		const entries = JSON.parse(text)
		return Array.isArray(entries) ? entries : []
	} catch {
		return []
	}
}

let writing: Promise<unknown> = Promise.resolve()

/** Adds an entry, newest first. Writes one at a time, so two answers ending together both stay. */
export function recordPolicy(host: NgomateHost, entry: PolicyRecordEntry): Promise<void> {
	if (!host.policyRecord) return Promise.resolve()
	const next = writing.then(async () => {
		const entries = await readPolicyRecord(host)
		await host.policyRecord?.write(JSON.stringify([entry, ...entries].slice(0, RECORD_LIMIT)))
	})
	writing = next.catch(() => {})
	return next
}

export async function clearPolicyRecord(host: NgomateHost): Promise<void> {
	const next = writing.then(() => host.policyRecord?.write('[]'))
	writing = next.catch(() => {})
	await next
}

/**
 * The policy a person keeps to: their own, held to each ceiling (the team's, the organisation's on this
 * computer) as the least. Undefined when there is none at all.
 */
export function effectivePolicy(
	own: PolicyFile | undefined,
	...ceilings: (PolicyFile | undefined)[]
): PolicyFile | undefined {
	let policy = own
	for (const ceiling of ceilings)
		if (ceiling) policy = policy ? combinePolicies(policy, ceiling) : ceiling
	return policy
}

/** What applies when the person has not chosen: Standard, kept to. */
export const DEFAULT_POLICY: PolicyFile = {
	...policyFromTemplate('standard'),
	rules: { mode: 'enforce' },
}

/** The person's own policy: the one they chose, the default when they did not, none when turned off. */
export function ownPolicy(settings: {
	policy?: PolicyFile
	policyOff?: boolean
}): PolicyFile | undefined {
	if (settings.policyOff) return undefined
	return settings.policy ?? DEFAULT_POLICY
}

/** What a policy that is kept to decides before an answer: whether to go ahead, and how. */
export type LeavingPlan = {
	/** Not sent at all; the words say why. */
	refuse?: string
	/** Asks the person once in this conversation before anything leaves. */
	review?: PolicyNotice
	/** Answers on the model on this computer instead of the model server. */
	useLocalModel?: boolean
	/** Which connectors may be offered: none, or those whose results may reach the model. */
	connectors: 'all' | 'none' | 'allowed'
}

const goAhead: LeavingPlan = { connectors: 'all' }

/** The actions that let data leave once the person confirms: as it is, or with who it is about taken out. */
const asksFirst = (action: PolicyAction) => action === 'allow_with_review' || action === 'redact'

/**
 * Decides, before an answer, what a policy that is kept to allows: the classes the conversation holds
 * going to its model, and to connectors. A policy that only watches never changes anything.
 */
export function planLeaving(
	policy: PolicyFile | undefined,
	held: DataClass[],
	options: {
		modelLocal: boolean
		modelApproved?: boolean
		reviewed?: boolean
		/** The person chose to keep this conversation here: nothing leaves, so nothing is asked. */
		keepHere?: boolean
	},
): LeavingPlan {
	const kept: LeavingPlan = { useLocalModel: !options.modelLocal, connectors: 'none' }
	if (!policy || policy.rules?.mode !== 'enforce') return options.keepHere ? kept : goAhead
	const top = mostSensitive(held)
	const words = CLASS_WORDS[top].toLowerCase()
	if (decide(policy, top, 'desktop_local') === 'block')
		return {
			refuse: `Not sent: your AI-use policy never uses ${words}, and this conversation holds it.`,
			connectors: 'none',
		}
	if (options.keepHere) return kept
	const confirmed = (action: PolicyAction) =>
		asksFirst(action) && options.reviewed ? 'allow' : action
	// A connector is always somewhere else; the model may be a server the policy approves.
	const connector = confirmed(decide(policy, top, 'desktop_remote'))
	const model =
		!options.modelLocal && options.modelApproved
			? confirmed(decide(policy, top, 'desktop_approved'))
			: connector
	// The model on this computer is not leaving: a blocked remote cell only keeps connectors away.
	if (model === 'block' && !options.modelLocal)
		return {
			refuse: `Not sent: your AI-use policy never lets ${words} leave this computer, and this conversation holds it.`,
			connectors: 'none',
		}
	if (asksFirst(model) || asksFirst(connector)) {
		const modelAsks = !options.modelLocal && asksFirst(model)
		return {
			review: {
				action: asksFirst(model) ? model : connector,
				dataClass: top,
				where: modelAsks
					? ['model', ...(asksFirst(connector) ? (['connector'] as const) : [])]
					: ['connector'],
				observed: false,
				...(policy.template ? { template: policy.template } : {}),
			},
			connectors: 'allowed',
		}
	}
	if (model === 'local_only') return { useLocalModel: !options.modelLocal, connectors: 'none' }
	if (connector !== 'allow') return { connectors: 'none' }
	return { connectors: options.modelLocal ? 'all' : 'allowed' }
}

/** Whether a yes given earlier covers what the conversation holds now and where it goes. */
export function reviewCovers(
	given: ReviewedFor | undefined,
	held: DataClass[],
	toModelServer: boolean,
): boolean {
	if (!given) return false
	const rank = (each: DataClass) => DATA_CLASSES.indexOf(each)
	return rank(mostSensitive(held)) <= rank(given.dataClass) && (!toModelServer || given.model)
}

/** What a yes covers once given for this notice too. */
export function widerReview(given: ReviewedFor | undefined, notice: PolicyNotice): ReviewedFor {
	const rank = (each: DataClass) => DATA_CLASSES.indexOf(each)
	return {
		dataClass:
			given && rank(given.dataClass) > rank(notice.dataClass) ? given.dataClass : notice.dataClass,
		model: Boolean(given?.model) || notice.where.includes('model'),
	}
}

/** Whether data of a class may leave now: allowed, or asked first and confirmed in this conversation. */
const mayLeave = (
	policy: PolicyFile,
	dataClass: DataClass,
	reviewed: boolean,
	egress: 'desktop_approved' | 'desktop_remote' = 'desktop_remote',
) => {
	const action = decide(policy, dataClass, egress)
	return action === 'allow' || (asksFirst(action) && reviewed)
}

/** Whether a connector's results may reach the model, by the connector's label. */
export function connectorMayAnswer(
	policy: PolicyFile | undefined,
	label: DataClass,
	modelLocal: boolean,
	reviewed = false,
	/** The model is a server the policy approves. */
	modelApproved = false,
): boolean {
	if (!policy || policy.rules?.mode !== 'enforce') return true
	return (
		modelLocal ||
		mayLeave(policy, label, reviewed, modelApproved ? 'desktop_approved' : 'desktop_remote')
	)
}

/** Whether the model a person chose is a server their policy approves. */
export function modelApproved(
	policy: PolicyFile | undefined,
	model: ModelChoice | null | undefined,
) {
	return Boolean(policy && model?.kind === 'server' && approvesServer(policy, model.baseUrl))
}

/** Whether what a conversation holds now may go to a connector in a call. */
export function mayCallConnector(
	policy: PolicyFile | undefined,
	held: DataClass[],
	reviewed = false,
): boolean {
	if (!policy || policy.rules?.mode !== 'enforce') return true
	return mayLeave(policy, mostSensitive(held), reviewed)
}

/** The words a tool call gets back when the policy keeps it from a connector. */
export const CONNECTOR_REFUSED =
	'Not called: this conversation holds data your AI-use policy keeps on this computer. Answer from what you have.'

/**
 * The line above the message box: where this conversation will go and why, before anything is sent.
 * Null with no policy, or when nothing is held back. A policy that only watches says what it would do.
 */
export function composerStatus(
	policy: PolicyFile | undefined,
	held: DataClass[],
	options: { modelLocal: boolean; modelApproved?: boolean; reviewed?: boolean; keepHere?: boolean },
): string | null {
	const watching = policy?.rules?.mode !== 'enforce'
	const plan = planLeaving(policy && { ...policy, rules: { mode: 'enforce' } }, held, options)
	const words = CLASS_WORDS[mostSensitive(held)].toLowerCase()
	const where = options.modelLocal ? 'a connector' : 'the model server'
	if (options.keepHere && !(plan.refuse && !watching))
		return options.modelLocal
			? 'Kept on this computer, as you chose: no connector is called.'
			: 'Kept on this computer, as you chose: the model on this computer answers and no connector is called.'
	if (!policy) return null
	if (plan.refuse)
		return watching
			? `Watch only: your policy would not send this, as it holds ${words}.`
			: `Will not be sent: this conversation holds ${words}.`
	if (plan.review) {
		const asked =
			plan.review.action === 'redact'
				? `asked to take out who it is about before it goes to ${where}`
				: `asked before it goes to ${where}`
		return watching
			? `Watch only: you would be ${asked}, as it holds ${words}.`
			: `You will be ${asked}: it holds ${words}.`
	}
	if (plan.useLocalModel)
		return watching
			? `Watch only: this would stay on this computer, as it holds ${words}.`
			: `Stays on this computer: it holds ${words}, so the local model answers and no connector is called.`
	if (plan.connectors === 'none')
		return watching
			? `Watch only: this would call no connector, as it holds ${words}.`
			: `Calls no connector: it holds ${words}.`
	return null
}

/**
 * What in typed text looks like it identifies a person: an email address or a phone number. Only ever a
 * warning: it cannot see names, and what it finds may not be personal. Nothing is sent to find it.
 */
export function looksPersonal(text: string): string[] {
	const kinds = new Set(findIdentifiers([text]).map((each) => each.kind))
	return [
		...(kinds.has('email') ? ['an email address'] : []),
		...(kinds.has('phone') ? ['a phone number'] : []),
	]
}
