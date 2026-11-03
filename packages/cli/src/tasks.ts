import type { TaskProfile } from '@ngomate/core'

const LIST_WORKSPACES = { tool: 'search_workspaces', args: {} }

export const TASKS: Record<string, TaskProfile> = {
	'find-calls': {
		id: 'find-calls',
		instructions:
			'Find open funding calls for the organization. Search first, then read the best results. ' +
			'List up to five, each with its title, deadline and link exactly as the tool gave them.',
		readTools: ['search_opportunities', 'get_opportunity'],
		writeTools: [],
	},
	'call-to-tasks': {
		id: 'call-to-tasks',
		instructions:
			'Turn one funding call into tasks in one workspace. Read the call, then create one task per step ' +
			'using the id of a workspace listed below. ' +
			'Base due dates only on the deadline the call states. If it states none, set no due date.',
		readTools: ['get_opportunity', 'search_opportunities', 'search_workspaces'],
		writeTools: ['create_workspace_deliverable'],
		preload: [LIST_WORKSPACES],
	},
	'weekly-status': {
		id: 'weekly-status',
		instructions:
			'Write a short weekly status for one workspace listed below: what is done, what is late, what is ' +
			'next. Use only what the tools return.',
		readTools: ['search_workspaces', 'get_workspace_summary', 'get_deliverable_progress'],
		writeTools: [],
		preload: [LIST_WORKSPACES],
	},
}
