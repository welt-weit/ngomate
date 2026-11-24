import { inviteLink } from '@ngomate/core'
import { useEffect, useState } from 'react'
import type { SettingsSection } from './Settings.js'
import { teamInvite } from './TeamPanel.js'
import type { NgomateHost, Settings } from './host.js'
import { ICONS, Icon } from './icons.js'
import { usePrimitives } from './primitives.js'
import type { Team } from './useTeam.js'

/** "Amina Okafor" → "AO", "amina" → "A". */
export function initials(name: string): string {
	const words = name.trim().split(/\s+/).filter(Boolean)
	const letters = words.length > 1 ? [words[0], words.at(-1)] : words
	return letters.map((word) => [...(word ?? '')][0]?.toUpperCase() ?? '').join('')
}

/**
 * The person's avatar. It opens who they are, the model in use and their teams, switched right
 * there; Settings is for what is set up once.
 */
export function ProfileMenu({
	host,
	settings,
	team,
	onSettings,
	onAddTeam,
	onCheckUpdates,
}: {
	host: NgomateHost
	settings: Settings
	team: Team
	/** Opens a setup page; here, only You. */
	onSettings: (section: SettingsSection) => void
	onAddTeam: () => void
	onCheckUpdates: () => void
}) {
	const { Button, Popover } = usePrimitives()
	const [open, setOpen] = useState(false)
	const [localName, setLocalName] = useState<string | null>(null)
	const [problem, setProblem] = useState<string | null>(null)
	const [copied, setCopied] = useState(false)

	// The catalog name of a local model, read when the panel opens.
	const choice = settings.model
	const localId = choice?.kind === 'local' ? choice.id : null
	useEffect(() => {
		if (!open) {
			setCopied(false)
			setProblem(null)
		}
		if (!open || !localId || !host.models) return
		let current = true
		host.models.info().then(
			(info) => {
				if (current) setLocalName(info.models.find((model) => model.id === localId)?.name ?? null)
			},
			() => {},
		)
		return () => {
			current = false
		}
	}, [open, localId, host])

	const model = !choice
		? 'No model chosen yet'
		: choice.kind === 'server'
			? `${choice.model} · your model server`
			: `${localName ?? choice.id} · on this computer`

	const name = settings.yourName?.trim() ?? ''
	const avatar = (
		<span className="ngm-avatar" aria-hidden="true">
			{name ? initials(name) : <Icon path={ICONS.person} />}
		</span>
	)
	const invite = teamInvite(team.file, team.location, settings.addons)
	const close = (then: () => void) => () => {
		setOpen(false)
		then()
	}

	return (
		<Popover
			label="You and your team"
			trigger={avatar}
			triggerClassName="ngm-icon-button ngm-avatar-button"
			open={open}
			onOpenChange={setOpen}
		>
			<div className="ngm-profile-head">
				{avatar}
				<div className="ngm-profile-who">
					{name ? <strong>{name}</strong> : <span className="ngm-muted">No name yet</span>}
					<span className="ngm-muted">{model}</span>
				</div>
			</div>
			<Button variant="quiet" onClick={close(() => onSettings('you'))}>
				{name ? 'Change your name' : 'Add your name'}
			</Button>

			{host.team && (
				<>
					<p className="ngm-popover-title">Team</p>
					{!team.activeId && <p className="ngm-popover-note">No team, just me</p>}
					{team.memberships.map((membership) => {
						const active = membership.id === team.activeId
						return (
							<Button
								key={membership.id}
								variant="quiet"
								className="ngm-profile-team"
								aria-current={active ? 'true' : undefined}
								onClick={close(() => {
									if (!active) void team.switchTo(membership.id)
								})}
							>
								{membership.name ?? 'A team not read yet'}
								<span className="ngm-profile-check">
									{active && <Icon path={ICONS.check} size={14} />}
								</span>
							</Button>
						)
					})}
					<Button variant="quiet" onClick={close(onAddTeam)}>
						{team.memberships.length ? 'Join or set up another team…' : 'Set up or join a team…'}
					</Button>
					{invite && (
						<Button
							variant="quiet"
							onClick={() =>
								navigator.clipboard.writeText(inviteLink(invite)).then(
									() => setCopied(true),
									() => setProblem('Could not copy. Copy it under Settings, Teams.'),
								)
							}
						>
							{copied ? 'Invite link copied' : 'Copy invite link'}
						</Button>
					)}
					{problem && <p className="ngm-popover-note ngm-error">{problem}</p>}
				</>
			)}

			{host.checkForUpdate && (
				<>
					<hr className="ngm-popover-line" />
					<Button variant="quiet" onClick={close(onCheckUpdates)}>
						Check for updates
					</Button>
				</>
			)}
		</Popover>
	)
}
