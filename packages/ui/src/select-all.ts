const EDITABLE = 'input, textarea, select, [contenteditable]:not([contenteditable="false"])'

/**
 * Select All inside a conversation selects the message the selection is in, and pressed again, the
 * whole conversation; never the buttons, tabs and lists around it. True when it handled the keys.
 * In a text field, in settings, or outside `root`, the usual Select All applies.
 */
export function selectAllInConversation(event: KeyboardEvent, root: HTMLElement): boolean {
	if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return false
	if (event.key.toLowerCase() !== 'a') return false
	const target = event.target instanceof Element ? event.target : null
	if (target?.closest(EDITABLE)) return false
	// Clicking text leaves the focus on the page itself, so the keys arrive from the body.
	if (target && target !== document.body && !root.contains(target)) return false

	const selection = document.getSelection()
	if (!selection) return false
	const anchor = selection.anchorNode
	const anchorElement = anchor instanceof Element ? anchor : (anchor?.parentElement ?? null)
	const visible = [...root.querySelectorAll<HTMLElement>('.ngm-chat-holder:not([hidden])')]
	const holder =
		visible.find((candidate) => anchorElement && candidate.contains(anchorElement)) ??
		visible.find((candidate) => target && candidate.contains(target)) ??
		visible[0]
	const messages = holder?.querySelector<HTMLElement>('.ngm-messages')
	if (!messages) return false

	const message = anchorElement?.closest<HTMLElement>('.ngm-answer-text, .ngm-user')
	const messageSelected =
		message && selection.toString().trim() === (message.textContent ?? '').trim()
	const node = message && messages.contains(message) && !messageSelected ? message : messages

	const range = document.createRange()
	range.selectNodeContents(node)
	selection.removeAllRanges()
	selection.addRange(range)
	event.preventDefault()
	return true
}
