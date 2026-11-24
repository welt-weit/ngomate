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
	chevron: 'M6 4l4 4-4 4',
	/** Someone with no name yet. */
	person:
		'M8 8.5a2.75 2.75 0 1 0 0-5.5a2.75 2.75 0 1 0 0 5.5zM3 13.5c.8-2.4 2.7-3.5 5-3.5s4.2 1.1 5 3.5',
	check: 'M3.5 8.5l3 3 6-7',
} as const
