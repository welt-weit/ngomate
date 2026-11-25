/**
 * The interface's few icons, drawn as single strokes on a 16 by 16 grid in the text colour, so they
 * follow any theme and a host's own buttons. Every icon comes from here.
 */
export function Icon({ path, size = 16 }: { path: string; size?: number }) {
	return (
		<svg viewBox="0 0 16 16" width={size} height={size} aria-hidden="true" focusable="false">
			<path
				d={path}
				fill="none"
				stroke="currentColor"
				strokeWidth="1.5"
				strokeLinecap="round"
				strokeLinejoin="round"
			/>
		</svg>
	)
}

export const ICONS = {
	close: 'M4 4l8 8M12 4l-8 8',
	/** Speak instead of typing. */
	mic: 'M8 2.5a2 2 0 0 0-2 2v3.5a2 2 0 0 0 4 0V4.5a2 2 0 0 0-2-2zM4.5 7.5a3.5 3.5 0 0 0 7 0M8 11v2.5M6 13.5h4',
	/** The spark: the assistant does this with you. On every action that hands work to it. */
	spark:
		'M6.5 2.5l1.1 3.4 3.4 1.1-3.4 1.1-1.1 3.4-1.1-3.4L2 7l3.4-1.1zM12 9.5l.6 1.4 1.4.6-1.4.6-.6 1.4-.6-1.4-1.4-.6 1.4-.6z',
	plus: 'M8 3v10M3 8h10',
	split: 'M2.5 3.5h11v9h-11zM8 3.5v9',
	/** A window with its side bar: open or close the sidebar. */
	sidebar: 'M2.5 3.5h11v9h-11zM6 3.5v9',
	/** A notebook: the memory notes. */
	memory: 'M4.5 2.5h7v11h-7zM6.5 5.5h3M6.5 8h3',
	attach:
		'M10.5 5.5l-4.3 4.3a1.25 1.25 0 0 0 1.8 1.8l4.6-4.6a2.5 2.5 0 0 0-3.5-3.5l-4.7 4.7a3.7 3.7 0 0 0 5.2 5.2l3.4-3.4',
	send: 'M8 13V3M4 7l4-4 4 4',
	stop: 'M4.5 4.5h7v7h-7z',
	/** Someone with no name yet. */
	person:
		'M8 8.5a2.75 2.75 0 1 0 0-5.5a2.75 2.75 0 1 0 0 5.5zM3 13.5c.8-2.4 2.7-3.5 5-3.5s4.2 1.1 5 3.5',
	check: 'M3.5 8.5l3 3 6-7',
	/** The sidebar's twin on the right: show or hide your work. */
	panelRight: 'M2.5 3.5h11v9h-11zM10 3.5v9',
	search: 'M7 11.5a4.5 4.5 0 1 0 0-9a4.5 4.5 0 1 0 0 9zM10.5 10.5l3 3',
	/** A chip: the model. */
	model:
		'M4.5 4.5h7v7h-7zM6.5 2v2.5M9.5 2v2.5M6.5 11.5V14M9.5 11.5V14M2 6.5h2.5M2 9.5h2.5M11.5 6.5H14M11.5 9.5H14',
	/** A plug: the connectors. */
	plug: 'M6 2v3M10 2v3M4.5 5h7v2.5a3.5 3.5 0 0 1-7 0zM8 11v3',
	/** Two people: the team. */
	team: 'M6 7.5a2 2 0 1 0 0-4a2 2 0 1 0 0 4zM2.5 13c.5-2 1.8-3 3.5-3s3 1 3.5 3M11 7.5a1.75 1.75 0 1 0 0-3.5M11.5 10c1.2.2 2 1.1 2.4 2.5',
	info: 'M8 14a6 6 0 1 0 0-12a6 6 0 1 0 0 12zM8 7.5v3.5M8 5.01v-.01',
} as const
