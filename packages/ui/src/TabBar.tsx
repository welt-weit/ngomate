import { type DragEvent, useState } from 'react'
import { ICONS, Icon } from './icons.js'
import type { Pane } from './layout.js'
import { usePrimitives } from './primitives.js'

/** What a conversation carries when dragged, from the list or from another tab bar. */
export const CONVERSATION_DRAG_TYPE = 'application/x-ngomate-conversation'

export function startConversationDrag(event: DragEvent, id: string) {
	event.dataTransfer.setData(CONVERSATION_DRAG_TYPE, id)
	event.dataTransfer.effectAllowed = 'move'
}

const carriesConversation = (event: DragEvent) =>
	event.dataTransfer.types.includes(CONVERSATION_DRAG_TYPE)

type TabBarProps = {
	pane: Pane
	titleOf: (id: string) => string
	onSelect: (id: string) => void
	onClose: (id: string) => void
	onNew: () => void
	onSplit: () => void
	canSplit: boolean
	/** A conversation dropped here, before the tab `before` or at the end. */
	onDrop: (id: string, before?: string) => void
}

export function TabBar({
	pane,
	titleOf,
	onSelect,
	onClose,
	onNew,
	onSplit,
	canSplit,
	onDrop,
}: TabBarProps) {
	const { Button } = usePrimitives()
	// Where a dragged conversation would land: before this tab, or 'end'. Null while nothing is dragged over.
	const [dropAt, setDropAt] = useState<string | null>(null)

	const over = (event: DragEvent, at: string) => {
		if (!carriesConversation(event)) return
		event.preventDefault()
		event.stopPropagation()
		event.dataTransfer.dropEffect = 'move'
		if (dropAt !== at) setDropAt(at)
	}
	const drop = (event: DragEvent) => {
		if (!carriesConversation(event)) return
		event.preventDefault()
		const id = event.dataTransfer.getData(CONVERSATION_DRAG_TYPE)
		const before = dropAt && dropAt !== 'end' ? dropAt : undefined
		setDropAt(null)
		if (id) onDrop(id, before)
	}

	return (
		<div
			className={`ngm-tabs${dropAt ? ' ngm-tabs-dropping' : ''}`}
			onDragOver={(event) => over(event, 'end')}
			onDragLeave={(event) => {
				if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropAt(null)
			}}
			onDrop={drop}
		>
			<div className="ngm-tab-list" role="tablist">
				{pane.tabs.map((id, index) => {
					const title = titleOf(id)
					const active = id === pane.active
					return (
						<div
							key={id}
							className={[
								'ngm-tab',
								active && 'ngm-tab-active',
								dropAt === id && 'ngm-tab-drop-before',
							]
								.filter(Boolean)
								.join(' ')}
							title={title}
							draggable
							onDragStart={(event) => startConversationDrag(event, id)}
							// The left half of a tab puts it before that tab, the right half after, so a tab
							// can be moved one place to the right.
							onDragOver={(event) => {
								const box = event.currentTarget.getBoundingClientRect()
								const after = event.clientX > box.left + box.width / 2
								over(event, after ? (pane.tabs[index + 1] ?? 'end') : id)
							}}
							// A middle click closes, as in a browser.
							onAuxClick={(event) => {
								if (event.button === 1) onClose(id)
							}}
						>
							<Button
								variant="quiet"
								role="tab"
								aria-selected={active}
								className="ngm-tab-title"
								onClick={() => onSelect(id)}
							>
								{title}
							</Button>
							<Button
								variant="quiet"
								className="ngm-icon-button ngm-tab-close"
								aria-label={`Close ${title}`}
								title="Close"
								onClick={() => onClose(id)}
							>
								<Icon path={ICONS.close} size={14} />
							</Button>
						</div>
					)
				})}
				<Button
					variant="quiet"
					className={`ngm-icon-button ngm-tab-icon${dropAt === 'end' ? ' ngm-tab-drop-before' : ''}`}
					aria-label="New conversation in this pane"
					title="New conversation"
					onClick={onNew}
				>
					<Icon path={ICONS.plus} size={14} />
				</Button>
			</div>
			<Button
				variant="quiet"
				className="ngm-icon-button ngm-tab-icon ngm-tab-split"
				aria-label="New conversation side by side"
				title={canSplit ? 'New conversation side by side' : 'No room for another pane'}
				disabled={!canSplit}
				onClick={onSplit}
			>
				<Icon path={ICONS.split} size={14} />
			</Button>
		</div>
	)
}
