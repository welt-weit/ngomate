import { describe, expect, it } from 'vitest'

import { checkFigures, extractFigures } from '../src/figures.js'

const NOTES = `Larem district water project.
In 2025 we built 20 rainwater tanks at 9 schools. 41 of 62 schools in the district have no reliable water.
The dry season lasts 7 months. The 2026 budget is €48,500, and 85% of pupils are girls and boys under 12.
Contact: 24 months of maintenance training planned.`

describe('extractFigures', () => {
	it('reads what a figure counts, including "x of y things", and leaves years out', () => {
		const figures = extractFigures(
			'In 2025, 41 of 62 Schools got 1,200 litres and €48,500; 85% passed.',
		)
		expect(figures).toEqual([
			{ value: '41', written: '41 of 62 Schools', units: ['school'] },
			{ value: '62', written: '62 Schools', units: ['school'] },
			{ value: '1200', written: '1,200 litres', units: ['litre'] },
			{ value: '48500', written: '€48,500', units: [] },
			{ value: '85', written: '85%', units: ['%'] },
		])
	})

	it('does not mistake dates, versions or ids for figures', () => {
		expect(extractFigures('Due 2027-05-01, version 0.2.1, form ABC-12, at 10:30.')).toEqual([])
	})
})

describe('checkFigures', () => {
	it('says what the material has when a figure is attached to the wrong thing', () => {
		expect(checkFigures('We built tanks at 14 schools.', [NOTES])).toEqual([
			{
				figure: '14 schools',
				problem: 'different',
				material: ['9 schools', '41 of 62 schools', '62 schools'],
			},
		])
	})

	it('flags a changed figure even when the number appears elsewhere in the material', () => {
		// 24 is in the notes, but as months of training, never as tanks.
		expect(checkFigures('We built 24 rainwater tanks.', [NOTES])).toEqual([
			{ figure: '24 rainwater tanks', problem: 'different', material: ['20 rainwater tanks'] },
		])
	})

	it('flags a number that is nowhere in the material', () => {
		expect(checkFigures('The project reaches 3,400 families.', [NOTES])).toEqual([
			{ figure: '3,400 families', problem: 'missing' },
		])
	})

	it('accepts figures that match the material, in any form of the word', () => {
		const draft =
			'In 2025 we built 20 rainwater tanks at 9 Schools; 41 of 62 schools lack water. The budget is €48,500 and 85% are under 12.'
		expect(checkFigures(draft, [NOTES])).toEqual([])
	})

	it('matches on either word of what is counted, and names each problem once', () => {
		expect(
			checkFigures('Step 2: see question 3. We built 30 tanks and 30 tanks.', [NOTES]),
		).toEqual([{ figure: '30 tanks', problem: 'different', material: ['20 rainwater tanks'] }])
	})

	it('without material every figure is unbacked, which is why a run checks only when it had material', () => {
		expect(checkFigures('Paris has about 2 million people.', [])).toEqual([
			{ figure: '2 million people', problem: 'missing' },
		])
	})
})
