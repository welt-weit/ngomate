import { useState } from 'react'
import { ICONS, Icon } from './icons.js'
import { usePrimitives } from './primitives.js'

/**
 * One thing a list item's menu can do. `disabled` items show why in their label. `ai` marks the
 * assistant's route with the spark, and goes first: in NGOmate it is always the preferred one.
 */
export type ActionItem = { label: string; onSelect: () => void; disabled?: boolean; ai?: boolean }

/**
 * A "⋯" button that opens the actions of one item: a conversation, a task, a job, a message. The same
 * everywhere, so each list shows one quiet button per row instead of a row of icons.
 */
export function ActionMenu({
	label,
	items,
	className = 'ngm-icon-button',
	open: given,
	onOpenChange,
}: {
	/** The button's name, such as "Actions for Funding this week". */
	label: string
	items: ActionItem[]
	className?: string
	/** For a menu whose parent needs to know it is open. */
	open?: boolean
	onOpenChange?: (open: boolean) => void
}) {
	const { Button, Popover } = usePrimitives()
	const [own, setOwn] = useState(false)
	const open = given ?? own
	const setOpen = (next: boolean) => {
		setOwn(next)
		onOpenChange?.(next)
	}
	return (
		<Popover
			label={label}
			trigger="⋯"
			triggerClassName={className}
			open={open}
			onOpenChange={setOpen}
		>
			{items.map((item) => (
				<Button
					key={item.label}
					variant="quiet"
					disabled={item.disabled}
					onClick={() => {
						setOpen(false)
						item.onSelect()
					}}
				>
					{item.ai && <Icon path={ICONS.spark} size={14} />}
					{item.label}
				</Button>
			))}
		</Popover>
	)
}

/**
 * A list row's actions: the ⋯ menu in the strip that shows over the end of the row on hover. While its
 * menu is open the strip says so (`data-open`), so it stays in view on the pointer's way to the menu.
 */
export function RowActions({ label, items }: { label: string; items: ActionItem[] }) {
	const [open, setOpen] = useState(false)
	return (
		<div className="ngm-side-actions" data-open={open ? '' : undefined}>
			<ActionMenu label={label} items={items} open={open} onOpenChange={setOpen} />
		</div>
	)
}
