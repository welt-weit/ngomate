import {
	type ButtonHTMLAttributes,
	type ComponentType,
	type HTMLAttributes,
	type InputHTMLAttributes,
	type ReactNode,
	type SelectHTMLAttributes,
	type TextareaHTMLAttributes,
	createContext,
	useContext,
	useLayoutEffect,
	useRef,
} from 'react'

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
	/** `nav` is an item in a list of places, `quiet` a minor action beside something else. */
	variant?: 'default' | 'primary' | 'quiet' | 'nav'
	/** For `nav`: this is where the person is. */
	active?: boolean
}
export type InputProps = InputHTMLAttributes<HTMLInputElement>
export type TextAreaProps = TextareaHTMLAttributes<HTMLTextAreaElement>
export type SelectProps = SelectHTMLAttributes<HTMLSelectElement> & { children: ReactNode }
export type CheckboxProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>
export type ChipProps = HTMLAttributes<HTMLSpanElement>
export type DialogProps = {
	title: string
	onClose: () => void
	children: ReactNode
}

/**
 * The controls the interface is built from. A host replaces any of them with its own, so the interface
 * uses that host's real components. They take the same props as the HTML elements they stand for.
 */
export type NgomatePrimitives = {
	Button: ComponentType<ButtonProps>
	Input: ComponentType<InputProps>
	TextArea: ComponentType<TextAreaProps>
	Select: ComponentType<SelectProps>
	Checkbox: ComponentType<CheckboxProps>
	Chip: ComponentType<ChipProps>
	/** Shown only while it is on the page. */
	Dialog: ComponentType<DialogProps>
}

const VARIANT_CLASS = { default: '', primary: 'ngm-primary', quiet: 'ngm-quiet', nav: 'ngm-nav' }

const classes = (...names: (string | undefined | false)[]) => names.filter(Boolean).join(' ')

function DefaultDialog({ title, onClose, children }: DialogProps) {
	const ref = useRef<HTMLDialogElement>(null)
	// Layout effect, so its cleanup runs while the dialog is still on the page: closing it, not removing
	// it, is what gives focus back to the button that opened it.
	useLayoutEffect(() => {
		// The browser's own modal keeps focus inside and closes on Escape.
		const dialog = ref.current
		if (!dialog) return
		if (typeof dialog.showModal === 'function') {
			if (!dialog.open) dialog.showModal()
			dialog.querySelector<HTMLElement>('[data-autofocus]')?.focus()
			return () => dialog.close()
		}
		dialog.setAttribute('open', '')
	}, [])
	return (
		<dialog
			ref={ref}
			className="ngm-dialog"
			aria-label={title}
			onCancel={(event) => {
				event.preventDefault()
				onClose()
			}}
			// A second Escape closes it even when the first was refused. If it is meant to stay, show it again.
			onClose={(event) => {
				const dialog = event.currentTarget
				if (dialog.isConnected && !dialog.open) dialog.showModal()
			}}
		>
			<div className="ngm-dialog-head">
				<h3>{title}</h3>
				<button type="button" className="ngm-button ngm-quiet" aria-label="Close" onClick={onClose}>
					×
				</button>
			</div>
			{children}
		</dialog>
	)
}

export const DEFAULT_PRIMITIVES: NgomatePrimitives = {
	Button: ({ variant = 'default', active, className, type = 'button', ...props }) => (
		<button
			type={type}
			className={classes(
				'ngm-button',
				VARIANT_CLASS[variant],
				active && 'ngm-nav-active',
				className,
			)}
			{...props}
		/>
	),
	Input: ({ className, ...props }) => (
		<input className={classes('ngm-input', className)} {...props} />
	),
	TextArea: ({ className, ...props }) => (
		<textarea className={classes('ngm-input', className)} {...props} />
	),
	Select: ({ className, ...props }) => (
		<select className={classes('ngm-input', className)} {...props} />
	),
	Checkbox: ({ className, ...props }) => <input type="checkbox" className={className} {...props} />,
	Chip: ({ className, ...props }) => <span className={classes('ngm-chip', className)} {...props} />,
	Dialog: DefaultDialog,
}

const PrimitivesContext = createContext<NgomatePrimitives>(DEFAULT_PRIMITIVES)

export const PrimitivesProvider = PrimitivesContext.Provider

export const usePrimitives = () => useContext(PrimitivesContext)

/** Colors and fonts. Whatever is left out comes from a parent element, or is inherited. */
export type NgomateTheme = {
	background?: string
	panel?: string
	line?: string
	text?: string
	muted?: string
	accent?: string
	accentText?: string
	link?: string
	warningBackground?: string
	warningText?: string
	error?: string
	radius?: string
	font?: string
	headingFont?: string
}

const THEME_VARIABLES: Record<keyof NgomateTheme, string> = {
	background: '--ngm-bg',
	panel: '--ngm-panel',
	line: '--ngm-line',
	text: '--ngm-text',
	muted: '--ngm-muted',
	accent: '--ngm-accent',
	accentText: '--ngm-accent-text',
	link: '--ngm-link',
	warningBackground: '--ngm-warn-bg',
	warningText: '--ngm-warn-text',
	error: '--ngm-error',
	radius: '--ngm-radius',
	font: '--ngm-font',
	headingFont: '--ngm-heading-font',
}

export function themeVariables(theme: NgomateTheme = {}): Record<string, string> {
	const variables: Record<string, string> = {}
	for (const [key, value] of Object.entries(theme)) {
		const name = THEME_VARIABLES[key as keyof NgomateTheme]
		if (name && value) variables[name] = value
	}
	return variables
}
