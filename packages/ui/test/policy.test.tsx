// @vitest-environment jsdom
import {
	type DataClass,
	type ModelReply,
	parseSchedule,
	parseTeamFile,
	policyFromTemplate,
} from '@ngomate/core'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { NgomateApp } from '../src/NgomateApp.js'
import { DEFAULT_SETTINGS, type Settings } from '../src/host.js'
import {
	composerStatus,
	effectivePolicy,
	keptHereText,
	looksPersonal,
	onThisComputer,
	planLeaving,
	policyNotice,
	policyNoticeText,
	readPolicyRecord,
} from '../src/policyCheck.js'
import { createFakeHost } from '../src/preview-host.js'
import { runJob } from '../src/runJob.js'
import { type AnswerHooks, type ChatDeps, answerRequest, newConversation } from '../src/useChat.js'

afterEach(cleanup)

const say = (content: string): ModelReply => ({
	content,
	toolCalls: [],
	promptTokens: 1,
	completionTokens: 1,
})
const call = (name: string, args: unknown): ModelReply => ({
	content: null,
	toolCalls: [{ id: `c-${name}`, name, arguments: JSON.stringify(args) }],
	promptTokens: 1,
	completionTokens: 1,
})

/** A chat on a model server somewhere else, with the made-up grants connector. */
function setup(replies: ModelReply[], more: Partial<Settings>, local = true) {
	const host = createFakeHost({ replies })
	// Which model each answer started: the chosen server, or the one on this computer.
	const started: string[] = []
	const settings: Settings = {
		...DEFAULT_SETTINGS,
		model: { kind: 'server', baseUrl: 'https://models.example', model: 'fake' },
		addons: [
			{
				id: 'grants',
				name: 'Made-up grants',
				connection: { kind: 'http', url: 'https://grants.example/mcp' },
				enabled: true,
				allowDestructive: false,
			},
		],
		...more,
	}
	const deps: ChatDeps = {
		host,
		settings,
		getModel: async () => {
			started.push('server')
			return { client: host.createModelClient('https://models.example', 'fake') }
		},
		getLocalModel: async () => {
			if (!local) return null
			started.push('local')
			return { client: host.createModelClient('http://127.0.0.1:1', 'local'), name: 'Small model' }
		},
		onSaved: () => {},
	}
	return { host, deps, started }
}

const ask = (
	deps: ChatDeps,
	documents: { name: string; text: string; dataClass?: DataClass }[] = [],
	more: Partial<AnswerHooks> = {},
	conversation = newConversation('policy-test'),
) =>
	answerRequest(
		deps,
		conversation,
		'What is in this?',
		{ documents: documents.map((each) => ({ ...each, truncated: false })) },
		{
			signal: new AbortController().signal,
			confirmWrite: async () => false,
			save: async () => {},
			...more,
		},
	)

/** A policy that is kept to, not only watched. */
const kept = (template: 'open' | 'standard' | 'strict') => ({
	...policyFromTemplate(template),
	rules: { mode: 'enforce' as const },
})

describe('where the model runs', () => {
	it('counts the bundled model and a server on this computer as local, any other as leaving', () => {
		expect(onThisComputer({ kind: 'local', id: 'qwen' })).toBe(true)
		expect(
			onThisComputer({ kind: 'server', baseUrl: 'http://127.0.0.1:11434/v1', model: 'x' }),
		).toBe(true)
		expect(onThisComputer({ kind: 'server', baseUrl: 'http://localhost:8080', model: 'x' })).toBe(
			true,
		)
		expect(onThisComputer({ kind: 'server', baseUrl: 'http://[::1]:8080', model: 'x' })).toBe(true)
		expect(onThisComputer({ kind: 'server', baseUrl: 'https://models.example', model: 'x' })).toBe(
			false,
		)
	})
})

describe('what the policy makes of an answer', () => {
	it('keeps personal data off a model server under Standard, and says so in plain words', () => {
		const notice = policyNotice(policyFromTemplate('standard'), {
			model: { classes: ['internal', 'personal'], local: false },
		})
		expect(notice).toEqual({
			action: 'local_only',
			dataClass: 'personal',
			where: ['model'],
			observed: true,
			template: 'standard',
		})
		expect(policyNoticeText(notice as NonNullable<typeof notice>)).toBe(
			'Under your Standard policy this conversation would have stayed on the local model instead of reaching the model server: it holds personal data.',
		)
		// On this computer it is read as usual; a secret is never used, even here.
		expect(
			policyNotice(policyFromTemplate('standard'), {
				model: { classes: ['personal'], local: true },
			}),
		).toBeNull()
		expect(
			policyNotice(policyFromTemplate('open'), { model: { classes: ['secret'], local: true } })
				?.action,
		).toBe('block')
		expect(policyNotice(undefined, { model: { classes: ['secret'], local: false } })).toBeNull()
	})
})

describe('an answer under a policy', () => {
	it('notes what it would have kept here, remembers what the conversation held, and records it without content', async () => {
		const { host, deps } = setup([say('A list of names.')], {
			policy: policyFromTemplate('standard'),
			labels: { documents: 'personal' },
		})
		const result = await ask(deps, [{ name: 'Volunteers.txt', text: 'Ada, Bea and Cy.' }])
		expect(result.notice?.policy).toMatchObject({
			action: 'local_only',
			dataClass: 'personal',
			where: ['model'],
		})
		expect(result.conversation.classes).toEqual(['personal'])
		const [entry] = await readPolicyRecord(host)
		expect(entry).toMatchObject({
			feature: 'chat',
			dataClass: 'personal',
			observed: true,
			template: 'standard',
		})
		expect(JSON.stringify(entry)).not.toMatch(/Ada|Volunteers/)
	})

	it('counts a connector call as leaving, and its results as what the connector is labelled', async () => {
		const { deps } = setup([call('search_grants', { query: 'water' }), say('Two grants.')], {
			policy: policyFromTemplate('strict'),
			labels: { documents: 'confidential', connectors: { grants: 'public' } },
		})
		const result = await ask(deps, [{ name: 'Budget.txt', text: 'Our budget.' }])
		expect(result.notice?.policy?.where).toEqual(['model', 'connector'])
		expect(result.conversation.classes).toEqual(['public', 'confidential'])
	})

	it('keeps to Standard until the person chooses, and says nothing once it is turned off', async () => {
		const unchosen = setup([say('Fine.')], { labels: { documents: 'personal' } })
		const kept = await ask(unchosen.deps, [{ name: 'a.txt', text: 'x' }])
		expect(unchosen.started).toEqual(['local'])
		expect(kept.notice?.policy).toMatchObject({ template: 'standard', observed: false })
		const none = setup([say('Fine.')], { labels: { documents: 'personal' }, policyOff: true })
		expect((await ask(none.deps, [{ name: 'a.txt', text: 'x' }])).notice?.policy).toBeUndefined()
		const plain = setup([say('Fine.')], { policy: policyFromTemplate('strict') })
		expect((await ask(plain.deps)).notice?.policy).toBeUndefined()
	})
})

describe('the AI-use policy page', () => {
	it('starts a policy from a template, shows what it does, and saves the written one', async () => {
		const host = createFakeHost({})
		const saved: string[] = []
		host.saveDocument = async (name, text) => {
			saved.push(`${name}: ${text}`)
			return true
		}
		render(<NgomateApp host={host} />)
		await userEvent.click(await screen.findByRole('button', { name: 'AI-use policy' }))
		const page = await screen
			.findByRole('region', { name: 'AI-use policy' })
			.catch(() => document.body)
		// Before anyone chooses: Standard, kept to, and the details folded away.
		expect((within(page).getByLabelText('Policy') as HTMLSelectElement).value).toBe('standard')
		expect(within(page).getByText(/Applied until you choose another/)).toBeTruthy()
		const advanced = page.querySelector('details') as HTMLDetailsElement
		expect(advanced.open).toBe(false)
		await userEvent.selectOptions(within(page).getByLabelText('Policy'), 'strict')
		await userEvent.click(within(page).getByText('Advanced settings'))
		expect(
			await within(page).findByText(/What it keeps here is answered by the model/),
		).toBeTruthy()
		const row = within(page).getByRole('row', { name: /Confidential/ })
		expect(row.textContent).toMatch(/stays on the local model/)
		await userEvent.click(within(page).getByRole('button', { name: 'Strict' }))
		await waitFor(() => expect(saved[0]).toMatch(/^AI-use policy Strict\.md: # A made-up policy/))
		expect(saved[0]).toMatch(/ai-use-policy-strict\/download/)
		expect((await host.loadSettings()).policy).toMatchObject({
			template: 'strict',
			rules: { mode: 'enforce' },
		})
		// Watched only, then another template: still watched only.
		await userEvent.selectOptions(within(page).getByLabelText('How it applies'), 'observe')
		await userEvent.selectOptions(within(page).getByLabelText('Policy'), 'open')
		await waitFor(async () =>
			expect((await host.loadSettings()).policy).toMatchObject({
				template: 'open',
				rules: { mode: 'observe' },
			}),
		)
		// Turned off: nothing applies, and that is kept.
		await userEvent.selectOptions(within(page).getByLabelText('Policy'), 'off')
		await waitFor(async () => expect((await host.loadSettings()).policyOff).toBe(true))
		expect((await host.loadSettings()).policy).toBeUndefined()
	})
})

describe('before anything is sent', () => {
	it('says where the conversation will go, and why', () => {
		expect(composerStatus(undefined, ['personal'], { modelLocal: false })).toBeNull()
		expect(composerStatus(kept('standard'), ['internal'], { modelLocal: false })).toBeNull()
		expect(composerStatus(kept('standard'), ['personal'], { modelLocal: false })).toBe(
			'Stays on this computer: it holds personal data, so the local model answers and no connector is called.',
		)
		expect(composerStatus(kept('open'), ['personal'], { modelLocal: false })).toBe(
			'You will be asked to take out who it is about before it goes to the model server: it holds personal data.',
		)
		expect(
			composerStatus(kept('open'), ['personal'], { modelLocal: false, reviewed: true }),
		).toBeNull()
		expect(composerStatus(kept('strict'), ['secret'], { modelLocal: true })).toBe(
			'Will not be sent: this conversation holds secrets.',
		)
		expect(
			composerStatus(policyFromTemplate('standard'), ['personal'], { modelLocal: false }),
		).toBe('Watch only: this would stay on this computer, as it holds personal data.')
	})

	it('notices an email address or a phone number, never an amount or a year', () => {
		expect(looksPersonal('Write to ada@example.org about it')).toEqual(['an email address'])
		expect(looksPersonal('Call her on +254 712 345 678')).toEqual(['a phone number'])
		expect(looksPersonal('or 030 1234 5678')).toEqual(['a phone number'])
		expect(looksPersonal('The grant is 25,000 euros for 2026, report 12.')).toEqual([])
	})

	it('warns about typed personal data and counts the conversation as personal on request', async () => {
		const host = createFakeHost({})
		await host.saveSettings({ ...(await host.loadSettings()), policy: kept('standard') })
		render(<NgomateApp host={host} />)
		await userEvent.type(
			await screen.findByRole('textbox', { name: 'Message' }),
			'Ask ada@example.org',
		)
		expect(await screen.findByText(/This message holds an email address/)).toBeTruthy()
		await userEvent.click(screen.getByRole('button', { name: 'Count it as personal' }))
		await waitFor(() => expect(screen.queryByText(/This message holds/)).toBeNull())
		expect(screen.getByText(/it holds personal data/)).toBeTruthy()
	})
})

describe('what the person decides for one conversation', () => {
	it('keeps a conversation here when the person says so, with no policy at all', async () => {
		const { deps, started } = setup([call('search_grants', { query: 'x' }), say('Here.')], {})
		const result = await ask(deps, [], {}, { ...newConversation('kept'), keepHere: true })
		expect(started).toEqual(['local'])
		// No connector is offered, so the call the model tried reaches nothing.
		const tool = result.conversation.messages.find((message) => message.role === 'tool')
		expect(tool?.content).toMatch(/not available/)
		expect(result.notice?.keptHere).toEqual({ model: 'Small model' })
		expect(keptHereText({ model: 'Small model' })).toMatch(/answered by Small model/)
		// Under a policy that would ask, nothing is asked: nothing leaves.
		const open = setup([say('Here.')], { policy: kept('open'), labels: { documents: 'personal' } })
		await ask(
			open.deps,
			[{ name: 'Rota.txt', text: 'x' }],
			{
				confirmLeave: async () => {
					throw new Error('asked')
				},
			},
			{ ...newConversation('kept'), keepHere: true },
		)
		expect(open.started).toEqual(['local'])
		// Secrets are still never used, kept here or not.
		const secret = setup([say('never')], {
			policy: kept('standard'),
			labels: { documents: 'secret' },
		})
		const blocked = await ask(
			secret.deps,
			[{ name: 'Keys.txt', text: 'x' }],
			{},
			{
				...newConversation('kept'),
				keepHere: true,
			},
		)
		expect(blocked.error).toMatch(/never uses secrets/)
		const none = setup([say('never')], {}, false)
		const refused = await ask(none.deps, [], {}, { ...newConversation('kept'), keepHere: true })
		expect(none.started).toEqual([])
		expect(refused.error).toMatch(/you chose to keep this conversation/)
		expect(composerStatus(undefined, [], { modelLocal: false, keepHere: true })).toMatch(
			/Kept on this computer, as you chose/,
		)
		expect(
			composerStatus(kept('standard'), ['secret'], { modelLocal: false, keepHere: true }),
		).toBe('Will not be sent: this conversation holds secrets.')
	})

	it('counts what the person said, and lets them take it back', async () => {
		const marked = { ...newConversation('marked'), countsAs: 'personal' as const }
		const { deps, started } = setup([say('Here.')], { policy: kept('standard') })
		const result = await ask(deps, [], {}, marked)
		expect(started).toEqual(['local'])
		expect(result.notice?.policy?.localModel).toBe('Small model')
		// Not kept as held, so taking it back lets the next answer go to the model server.
		expect(result.conversation.classes ?? []).not.toContain('personal')
		const { countsAs: _, ...takenBack } = result.conversation
		const again = setup([say('There.')], { policy: kept('standard') })
		await ask(again.deps, [], {}, takenBack)
		expect(again.started).toEqual(['server'])
	})

	it('lets a document be labelled as it is attached under the default policy too', async () => {
		const host = createFakeHost({})
		host.pickDocument = async () => ({ name: 'Rota.txt', text: 'x', truncated: false })
		render(<NgomateApp host={host} />)
		await userEvent.click(await screen.findByRole('button', { name: 'Attach document' }))
		expect(await screen.findByLabelText('Counts as')).toBeTruthy()
	})

	it('says a team or organisation policy still applies when the person turned theirs off', async () => {
		const host = createFakeHost({})
		await host.saveSettings({ ...(await host.loadSettings()), policyOff: true })
		host.managedPolicy = async () => JSON.stringify(kept('strict'))
		render(<NgomateApp host={host} />)
		await userEvent.click(await screen.findByRole('button', { name: 'AI-use policy' }))
		expect(await screen.findByText(/your team's or organisation's still applies/)).toBeTruthy()
	})

	it('shows the policy an organisation set for this computer', async () => {
		const host = createFakeHost({})
		host.managedPolicy = async () => JSON.stringify(kept('strict'))
		render(<NgomateApp host={host} />)
		await userEvent.click(await screen.findByRole('button', { name: 'AI-use policy' }))
		const card = await screen.findByRole('region', { name: 'Set for this computer' })
		expect(card.textContent).toMatch(/a Strict policy/)
	})

	it('asks what each place holds when a policy is first picked', async () => {
		const host = createFakeHost({})
		render(<NgomateApp host={host} />)
		await userEvent.click(await screen.findByRole('button', { name: 'AI-use policy' }))
		await userEvent.selectOptions(await screen.findByLabelText('Policy'), 'strict')
		const questions = await screen.findByRole('region', { name: 'What your places hold' })
		await waitFor(async () =>
			expect((await host.loadSettings()).labels).toMatchObject({
				notes: 'confidential',
				documents: 'confidential',
			}),
		)
		await userEvent.selectOptions(
			within(questions).getByLabelText('What do the documents you attach usually hold?'),
			'sensitive_personal',
		)
		await userEvent.click(within(questions).getByRole('button', { name: 'That is right' }))
		await waitFor(async () =>
			expect(await host.loadSettings()).toMatchObject({
				labelsAsked: true,
				labels: { documents: 'sensitive_personal' },
			}),
		)
		expect(screen.queryByRole('region', { name: 'What your places hold' })).toBeNull()
	})
})

describe('a policy that is kept to', () => {
	it('plans before anything leaves: kept here, refused, asked first, or on its way', () => {
		expect(planLeaving(kept('standard'), ['personal'], { modelLocal: false })).toEqual({
			useLocalModel: true,
			connectors: 'none',
		})
		expect(planLeaving(kept('standard'), ['secret'], { modelLocal: true }).refuse).toMatch(
			/never uses secrets/,
		)
		const review = {
			...kept('standard'),
			classes: { personal: { desktop_remote: 'allow_with_review' as const } },
		}
		expect(planLeaving(review, ['personal'], { modelLocal: false }).review?.dataClass).toBe(
			'personal',
		)
		expect(planLeaving(review, ['personal'], { modelLocal: false, reviewed: true })).toEqual({
			connectors: 'allowed',
		})
		expect(planLeaving(kept('strict'), ['internal'], { modelLocal: true })).toEqual({
			connectors: 'all',
		})
		// Watching only changes nothing.
		expect(planLeaving(policyFromTemplate('strict'), ['secret'], { modelLocal: false })).toEqual({
			connectors: 'all',
		})
	})

	it('answers on the model on this computer, calls no connector, and says so', async () => {
		const { deps, started } = setup([say('Three volunteers.')], {
			policy: kept('standard'),
			labels: { documents: 'personal' },
		})
		const result = await ask(deps, [{ name: 'Volunteers.txt', text: 'Ada, Bea and Cy.' }])
		expect(started).toEqual(['local'])
		expect(result.answer).toBe('Three volunteers.')
		expect(result.notice?.policy).toMatchObject({ observed: false, where: ['model', 'connector'] })
		expect(
			policyNoticeText(result.notice?.policy as NonNullable<typeof result.notice>['policy'] & {}),
		).toBe(
			'Under your Standard policy this conversation stayed on the local model instead of reaching the model server, and called no connector: it holds personal data. It was answered by Small model on this computer, which may answer less well than your model server.',
		)
	})

	it('refuses with nothing sent when no model is downloaded here', async () => {
		const { deps, started } = setup(
			[say('never')],
			{ policy: kept('standard'), labels: { documents: 'personal' } },
			false,
		)
		const result = await ask(deps, [{ name: 'Volunteers.txt', text: 'Ada.' }])
		expect(started).toEqual([])
		expect(result.refused).toBe(true)
		expect(result.error).toMatch(/no model is downloaded here/)
	})

	it('asks once in a conversation, and sends nothing without a yes', async () => {
		const policy = {
			...kept('open'),
			classes: {
				...kept('open').classes,
				confidential: { desktop_remote: 'allow_with_review' as const },
			},
		}
		const no = setup([say('never')], { policy, labels: { documents: 'confidential' } })
		const refused = await ask(no.deps, [{ name: 'Budget.txt', text: 'x' }], {
			confirmLeave: async () => false,
		})
		expect(refused.refused).toBe(true)
		expect(no.started).toEqual([])
		const yes = setup([say('Fine.'), say('Again.')], {
			policy,
			labels: { documents: 'confidential' },
		})
		let asked = 0
		const confirmLeave = async () => {
			asked += 1
			return true
		}
		const first = await ask(yes.deps, [{ name: 'Budget.txt', text: 'x' }], { confirmLeave })
		expect(first.conversation.reviewedFor).toEqual({ dataClass: 'confidential', model: true })
		await ask(yes.deps, [], { confirmLeave }, first.conversation)
		expect(asked).toBe(1)
		expect(yes.started).toEqual(['server', 'server'])
	})

	it('under Open, lets personal data leave once the person has taken out who it is about', async () => {
		let notice: { action: string } | undefined
		const { deps, started } = setup([say('Three volunteers.')], {
			policy: kept('open'),
			labels: { documents: 'personal' },
		})
		const result = await ask(deps, [{ name: 'Volunteers.txt', text: 'three volunteers' }], {
			confirmLeave: async (asked) => {
				notice = asked
				return true
			},
		})
		expect(notice?.action).toBe('redact')
		expect(started).toEqual(['server'])
		expect(result.conversation.reviewedFor).toEqual({ dataClass: 'personal', model: true })
		expect(
			policyNoticeText({
				action: 'redact',
				dataClass: 'personal',
				where: ['model'],
				observed: true,
				template: 'open',
			}),
		).toBe(
			'Under your Open policy you would have been asked to take out names and what else identifies people before it went to the model server: it holds personal data.',
		)
		// Standard keeps the same document here.
		expect(planLeaving(kept('standard'), ['personal'], { modelLocal: false }).useLocalModel).toBe(
			true,
		)
	})

	it('sends who it is about as stand-ins once the person ticked them, and later ones unasked', async () => {
		const { deps } = setup([], { policy: kept('open'), labels: { documents: 'personal' } })
		const sent: string[] = []
		let answer = 'Thanks to [PERSON_1] at [EMAIL_1].'
		deps.getModel = async () => ({
			client: {
				async chat(request) {
					sent.push(JSON.stringify(request.messages))
					return { content: answer, toolCalls: [], promptTokens: null, completionTokens: null }
				},
			},
		})
		let offered: string[] = []
		const result = await ask(deps, [{ name: 'Rota.txt', text: 'Amina Yusuf, amina@example.org' }], {
			confirmLeave: async (_notice, found) => {
				offered = found.map((each) => each.text)
				return { takeOut: [...found, { text: 'Amina Yusuf', kind: 'name' }] }
			},
		})
		expect(offered).toEqual(['amina@example.org'])
		expect(sent[0]).not.toMatch(/Amina|amina@/)
		expect(result.answer).toBe('Thanks to Amina Yusuf at amina@example.org.')
		expect(result.notice?.tookOut).toBe(2)
		// The next message brings a new address: taken out without asking again.
		answer = 'Noted.'
		await answerRequest(
			deps,
			result.conversation,
			'Also copy bea@example.org',
			{},
			{
				signal: new AbortController().signal,
				confirmWrite: async () => false,
				save: async () => {},
				confirmLeave: async () => {
					throw new Error('asked again')
				},
			},
		)
		expect(sent[1]).not.toMatch(/bea@example|amina@|Amina/)
		expect(sent[1]).toMatch(/\[EMAIL_2\]/)
	})

	it('sends personal data to an approved model server, and still keeps it from connectors', async () => {
		const policy = { ...kept('standard'), approvedServers: ['https://models.example'] }
		const { deps, started } = setup([call('search_grants', { query: 'x' }), say('Done.')], {
			policy,
			labels: { documents: 'personal' },
		})
		const result = await ask(deps, [{ name: 'Rota.txt', text: 'x' }])
		expect(started).toEqual(['server'])
		const tool = result.conversation.messages.find((message) => message.role === 'tool')
		expect(tool?.content).toMatch(/not available/)
	})

	it('holds a person to the policy their organisation set for this computer', async () => {
		const { deps, started } = setup([say('Here.')], {
			policy: kept('open'),
			labels: { documents: 'confidential' },
		})
		deps.managedPolicy = kept('strict')
		await ask(deps, [{ name: 'Budget.txt', text: 'x' }])
		expect(started).toEqual(['local'])
	})

	it('saves the real values to notes kept here, and stand-ins to the team', async () => {
		const run = async (choice: 'me' | 'team') => {
			const { host, deps } = setup([], { policy: kept('open'), labels: { documents: 'personal' } })
			const teamSaved: string[] = []
			deps.team = {
				notes: {
					list: async () => [],
					read: async () => null,
					save: async (_name: string, text: string) => void teamSaved.push(text),
					remove: async () => {},
					readAll: async () => [],
				} as unknown as NonNullable<ChatDeps['team']>['notes'],
				tasks: [],
			}
			let turn = 0
			deps.getModel = async () => ({
				client: {
					async chat() {
						turn += 1
						return turn === 1
							? {
									content: null,
									toolCalls: [
										{
											id: '1',
											name: 'save_memory',
											arguments: '{"name":"rota","text":"Call [PERSON_1] on Monday"}',
										},
									],
									promptTokens: null,
									completionTokens: null,
								}
							: { content: 'Saved.', toolCalls: [], promptTokens: null, completionTokens: null }
					},
				},
			})
			let shown = ''
			let teamLabel = ''
			// Offered as when the person asks to save a note.
			await answerRequest(
				deps,
				newConversation('notes'),
				'Save a note about the rota',
				{
					documents: [{ name: 'Rota.txt', text: 'Amina Yusuf', truncated: false }],
					offerTools: ['save_memory'],
				},
				{
					signal: new AbortController().signal,
					save: async () => {},
					confirmLeave: async () => ({ takeOut: [{ text: 'Amina Yusuf', kind: 'name' }] }),
					confirmWrite: async (write) => {
						shown = String(write.args.text)
						teamLabel = write.choices?.find((each) => each.id === 'team')?.label ?? ''
						return { choice }
					},
				},
			)
			return { shown, teamLabel, mine: await host.memory.read('rota'), teamSaved }
		}
		const mine = await run('me')
		expect(mine.shown).toBe('Call Amina Yusuf on Monday')
		expect(mine.teamLabel).toMatch(/with stand-ins such as \[PERSON_1\]/)
		expect(mine.mine).toBe('Call Amina Yusuf on Monday')
		const team = await run('team')
		expect(team.teamSaved).toEqual(['Call [PERSON_1] on Monday'])
	})

	it('asks again when a yes does not cover what the conversation holds now, or where it goes', async () => {
		const review = {
			...kept('standard'),
			classes: {
				...kept('standard').classes,
				confidential: { desktop_remote: 'allow_with_review' as const },
				personal: { desktop_remote: 'allow_with_review' as const },
			},
		}
		const { deps } = setup([say('One.'), say('Two.'), say('Three.')], { policy: review })
		let asked = 0
		const confirmLeave = async () => {
			asked += 1
			return true
		}
		const first = await ask(deps, [{ name: 'Budget.txt', text: 'x', dataClass: 'confidential' }], {
			confirmLeave,
		})
		const second = await ask(deps, [], { confirmLeave }, first.conversation)
		expect(asked).toBe(1)
		// More sensitive than what was confirmed: asked again.
		await ask(
			deps,
			[{ name: 'Rota.txt', text: 'x', dataClass: 'personal' }],
			{ confirmLeave },
			second.conversation,
		)
		expect(asked).toBe(2)
		// Confirmed only for connectors, now with a model server: asked again.
		const third = setup([say('Four.')], { policy: review })
		await ask(
			third.deps,
			[{ name: 'Budget.txt', text: 'x', dataClass: 'confidential' }],
			{ confirmLeave },
			{
				...newConversation('scoped'),
				reviewedFor: { dataClass: 'confidential', model: false },
			},
		)
		expect(asked).toBe(3)
	})

	it('offers again what says who someone is when nothing was swapped before', async () => {
		const { deps } = setup([say('One.'), say('Two.')], {
			policy: kept('open'),
			labels: { documents: 'personal' },
		})
		const offered: string[][] = []
		const confirmLeave = async (_notice: unknown, found: { text: string }[]) => {
			offered.push(found.map((each) => each.text))
			return { takeOut: [] }
		}
		const first = await ask(deps, [{ name: 'A.txt', text: 'x' }], { confirmLeave })
		await ask(
			deps,
			[{ name: 'B.txt', text: 'bea@example.org' }],
			{ confirmLeave },
			first.conversation,
		)
		expect(offered).toEqual([[], ['bea@example.org']])
	})

	it('answers on the local model when only leaving is blocked', async () => {
		const policy = {
			...kept('standard'),
			classes: { personal: { desktop_local: 'allow' as const, desktop_remote: 'block' as const } },
		}
		const { deps, started } = setup([say('Here.')], {
			policy,
			labels: { documents: 'personal' },
			model: { kind: 'local', id: 'small' },
		})
		deps.getModel = async () => {
			started.push('local')
			return { client: deps.host.createModelClient('http://127.0.0.1:1', 'small') }
		}
		const result = await ask(deps, [{ name: 'Rota.txt', text: 'x' }])
		expect(result.refused).toBeUndefined()
		expect(started).toEqual(['local'])
	})

	it('sends the knowledge search the stand-ins, never the real values', async () => {
		const { deps } = setup([say('Found it.')], {})
		const searched: unknown[] = []
		deps.host.connectAddon = async () => ({
			listTools: async () => [
				{
					name: 'search_knowledge',
					description: 'Searches the knowledge base.',
					inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
					annotations: { readOnly: true },
				},
			],
			callTool: async (_name, args) => {
				searched.push(args)
				return { text: '', isError: false }
			},
			close: async () => {},
		})
		const getModel = deps.getModel
		deps.getModel = async () => ({ ...(await getModel()), searchKnowledgeFirst: true })
		await answerRequest(
			deps,
			{
				...newConversation('search'),
				standIns: [{ real: 'amina@example.org', stand: '[EMAIL_1]' }],
			},
			'Grants for amina@example.org',
			{},
			{
				signal: new AbortController().signal,
				confirmWrite: async () => false,
				save: async () => {},
			},
		)
		expect(searched.length).toBeGreaterThan(0)
		expect(JSON.stringify(searched)).not.toMatch(/amina@/)
		expect(JSON.stringify(searched)).toMatch(/\[EMAIL_1\]/)
	})

	it('lets a conversation the person confirmed call its connectors', async () => {
		const policy = {
			...kept('open'),
			classes: {
				...kept('open').classes,
				confidential: { desktop_remote: 'allow_with_review' as const },
			},
		}
		const { deps } = setup([call('search_grants', { query: 'water' }), say('Two grants.')], {
			policy,
			labels: { documents: 'confidential' },
		})
		const result = await ask(deps, [{ name: 'Budget.txt', text: 'x' }], {
			confirmLeave: async () => true,
		})
		// Called for real: neither refused by the policy nor left out of what was offered.
		const tool = result.conversation.messages.find((message) => message.role === 'tool')
		expect(tool?.content).not.toMatch(/Not called|not available/)
		expect(result.answer).toBe('Two grants.')
	})

	it('keeps from a model server the connectors whose own results must stay here', async () => {
		const { deps } = setup([call('search_grants', { query: 'water' }), say('Done.')], {
			policy: kept('strict'),
			labels: { connectors: { grants: 'confidential' } },
		})
		const result = await ask(deps)
		const tool = result.conversation.messages.find((message) => message.role === 'tool')
		expect(tool?.content).toMatch(/not available/)
		expect(result.notice?.policy).toMatchObject({ dataClass: 'confidential', where: ['connector'] })
	})

	it('holds a job’s connector destination and its sends when the run read what must stay here', async () => {
		const { deps } = setup([say('A summary.')], {
			policy: kept('standard'),
			labels: { notes: 'personal' },
		})
		await deps.host.memory.write('People', 'Ada works with us.')
		const job = {
			id: 'update',
			title: 'Update',
			task: 'find-opportunities',
			schedule: parseSchedule('daily 09:00'),
			destination: { kind: 'tool' as const, name: 'add_contact', field: 'name', args: {} },
			inputs: 'A made-up group.',
		}
		const due = new Date(2026, 10, 30, 9)
		const after = await runJob(
			{ chat: deps, tasks: deps.host.tasks, teamTasks: [] },
			job,
			{ nextDue: due.toISOString(), runs: [] },
			new AbortController().signal,
			() => due,
		)
		expect(after.runs[0]).toMatchObject({ outcome: 'held' })
		expect(after.runs[0]?.reason).toMatch(/was not written to add_contact/)
	})

	it("holds a job's write to the team's notes only when a connector keeps them", async () => {
		const run = async (addonId?: string) => {
			const { deps } = setup([say('A summary.')], {
				policy: kept('standard'),
				labels: { notes: 'personal' },
			})
			await deps.host.memory.write('People', 'Ada works with us.')
			const saved: string[] = []
			deps.team = {
				notes: {
					list: async () => [],
					read: async () => null,
					save: async (name: string) => void saved.push(name),
					remove: async () => {},
					readAll: async () => [],
				} as unknown as NonNullable<ChatDeps['team']>['notes'],
				tasks: [],
				...(addonId ? { addonId } : {}),
			}
			const due = new Date(2026, 10, 30, 9)
			const after = await runJob(
				{ chat: deps, tasks: deps.host.tasks, teamTasks: [] },
				{
					id: 'update',
					title: 'Update',
					task: 'find-opportunities',
					schedule: parseSchedule('daily 09:00'),
					destination: { kind: 'team-note' as const, name: 'Updates' },
					inputs: 'A made-up group.',
				},
				{ nextDue: due.toISOString(), runs: [] },
				new AbortController().signal,
				() => due,
			)
			return { outcome: after.runs[0]?.outcome, saved }
		}
		const onConnector = await run('team-service')
		expect(onConnector.outcome).toBe('held')
		expect(onConnector.saved).toEqual([])
		const inFolder = await run()
		expect(inFolder.outcome).not.toBe('held')
		expect(inFolder.saved.length).toBe(1)
	})

	it('holds a person to the team’s policy, and reads a team policy it cannot trust as Strict', () => {
		const both = effectivePolicy(kept('open'), kept('strict'))
		expect(planLeaving(both, ['confidential'], { modelLocal: false }).useLocalModel).toBe(true)
		const team = parseTeamFile(
			JSON.stringify({
				format: 1,
				name: 'Riverside',
				limits: {},
				connectors: [],
				policy: { nonsense: true },
			}),
		)
		expect(team.policy?.classes.confidential?.desktop_remote).toBe('local_only')
		expect(team.policy?.rules?.mode).toBe('enforce')
	})
})
