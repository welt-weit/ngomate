import {
	ACTION_WORDS,
	CLASS_WORDS,
	DATA_CLASSES,
	type DataClass,
	type PolicyAction,
	type PolicyFile,
	type PolicyTemplate,
	decide,
	policyFromTemplate,
	serverAddress,
} from '@ngomate/core'
import { useCallback, useEffect, useState } from 'react'
import { ActionMenu } from './ActionMenu.js'
import type { NgomateHost, PolicyLabels, Settings, TeamMembership } from './host.js'
import {
	type PolicyRecordEntry,
	clearPolicyRecord,
	effectivePolicy,
	labelled,
	ownPolicy,
	readPolicyRecord,
} from './policyCheck.js'
import { usePrimitives } from './primitives.js'
import type { MonthCounts } from './teamCounts.js'

/** Where the written policies are published, free to anyone, with no sign-in. */
export const COMMONS = 'https://api.actionnetwork.world/v1/public/commons'

const TEMPLATES: { id: PolicyTemplate; name: string; about: string }[] = [
	{
		id: 'open',
		name: 'Open',
		about:
			'For a small team that holds little about other people. Personal data leaves only once you have taken out who it is about, and confirmed.',
	},
	{
		id: 'standard',
		name: 'Standard',
		about:
			'For most organisations. Personal data, and that of the people you serve, stays on this computer.',
	},
	{
		id: 'strict',
		name: 'Strict',
		about:
			'For work with people at risk. Everything above ordinary working material stays on this computer.',
	},
]

/** What the model on this computer does with data: nothing leaves, so it is read or not used. */
const LOCAL_WORDS: Record<PolicyAction, string> = {
	allow: 'read here',
	allow_with_review: 'read here after you confirm',
	redact: 'read here',
	local_only: 'read here',
	block: 'never used',
}

/**
 * What each place starts as when a template is first picked: Strict assumes confidential working
 * material until said otherwise, the others ordinary material. The questions then ask about people.
 */
const STARTING_LABEL: Record<PolicyTemplate, DataClass> = {
	open: 'internal',
	standard: 'internal',
	strict: 'confidential',
}

/** The answers the questions offer, in plain words, each a class. */
const ANSWERS: [DataClass, string][] = [
	['internal', 'Ordinary work, nothing about people'],
	['confidential', 'Confidential work, such as budgets or contracts'],
	['personal', 'Staff, volunteers, donors or partners'],
	['sensitive_personal', 'The people we serve, or health, migration or similar'],
]

const WHERE: Record<PolicyRecordEntry['where'][number], string> = {
	model: 'the model server',
	connector: 'a connector',
}

/**
 * The AI-use policy this person keeps to on this computer. Standard applies until they choose otherwise;
 * the page shows the choice and what it means, and keeps everything else under Advanced settings.
 */
export function PolicyPanel({
	host,
	settings,
	onChange,
	teams,
	team,
	managed,
}: {
	host: NgomateHost
	settings: Settings
	onChange: (settings: Settings) => void
	teams: TeamMembership[]
	/** The open team and its policy, the least every member keeps to; `share` sets or removes it. */
	team?: {
		name: string
		policy?: PolicyFile
		/** False when the team's settings are kept by its service, so this app cannot change them. */
		editable: boolean
		share(policy: PolicyFile | undefined): Promise<void>
		/** This month's counts from every computer in the team; missing where the team keeps none. */
		counts?(): Promise<{ computers: number; counts: MonthCounts }>
	}
	/** The policy an organisation set for this computer, which nothing here changes. */
	managed?: PolicyFile
}) {
	const { Button, Input, Select } = usePrimitives()
	// The person's own: chosen, or Standard kept to when they never chose; none when turned off.
	const own = ownPolicy(settings)
	const chosen = settings.policy !== undefined
	// What applies: their own, held to the team's and the organisation's as the least.
	const inForce = effectivePolicy(own, team?.policy, managed)
	const labels = settings.labels ?? {}
	const [record, setRecord] = useState<PolicyRecordEntry[]>([])
	const [problem, setProblem] = useState<string | null>(null)
	const [saved, setSaved] = useState<string | null>(null)
	const [shareProblem, setShareProblem] = useState<string | null>(null)
	const [server, setServer] = useState('')
	const [counts, setCounts] = useState<{ computers: number; counts: MonthCounts } | null>(null)
	const readCounts = team?.counts
	useEffect(() => {
		let live = true
		readCounts?.()
			.then((read) => live && setCounts(read))
			.catch((err) => console.error("The team's counts could not be read:", err))
		return () => {
			live = false
		}
	}, [readCounts])

	const refresh = useCallback(async () => setRecord(await readPolicyRecord(host)), [host])
	useEffect(() => {
		void refresh()
	}, [refresh])

	const setOwn = (next: PolicyFile) => {
		const { policyOff: _, ...rest } = settings
		onChange({ ...rest, policy: next })
	}
	const nothingLabelled =
		!labels.notes &&
		!labels.documents &&
		!Object.keys(labels.teams ?? {}).length &&
		!Object.keys(labels.connectors ?? {}).length
	const choose = (template: PolicyTemplate | 'off' | 'custom') => {
		// "Your own" is what is set already: there is no template to make it from.
		if (template === 'custom') return
		if (template === 'off') {
			const { policy: _, ...rest } = settings
			onChange({ ...rest, policyOff: true })
			return
		}
		const { policyOff: _, ...rest } = settings
		onChange({
			...rest,
			// The first template picked also sets where the places start; the questions refine it.
			...(nothingLabelled && STARTING_LABEL[template] !== 'internal'
				? { labels: { notes: STARTING_LABEL[template], documents: STARTING_LABEL[template] } }
				: {}),
			// Another template keeps how it applies and the approved servers.
			policy: {
				...policyFromTemplate(template, (own?.version ?? 0) + 1),
				rules: own?.rules ?? { mode: 'enforce' },
				...(own?.approvedServers ? { approvedServers: own.approvedServers } : {}),
			},
		})
	}
	const setMode = (mode: 'observe' | 'enforce') =>
		own && setOwn({ ...own, version: own.version + 1, rules: { mode } })
	const setServers = (approvedServers: string[]) =>
		own && setOwn({ ...own, version: own.version + 1, approvedServers })
	const share = async (next: PolicyFile | undefined) => {
		setShareProblem(null)
		try {
			await team?.share(next)
		} catch (err) {
			setShareProblem(err instanceof Error ? err.message : String(err))
		}
	}
	const label = (change: (labels: PolicyLabels) => PolicyLabels) =>
		onChange({ ...settings, labels: change(labels) })

	const download = async (slug: string, name: string) => {
		setProblem(null)
		setSaved(null)
		try {
			const text = await host.fetchText?.(`${COMMONS}/${slug}/download?format=md`)
			if (!text) throw new Error('This app cannot fetch it.')
			if (await host.saveDocument(`${name}.md`, text)) setSaved(name)
		} catch (err) {
			setProblem(
				`The written policy could not be fetched: ${err instanceof Error ? err.message : String(err)}`,
			)
		}
	}

	const approved = own?.approvedServers ?? []
	const current = settings.model?.kind === 'server' ? settings.model.baseUrl : null
	const addServer = (url: string) => {
		const address = serverAddress(url)
		if (address && !approved.some((each) => serverAddress(each) === address))
			setServers([...approved, url.trim()])
		setServer('')
	}
	const templateName = (each: PolicyFile | undefined) =>
		TEMPLATES.find((template) => template.id === each?.template)?.name ?? 'own'

	return (
		<section className="ngm-panel ngm-policy">
			<h2>AI-use policy</h2>
			<p className="ngm-muted">
				Rules for what may leave this computer, by how sensitive it is. What the policy keeps here
				is only read by the model on this computer, and connectors are held to the same rules. It
				keeps to what you label and does not read your text for you; whoever uses this app can
				change these settings.
			</p>

			{managed && (
				<section className="ngm-tool-card" aria-label="Set for this computer">
					<h3>Set by your organisation</h3>
					<p>
						This computer keeps to{' '}
						{templateName(managed) === 'own'
							? 'a policy of its own'
							: `a ${templateName(managed)} policy`}{' '}
						set by your organisation. It is the least that applies here, whatever you choose below,
						and nothing in this app can change it.
					</p>
				</section>
			)}

			<label>
				Policy
				<Select
					value={own ? (own.template ?? 'custom') : 'off'}
					onChange={(event) => choose(event.target.value as PolicyTemplate | 'off' | 'custom')}
				>
					{TEMPLATES.map((each) => (
						<option key={each.id} value={each.id}>
							{each.id === 'standard' ? `${each.name} (recommended)` : each.name}
						</option>
					))}
					{own?.template === 'custom' && <option value="custom">Your own</option>}
					<option value="off">None: nothing is held back</option>
				</Select>
			</label>
			<p className="ngm-muted">
				{own
					? `${TEMPLATES.find((each) => each.id === own.template)?.about ?? 'Made from a template and changed.'}${chosen ? '' : ' Applied until you choose another.'}`
					: inForce
						? "You keep to no policy of your own; your team's or organisation's still applies."
						: 'Nothing is held back, and nothing is noted.'}
			</p>

			{own && !settings.labelsAsked && (
				<section className="ngm-tool-card" aria-label="What your places hold">
					<h3>A few questions first</h3>
					<p className="ngm-muted">
						The policy keeps to what each place holds, and anything not said counts as ordinary
						work. Answer once; you can change it under Advanced settings at any time.
					</p>
					<div className="ngm-policy-labels">
						<ClassField
							name="What do your notes usually say?"
							value={labelled(labels.notes)}
							choices={ANSWERS}
							onSet={(notes) => label((all) => ({ ...all, notes }))}
						/>
						<ClassField
							name="What do the documents you attach usually hold?"
							value={labelled(labels.documents)}
							choices={ANSWERS}
							onSet={(documents) => label((all) => ({ ...all, documents }))}
						/>
						{teams.map((each) => (
							<ClassField
								key={each.id}
								name={`What do the notes and tasks of ${each.name ?? 'this team'} hold?`}
								value={labelled(labels.teams?.[each.id])}
								choices={ANSWERS}
								onSet={(value) =>
									label((all) => ({ ...all, teams: { ...all.teams, [each.id]: value } }))
								}
							/>
						))}
						{settings.addons.map((addon) => (
							<ClassField
								key={addon.id}
								name={`What does ${addon.name} give back?`}
								value={labelled(labels.connectors?.[addon.id])}
								choices={ANSWERS}
								onSet={(value) =>
									label((all) => ({
										...all,
										connectors: { ...all.connectors, [addon.id]: value },
									}))
								}
							/>
						))}
					</div>
					<div className="ngm-row">
						<Button variant="primary" onClick={() => onChange({ ...settings, labelsAsked: true })}>
							That is right
						</Button>
					</div>
				</section>
			)}

			{team?.policy && (
				<p className="ngm-muted">
					The team {team.name} keeps to a{' '}
					{templateName(team.policy) === 'own'
						? 'policy of its own'
						: `${templateName(team.policy)} policy`}
					: for each kind of data, the stricter of the team's and yours applies.
				</p>
			)}

			<details className="ngm-advanced">
				<summary>Advanced settings</summary>
				<div className="ngm-advanced-body">
					{own && (
						<>
							<label>
								How it applies
								<Select
									value={own.rules?.mode ?? 'observe'}
									onChange={(event) => setMode(event.target.value as 'observe' | 'enforce')}
								>
									<option value="enforce">Keep to it: hold back what it says</option>
									<option value="observe">Watch only: say what it would hold back</option>
								</Select>
							</label>
							<p className="ngm-notice-inline">
								{own.rules?.mode === 'enforce'
									? 'What it keeps here is answered by the model on this computer, with no connector; what it asks about waits for your yes; what it never uses is not sent. Each time, the answer says so underneath.'
									: 'Nothing is held back yet. An answer it would have kept on this computer says so underneath, and is listed below.'}
							</p>
						</>
					)}

					{team && (team.policy || (team.editable && own) || (counts?.computers ?? 0) > 0) && (
						<section className="ngm-tool-card" aria-label="The team's policy">
							<h3>The team {team.name}</h3>
							{team.policy ? (
								<p>
									The team keeps to a{' '}
									{TEMPLATES.find((each) => each.id === team.policy?.template)?.name ??
										'policy of its own'}{' '}
									policy. For each kind of data, the stricter of the team's and yours applies.
								</p>
							) : (
								<p className="ngm-muted">
									The team has no policy. Sharing yours makes it the least every member keeps to.
								</p>
							)}
							{team.editable && (
								<div className="ngm-row">
									{own && (
										<Button onClick={() => share(own)}>
											{team.policy ? "Make yours the team's policy" : 'Share yours with the team'}
										</Button>
									)}
									{team.policy && (
										<Button variant="quiet" onClick={() => share(undefined)}>
											Remove the team's policy
										</Button>
									)}
								</div>
							)}
							{counts && counts.computers > 0 && (
								<p className="ngm-muted">
									This month across{' '}
									{counts.computers === 1 ? 'one computer' : `${counts.computers} computers`}:{' '}
									{counts.counts.kept} kept on the computer, {counts.counts.asked} asked first,{' '}
									{counts.counts.stopped} not sent, {counts.counts.watched} noted under a policy
									that only watches. Counts only, never what a conversation said; in a small team,
									when a count was last added can still hint at who.
								</p>
							)}
							{shareProblem && <p className="ngm-error">{shareProblem}</p>}
						</section>
					)}

					{inForce && (
						<>
							<h3>What applies</h3>
							<table className="ngm-policy-table">
								<thead>
									<tr>
										<th scope="col">Data</th>
										<th scope="col">To a model server or connector</th>
										{(inForce.approvedServers?.length ?? 0) > 0 && (
											<th scope="col">To an approved model server</th>
										)}
										<th scope="col">To the model on this computer</th>
									</tr>
								</thead>
								<tbody>
									{DATA_CLASSES.map((each) => (
										<tr key={each}>
											<th scope="row">{CLASS_WORDS[each]}</th>
											<td>{ACTION_WORDS[decide(inForce, each, 'desktop_remote')]}</td>
											{(inForce.approvedServers?.length ?? 0) > 0 && (
												<td>{ACTION_WORDS[decide(inForce, each, 'desktop_approved')]}</td>
											)}
											<td>{LOCAL_WORDS[decide(inForce, each, 'desktop_local')]}</td>
										</tr>
									))}
								</tbody>
							</table>

							<h3>What counts as what</h3>
							<p className="ngm-muted">
								Set once for each place data comes from. What is not labelled counts as internal.
							</p>
							<div className="ngm-policy-labels">
								<ClassField
									name="Your notes"
									value={labelled(labels.notes)}
									onSet={(notes) => label((all) => ({ ...all, notes }))}
								/>
								<ClassField
									name="Documents you attach, unless you choose otherwise"
									value={labelled(labels.documents)}
									onSet={(documents) => label((all) => ({ ...all, documents }))}
								/>
								{teams.map((each) => (
									<ClassField
										key={each.id}
										name={`The team ${each.name ?? 'whose name is not known yet'}`}
										value={labelled(labels.teams?.[each.id])}
										onSet={(value) =>
											label((all) => ({ ...all, teams: { ...all.teams, [each.id]: value } }))
										}
									/>
								))}
								{settings.addons.map((addon) => (
									<ClassField
										key={addon.id}
										name={`What ${addon.name} returns`}
										value={labelled(labels.connectors?.[addon.id])}
										onSet={(value) =>
											label((all) => ({
												...all,
												connectors: { ...all.connectors, [addon.id]: value },
											}))
										}
									/>
								))}
							</div>
						</>
					)}

					{own && (
						<>
							<h3>Approved model servers</h3>
							<p className="ngm-muted">
								A server you trust more, such as your organisation's own or one that keeps nothing,
								may read personal data under Open and Standard. Any other server is held to the
								stricter rule.
							</p>
							{approved.length > 0 && (
								<ul className="ngm-policy-servers">
									{approved.map((each) => (
										<ServerRow
											key={each}
											address={each}
											onRemove={() => setServers(approved.filter((other) => other !== each))}
										/>
									))}
								</ul>
							)}
							{current &&
								!approved.some((each) => serverAddress(each) === serverAddress(current)) && (
									<Button onClick={() => addServer(current)}>
										Approve the server you use: {current}
									</Button>
								)}
							<div className="ngm-row">
								<Input
									aria-label="A model server to approve"
									placeholder="For example: https://models.example.org/v1"
									value={server}
									onChange={(event) => setServer(event.target.value)}
									onKeyDown={(event) => {
										if (event.key === 'Enter' && serverAddress(server)) {
											event.preventDefault()
											addServer(server)
										}
									}}
								/>
								<Button onClick={() => addServer(server)} disabled={!serverAddress(server)}>
									Approve
								</Button>
							</div>
						</>
					)}

					{host.fetchText && (
						<>
							<h3>The written policy</h3>
							<p className="ngm-muted">
								Each template is also a policy to adopt in writing, free to anyone and open to
								change: who it covers, what never goes into an AI tool, and who is accountable.
							</p>
							<div className="ngm-row">
								<Button
									onClick={() => download('which-ai-use-policy-fits', 'Which AI-use policy fits')}
								>
									Which one fits?
								</Button>
								{TEMPLATES.map((each) => (
									<Button
										key={each.id}
										variant={own?.template === each.id ? 'primary' : undefined}
										onClick={() =>
											download(`ai-use-policy-${each.id}`, `AI-use policy ${each.name}`)
										}
									>
										{each.name}
									</Button>
								))}
							</div>
							{saved && <p className="ngm-muted">Saved: {saved}.</p>}
							{problem && <p className="ngm-error">{problem}</p>}
						</>
					)}

					{host.policyRecord && (
						<>
							<h3>What it held back</h3>
							{record.length === 0 ? (
								<p className="ngm-muted">Nothing yet.</p>
							) : (
								<>
									<p className="ngm-muted">
										Kept on this computer only, without anything a conversation said. The newest
										first.
									</p>
									<ul className="ngm-policy-record">
										{record.slice(0, 50).map((entry) => (
											<li key={`${entry.at}-${entry.where.join()}`}>
												{new Date(entry.at).toLocaleString(undefined, {
													day: 'numeric',
													month: 'short',
													hour: '2-digit',
													minute: '2-digit',
												})}
												{' · '}
												{entry.feature === 'job'
													? 'A job'
													: entry.feature === 'task'
														? 'A task'
														: 'A chat'}{' '}
												holding {CLASS_WORDS[entry.dataClass].toLowerCase()}, to{' '}
												{entry.where.map((each) => WHERE[each]).join(' and ')}:{' '}
												{entry.observed ? 'would have ' : ''}
												{entry.action === 'block'
													? 'been stopped'
													: entry.action === 'allow_with_review' || entry.action === 'redact'
														? 'asked first'
														: 'stayed on this computer'}
											</li>
										))}
									</ul>
									<Button
										variant="quiet"
										onClick={async () => {
											await clearPolicyRecord(host)
											await refresh()
										}}
									>
										Clear the list
									</Button>
								</>
							)}
						</>
					)}
				</div>
			</details>
		</section>
	)
}

/** An approved server, with its actions in the row's ⋯ menu, as in every list. */
function ServerRow({ address, onRemove }: { address: string; onRemove: () => void }) {
	const [open, setOpen] = useState(false)
	return (
		<li data-open={open ? '' : undefined}>
			<span>{address}</span>
			<span className="ngm-row-menu">
				<ActionMenu
					label={`Actions for ${address}`}
					items={[{ label: 'Remove', onSelect: onRemove }]}
					open={open}
					onOpenChange={setOpen}
				/>
			</span>
		</li>
	)
}

/** One place data comes from, and what it counts as. */
function ClassField({
	name,
	value,
	onSet,
	choices,
}: {
	name: string
	value: DataClass
	onSet: (value: DataClass) => void
	/** The answers offered, in words; every class when left out. The value set now is always offered. */
	choices?: [DataClass, string][]
}) {
	const { Select } = usePrimitives()
	const offered: [DataClass, string][] = choices
		? choices.some(([each]) => each === value)
			? choices
			: [[value, CLASS_WORDS[value]], ...choices]
		: DATA_CLASSES.map((each) => [each, CLASS_WORDS[each]])
	return (
		<label>
			{name}
			<Select value={value} onChange={(event) => onSet(event.target.value as DataClass)}>
				{offered.map(([each, words]) => (
					<option key={each} value={each}>
						{words}
					</option>
				))}
			</Select>
		</label>
	)
}
