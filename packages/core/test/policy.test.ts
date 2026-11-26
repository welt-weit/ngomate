import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
	DATA_CLASSES,
	POLICY_ACTIONS,
	approvesServer,
	ceilingPolicy,
	combinePolicies,
	decide,
	mostSensitive,
	parsePolicy,
	policyFromTemplate,
} from '../src/policy.js'

describe('an AI-use policy on this computer', () => {
	it('keeps the templates of the design: what leaves, what stays on the local model', () => {
		const leaves = (template: 'open' | 'standard' | 'strict') =>
			DATA_CLASSES.map((each) => decide(policyFromTemplate(template), each, 'desktop_remote'))
		// public, internal, confidential, personal, sensitive personal, secrets
		expect(leaves('open')).toEqual(['allow', 'allow', 'allow', 'redact', 'redact', 'block'])
		expect(leaves('standard')).toEqual([
			'allow',
			'allow',
			'allow',
			'local_only',
			'local_only',
			'block',
		])
		expect(leaves('strict')).toEqual([
			'allow',
			'allow',
			'local_only',
			'local_only',
			'local_only',
			'block',
		])
		// The local model reads everything but secrets, in every template.
		for (const template of ['open', 'standard', 'strict'] as const) {
			expect(decide(policyFromTemplate(template), 'sensitive_personal', 'desktop_local')).toBe(
				'allow',
			)
			expect(decide(policyFromTemplate(template), 'secret', 'desktop_local')).toBe('block')
		}
	})

	it('starts by watching, and takes the most sensitive of what a conversation holds', () => {
		expect(policyFromTemplate('strict').rules).toEqual({ mode: 'observe' })
		expect(mostSensitive(['internal', 'personal', 'public'])).toBe('personal')
		expect(mostSensitive([])).toBe('public')
	})

	it('holds a person to the stricter of their own and their team’s', () => {
		const both = combinePolicies(policyFromTemplate('open'), policyFromTemplate('strict'))
		expect(decide(both, 'confidential', 'desktop_remote')).toBe('local_only')
		expect(both.template).toBe('custom')
	})

	it('reads a file, keeps what it does not use, and refuses one it cannot trust', () => {
		const file = { ...policyFromTemplate('standard'), providers: { retention: 'none' } }
		expect(parsePolicy(JSON.stringify(file))).toEqual(file)
		expect(() => parsePolicy('{')).toThrow('not valid JSON')
		expect(() => parsePolicy(JSON.stringify({ ...file, schemaVersion: 2 }))).toThrow('format')
		expect(() =>
			parsePolicy(JSON.stringify({ ...file, classes: { personal: { desktop_remote: 'maybe' } } })),
		).toThrow('not an action')
		expect(() => parsePolicy(JSON.stringify({ ...file, classes: { gossip: {} } }))).toThrow(
			'not a class',
		)
	})

	it('publishes a schema that names the same classes and actions', () => {
		const schema = JSON.parse(
			readFileSync(join(__dirname, '../schema/ai-use-policy.schema.json'), 'utf8'),
		)
		expect(schema.properties.classes.propertyNames.enum).toEqual([...DATA_CLASSES])
		expect(schema.properties.classes.additionalProperties.additionalProperties.enum).toEqual([
			...POLICY_ACTIONS,
		])
	})

	it('trusts an approved model server more, falls back to the stricter rule, and lets a ceiling narrow the list', () => {
		const standard = {
			...policyFromTemplate('standard'),
			approvedServers: ['https://models.example.org/v1/'],
		}
		expect(approvesServer(standard, 'https://MODELS.example.org/v1')).toBe(true)
		expect(approvesServer(standard, 'https://other.example/v1')).toBe(false)
		expect(decide(standard, 'personal', 'desktop_approved')).toBe('allow')
		expect(decide(standard, 'sensitive_personal', 'desktop_approved')).toBe('local_only')
		expect(decide(policyFromTemplate('strict'), 'personal', 'desktop_approved')).toBe('local_only')
		// A file that does not name the column is held to desktop_remote there.
		const older = { ...standard, classes: { personal: { desktop_remote: 'local_only' as const } } }
		expect(decide(older, 'personal', 'desktop_approved')).toBe('local_only')
		// The ceiling's list is the most; one's own narrows it, and no list of one's own follows it.
		const team = {
			...standard,
			approvedServers: ['https://models.example.org/v1', 'https://b.example'],
		}
		expect(
			combinePolicies({ ...standard, approvedServers: undefined }, team).approvedServers,
		).toEqual(team.approvedServers)
		expect(combinePolicies(standard, team).approvedServers).toEqual([
			'https://models.example.org/v1',
		])
		expect(combinePolicies(standard, policyFromTemplate('standard')).approvedServers).toEqual([])
		expect(() =>
			parsePolicy(JSON.stringify({ ...standard, approvedServers: ['not a url'] })),
		).toThrow('approvedServers')
		expect(ceilingPolicy('{').rules?.mode).toBe('enforce')
		expect(ceilingPolicy('{').classes).toEqual(policyFromTemplate('strict').classes)
	})

	// Format 1 is published: other tools may read it. A field may be added; nothing here may be renamed,
	// dropped or given a new meaning, and a new class or action would make older readers refuse the file,
	// so any of those is format 2.
	it('keeps format 1 as published', () => {
		const schema = JSON.parse(
			readFileSync(join(__dirname, '../schema/ai-use-policy.schema.json'), 'utf8'),
		)
		expect(schema.properties.schemaVersion).toEqual({ const: 1 })
		expect(schema.required).toEqual(['schemaVersion', 'version', 'classes'])
		expect(Object.keys(schema.properties)).toEqual(
			expect.arrayContaining([
				'schemaVersion',
				'version',
				'template',
				'reviewBy',
				'rules',
				'classes',
			]),
		)
		expect(schema.properties.template.enum).toEqual(['open', 'standard', 'strict', 'custom'])
		expect(schema.properties.rules.properties.mode.enum).toEqual(['observe', 'enforce'])
		expect(DATA_CLASSES).toEqual([
			'public',
			'internal',
			'confidential',
			'personal',
			'sensitive_personal',
			'secret',
		])
		expect(POLICY_ACTIONS).toEqual(['allow', 'allow_with_review', 'redact', 'local_only', 'block'])
	})
})
