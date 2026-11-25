import { type ReactNode, useState } from 'react'
import type { NgomateHost, Settings } from './host.js'
import { usePrimitives } from './primitives.js'

export type SettingsSection = 'you' | 'model' | 'addons' | 'tools' | 'team' | 'about'

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
 * One page of what is set up once, opened from the sidebar's list. The pages are the ones the app
 * already had; this only places them.
 */
export function SettingsPage({
	host,
	settings,
	onChange,
	section,
	onCheckUpdates,
	sections,
}: {
	host: NgomateHost
	settings: Settings
	onChange: (settings: Settings) => void
	section: SettingsSection
	onCheckUpdates: () => void
	/** The pages for the sections the app shows itself: model, connectors and teams. */
	sections: Partial<Record<SettingsSection, ReactNode>>
}) {
	return (
		<div className="ngm-settings">
			<div className="ngm-settings-content">
				{section === 'you' && <YouSection settings={settings} onChange={onChange} />}
				{section === 'about' && <AboutSection host={host} onCheckUpdates={onCheckUpdates} />}
				{section !== 'you' && section !== 'about' && (sections[section] ?? sections.model)}
			</div>
		</div>
	)
}
