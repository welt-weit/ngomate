import { parseTaskFile } from '@ngomate/core'
import logoDark from './assets/mark-dark.svg'
import logoLight from './assets/mark-light.svg'

const taskFiles = import.meta.glob<string>('./tasks/*.md', {
	query: '?raw',
	import: 'default',
	eager: true,
})

/** The ready-made tasks the app ships with. */
export const tasks = Object.values(taskFiles).map(parseTaskFile)

export const logo = { light: logoLight, dark: logoDark }
