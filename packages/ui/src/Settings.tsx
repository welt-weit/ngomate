import { type ReactNode, useState } from 'react'
import type { NgomateHost, Settings } from './host.js'
import { usePrimitives } from './primitives.js'

export type SettingsSection = 'you' | 'model' | 'addons' | 'team' | 'about'

const LABELS: Record<SettingsSection, string> = {
	you: 'You',
	model: 'Model',
	addons: 'Connectors',
	team: 'Teams',
	about: 'About',
}

/** The person: how a team sees them. Kept on this computer and in the teams they write to. */
function YouSection({
	settings,
	onChange,
}: { settings: Settings; onChange: (settings: Settings) => void }) {
	const { Button, Input } = usePrimitives()
	const [name, setName] = useState(settings.yourName ?? '')
	const [saved, setSaved] = useState(false)
	return (
		<section className="ngm-panel">
			<h2>You</h2>
			<form
				className="ngm-form"
				onSubmit={(event) => {
					event.preventDefault()
					onChange({ ...settings, yourName: name.trim() })
					setSaved(true)
				}}
			>
				<label>
					Your name, as your teams see it
					<Input
						value={name}
						onChange={(event) => {
							setName(event.target.value)
							setSaved(false)
						}}
					/>
				</label>
				<p className="ngm-muted">
					Shown to a team as who set it up. It stays on this computer otherwise. NGOmate has no
					account: there is nothing else about you to set.
				</p>
				<div className="ngm-row">
					<Button type="submit">{saved ? 'Saved' : 'Save'}</Button>
				</div>
			</form>
		</section>
	)
}

function AboutSection({ host, onCheckUpdates }: { host: NgomateHost; onCheckUpdates: () => void }) {
	const { Button } = usePrimitives()
	return (
		<section className="ngm-panel">
			<h2>About {host.appName}</h2>
			<p className="ngm-muted">
				An assistant that runs on your own computer, with your documents, your notes and the tools
				you connect.
			</p>
			{host.checkForUpdate && (
				<div className="ngm-row">
					<Button onClick={onCheckUpdates}>Check for updates</Button>
				</div>
			)}
		</section>
	)
}

/**
 * Everything set up once, in one place, opened from ⚙ or ⌘,. The sections are the pages the app
 * already had; this only gathers them.
 */
export function SettingsPage({
	host,
	settings,
	onChange,
	section,
	onSection,
	onCheckUpdates,
	sections,
}: {
	host: NgomateHost
	settings: Settings
	onChange: (settings: Settings) => void
	section: SettingsSection
	onSection: (section: SettingsSection) => void
	onCheckUpdates: () => void
	/** The pages for the sections the app shows itself: model, connectors and teams. */
	sections: Partial<Record<SettingsSection, ReactNode>>
}) {
	const { Button } = usePrimitives()
	const shown: SettingsSection[] = [
		'you',
		'model',
		'addons',
		...(sections.team ? ['team' as const] : []),
		'about',
	]
	const current = shown.includes(section) ? section : 'model'
	return (
		<div className="ngm-settings">
			<nav className="ngm-settings-nav" aria-label="Settings">
				<h2 className="ngm-side-title">Settings</h2>
				{shown.map((name) => (
					<Button
						variant="nav"
						key={name}
						active={name === current}
						aria-current={name === current ? 'page' : undefined}
						onClick={() => onSection(name)}
					>
						{LABELS[name]}
					</Button>
				))}
			</nav>
			<div className="ngm-settings-content">
				{current === 'you' && <YouSection settings={settings} onChange={onChange} />}
				{current === 'about' && <AboutSection host={host} onCheckUpdates={onCheckUpdates} />}
				{current !== 'you' && current !== 'about' && sections[current]}
			</div>
		</div>
	)
}
