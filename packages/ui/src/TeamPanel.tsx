import {
	type TeamArea,
	TeamConflict,
	type TeamEntry,
	type TeamFile,
	type TeamInvite,
	createConnectorTeamStore,
	formatTeamBytes,
	inviteCode,
	inviteLink,
	isAllowedAddress,
	newTeamFile,
	offersTeamTools,
	parseInvite,
	teamUsage,
} from '@ngomate/core'
import { type FormEvent, useEffect, useRef, useState } from 'react'
import type { Addon, NgomateHost, Settings, TeamHost, TeamLocation } from './host.js'
import { usePrimitives } from './primitives.js'
import type { Team } from './useTeam.js'

type Props = {
	host: NgomateHost & { team: TeamHost }
	settings: Settings
	onChange: (settings: Settings) => void
	team: Team
	onOpenConnectors: () => void
	/** An invite link the app was opened with, not yet looked at. */
	incomingInvite?: string | null
	onInviteSeen?: () => void
	/** Called once a team was set up or joined. */
	onDone?: () => void
	/** Asked from the menu: carried out once, then `onActionDone`. */
	action?: 'add' | 'copy-invite' | null
	onActionDone?: () => void
}

function folderName(path: string): string {
	return path.split(/[\\/]/).filter(Boolean).pop() ?? path
}

function message(err: unknown): string {
	return err instanceof Error ? err.message : String(err)
}

type Kind = TeamInvite['storage']['type']

/** Connectors that offer the team memory tools, found by asking each one connected over the web. */
async function teamConnectors(host: NgomateHost, addons: Addon[]): Promise<Addon[]> {
	const found: Addon[] = []
	for (const addon of addons.filter((candidate) => candidate.enabled)) {
		try {
			const source = await host.connectAddon(addon)
			try {
				if (offersTeamTools(await source.listTools())) found.push(addon)
			} finally {
				await source.close()
			}
		} catch {
			// One that cannot be reached is simply not offered.
		}
	}
	return found
}

/** The team a connector holds for this person, or null. */
async function connectorTeam(host: NgomateHost, addon: Addon): Promise<TeamFile | null> {
	const source = await host.connectAddon(addon)
	try {
		if (!offersTeamTools(await source.listTools())) return null
		return await createConnectorTeamStore(source).readTeamFile()
	} finally {
		await source.close()
	}
}

function S3Form({
	initial,
	onUse,
	working,
}: {
	initial?: { endpoint: string; region: string; bucket: string }
	onUse: (
		location: { endpoint: string; region: string; bucket: string; accessKeyId: string },
		secret: string,
	) => void
	working: boolean
}) {
	const { Button, Input } = usePrimitives()
	const [endpoint, setEndpoint] = useState(initial?.endpoint ?? '')
	const [region, setRegion] = useState(initial?.region ?? '')
	const [bucket, setBucket] = useState(initial?.bucket ?? '')
	const [accessKeyId, setAccessKeyId] = useState('')
	const [secret, setSecret] = useState('')
	const valid = isAllowedAddress(endpoint.trim()) && bucket.trim() && accessKeyId.trim() && secret
	return (
		<form
			className="ngm-form"
			onSubmit={(event) => {
				event.preventDefault()
				onUse(
					{
						endpoint: endpoint.trim(),
						region: region.trim() || 'us-east-1',
						bucket: bucket.trim(),
						accessKeyId: accessKeyId.trim(),
					},
					secret,
				)
			}}
		>
			{!initial && (
				<>
					<label>
						Endpoint
						<Input
							value={endpoint}
							onChange={(event) => setEndpoint(event.target.value)}
							placeholder="https://"
						/>
					</label>
					<label>
						Region, if the provider asks for one
						<Input value={region} onChange={(event) => setRegion(event.target.value)} />
					</label>
					<label>
						Bucket
						<Input value={bucket} onChange={(event) => setBucket(event.target.value)} />
					</label>
				</>
			)}
			<label>
				Access key ID
				<Input
					value={accessKeyId}
					onChange={(event) => setAccessKeyId(event.target.value)}
					autoComplete="off"
				/>
			</label>
			<label>
				Secret access key
				<Input
					type="password"
					value={secret}
					onChange={(event) => setSecret(event.target.value)}
					autoComplete="off"
				/>
			</label>
			<p className="ngm-muted">
				Kept in this computer's keychain. If the team shares one key, everyone with it can read and
				change every team note, and nothing records who wrote what.
			</p>
			<div className="ngm-row">
				<Button type="submit" variant="primary" disabled={working || !valid}>
					Connect to the bucket
				</Button>
			</div>
		</form>
	)
}

const NEXTCLOUD_FILES = /^(.*?)\/remote\.php\/dav\/files\/[^/]+\/(.*?)\/?$/

/**
 * A Nextcloud folder address, split into the server and the folder: the folder is the same for each
 * person it is shared with, the account part of the address is not.
 */
function nextcloudParts(url: string): { server: string; folder: string } | null {
	const match = url.match(NEXTCLOUD_FILES)
	if (!match) return null
	try {
		return { server: match[1] ?? '', folder: decodeURIComponent(match[2] ?? '') }
	} catch {
		return null
	}
}

function nextcloudFolderUrl(server: string, loginName: string, folder: string): string {
	const path = folder
		.split('/')
		.map((part) => part.trim())
		.filter(Boolean)
		.map(encodeURIComponent)
		.join('/')
	return `${server.replace(/\/+$/, '')}/remote.php/dav/files/${encodeURIComponent(loginName)}/${path}`
}

function WebdavForm({
	host,
	inviteUrl,
	nextcloudInvite,
	onUse,
	working,
}: {
	host: NgomateHost & { team: TeamHost }
	/** A plain WebDAV invite: the folder's address is the same for everyone. */
	inviteUrl?: string
	/** A Nextcloud invite: the server and the folder's name, each person's own address to it differs. */
	nextcloudInvite?: { server: string; folder: string }
	onUse: (location: { url: string; user: string }, password: string) => void
	working: boolean
}) {
	const { Button, Input } = usePrimitives()
	const fromInvite = nextcloudInvite ?? (inviteUrl ? nextcloudParts(inviteUrl) : null)
	const login = host.team.nextcloudLogin
	const [kind, setKind] = useState<'nextcloud' | 'other'>(
		login && (!inviteUrl || fromInvite) ? 'nextcloud' : 'other',
	)
	const [server, setServer] = useState(fromInvite?.server ?? '')
	const [folder, setFolder] = useState(fromInvite?.folder ?? 'NGOmate team')
	const [signIn, setSignIn] = useState<{ loginUrl: string } | null>(null)
	const [signedIn, setSignedIn] = useState<{
		server: string
		loginName: string
		appPassword: string
	} | null>(null)
	const [url, setUrl] = useState(inviteUrl ?? '')
	const [user, setUser] = useState('')
	const [password, setPassword] = useState('')
	const [problem, setProblem] = useState<string | null>(null)
	// Each sign-in counts; one the person gave up on may still finish, and is then ignored.
	const attempt = useRef(0)

	const startSignIn = async () => {
		if (!login) return
		const mine = ++attempt.current
		setProblem(null)
		try {
			const started = await login.start(server.trim())
			if (mine !== attempt.current) return
			setSignIn({ loginUrl: started.loginUrl })
			const done = await login.wait(started.pollUrl, started.token)
			if (mine === attempt.current) setSignedIn(done)
		} catch (err) {
			if (mine === attempt.current) setProblem(message(err))
		} finally {
			if (mine === attempt.current) setSignIn(null)
		}
	}

	if (kind === 'nextcloud' && login) {
		return (
			<div className="ngm-form">
				{!signedIn ? (
					<>
						<label>
							Your Nextcloud address
							<Input
								value={server}
								onChange={(event) => setServer(event.target.value)}
								placeholder="https://"
								readOnly={Boolean(fromInvite)}
							/>
						</label>
						{signIn ? (
							<p>
								<a href={signIn.loginUrl} target="_blank" rel="noreferrer">
									Open the Nextcloud sign-in page
								</a>{' '}
								and allow NGOmate there. This page carries on by itself.{' '}
								<Button
									variant="quiet"
									onClick={() => {
										attempt.current++
										setSignIn(null)
									}}
								>
									Cancel
								</Button>
							</p>
						) : (
							<div className="ngm-row">
								<Button
									variant="primary"
									disabled={!isAllowedAddress(server.trim())}
									onClick={startSignIn}
								>
									Sign in with Nextcloud
								</Button>
								<Button variant="quiet" onClick={() => setKind('other')}>
									Another WebDAV server
								</Button>
							</div>
						)}
					</>
				) : (
					<form
						className="ngm-form"
						onSubmit={(event) => {
							event.preventDefault()
							onUse(
								{
									url: nextcloudFolderUrl(signedIn.server, signedIn.loginName, folder),
									user: signedIn.loginName,
								},
								signedIn.appPassword,
							)
						}}
					>
						<p className="ngm-muted">
							Signed in as {signedIn.loginName}. Nextcloud made a password for this app, which you
							can revoke there.
						</p>
						<label>
							The team folder in your Nextcloud files
							<Input value={folder} onChange={(event) => setFolder(event.target.value)} />
						</label>
						<div className="ngm-row">
							<Button type="submit" variant="primary" disabled={working || !folder.trim()}>
								Use this folder
							</Button>
						</div>
					</form>
				)}
				{problem && <p className="ngm-error">{problem}</p>}
			</div>
		)
	}

	return (
		<form
			className="ngm-form"
			onSubmit={(event) => {
				event.preventDefault()
				onUse({ url: url.trim(), user: user.trim() }, password)
			}}
		>
			<label>
				The team folder's WebDAV address
				<Input
					value={url}
					onChange={(event) => setUrl(event.target.value)}
					placeholder="https://"
					readOnly={Boolean(inviteUrl)}
				/>
			</label>
			<label>
				User name
				<Input value={user} onChange={(event) => setUser(event.target.value)} autoComplete="off" />
			</label>
			<label>
				Password, preferably one made for this app
				<Input
					type="password"
					value={password}
					onChange={(event) => setPassword(event.target.value)}
					autoComplete="off"
				/>
			</label>
			<div className="ngm-row">
				<Button
					type="submit"
					variant="primary"
					disabled={working || !isAllowedAddress(url.trim()) || !user.trim() || !password}
				>
					Connect to the folder
				</Button>
				{login && (
					<Button variant="quiet" onClick={() => setKind('nextcloud')}>
						Sign in with Nextcloud instead
					</Button>
				)}
			</div>
		</form>
	)
}

function ConnectorPicker({
	host,
	addons,
	onPick,
	onOpenConnectors,
	working,
}: {
	host: NgomateHost
	addons: Addon[]
	onPick: (addon: Addon) => void
	onOpenConnectors: () => void
	working: boolean
}) {
	const { Button } = usePrimitives()
	const [found, setFound] = useState<Addon[] | null>(null)
	useEffect(() => {
		let current = true
		teamConnectors(host, addons).then((list) => current && setFound(list))
		return () => {
			current = false
		}
	}, [host, addons])
	if (!found) return <p className="ngm-muted">Looking for connectors that can hold a team…</p>
	if (!found.length) {
		return (
			<div className="ngm-row">
				<span className="ngm-muted">None of your connectors can hold a team's notes.</span>
				<Button onClick={onOpenConnectors}>Open Connectors</Button>
			</div>
		)
	}
	return (
		<div className="ngm-row">
			{found.map((addon) => (
				<Button key={addon.id} disabled={working} onClick={() => onPick(addon)}>
					{addon.name}
				</Button>
			))}
		</div>
	)
}

/** No team yet: set one up, or join one from an invite. */
function NoTeam({
	host,
	settings,
	onChange,
	team,
	incomingInvite,
	onInviteSeen,
	onOpenConnectors,
	onDone,
}: Props) {
	const { Button, Input, Select, TextArea } = usePrimitives()
	const [mode, setMode] = useState<'setup' | 'join' | null>(null)
	const [kind, setKind] = useState<Kind>('folder')
	const [name, setName] = useState('')
	const [yourName, setYourName] = useState(settings.yourName ?? '')
	const [pasted, setPasted] = useState('')
	const [invite, setInvite] = useState<TeamInvite | null>(null)
	const [problem, setProblem] = useState<string | null>(null)
	const [working, setWorking] = useState(false)

	// A link opened from outside fills in the invite; nothing happens until the person goes on.
	useEffect(() => {
		if (!incomingInvite) return
		onInviteSeen?.()
		setMode('join')
		setPasted(incomingInvite)
		setProblem(null)
		try {
			setInvite(parseInvite(incomingInvite))
		} catch (err) {
			setInvite(null)
			setProblem(message(err))
		}
	}, [incomingInvite, onInviteSeen])

	const rememberName = () => {
		if (yourName.trim() !== (settings.yourName ?? ''))
			onChange({ ...settings, yourName: yourName.trim() })
	}

	// The teams before this attempt, so a failed one is undone without touching a team already there.
	const before = useRef<{ active: string | null; count: number } | null>(null)
	const undo = async () => {
		const now = await host.team.teams()
		if (before.current && now.teams.length > before.current.count) await host.team.forget()
		else if (before.current?.active) await host.team.switchTo(before.current.active)
	}

	/**
	 * After the storage is chosen: joining needs the invited team to be there; setting up writes the
	 * team file, or joins the team already there. Anything else is undone again.
	 */
	const finish = async (found: TeamFile | null, editable: boolean) => {
		if (mode === 'join' && invite) {
			if (!found) {
				await undo()
				throw new Error(
					invite.storage.type === 'folder'
						? `There is no team in that folder. Pick the folder called “${invite.storage.folderName}”. If it was just shared with you, wait until your sync app has brought it in.`
						: 'There is no team there for your account.',
				)
			}
			if (found.name !== invite.team) {
				await undo()
				throw new Error(`That holds the team ${found.name}, not ${invite.team}.`)
			}
		} else if (!found) {
			if (!editable) {
				await undo()
				throw new Error('The connector has no team set up for your account.')
			}
			await host.team.writeTeamFile(newTeamFile(name, yourName), null)
		} else {
			setProblem(
				`This already holds the team ${found.name}, so you have joined it instead of setting up a new one.`,
			)
		}
		rememberName()
		await team.refresh()
		onDone?.()
	}

	const run = async (work: () => Promise<void>) => {
		setProblem(null)
		setWorking(true)
		try {
			const listed = await host.team.teams()
			before.current = { active: listed.active, count: listed.teams.length }
			await work()
		} catch (err) {
			setProblem(message(err))
		} finally {
			setWorking(false)
		}
	}

	const useFolder = () =>
		run(async () => {
			if (mode === 'setup') newTeamFile(name, yourName)
			if (!(await host.team.chooseFolder())) return
			await finish((await host.team.readTeamFile().catch(() => null))?.team ?? null, true)
		})

	const useConnector = (addon: Addon) =>
		run(async () => {
			const found = await connectorTeam(host, addon)
			await host.team.use({ type: 'connector', addonId: addon.id })
			await finish(found, false)
		})

	const useS3 = (
		location: { endpoint: string; region: string; bucket: string; accessKeyId: string },
		secret: string,
	) =>
		run(async () => {
			if (mode === 'setup') newTeamFile(name, yourName)
			await host.team.use({ type: 's3', ...location }, secret)
			await finish((await host.team.readTeamFile().catch(() => null))?.team ?? null, true)
		})

	const useWebdav = (location: { url: string; user: string }, password: string) =>
		run(async () => {
			if (mode === 'setup') newTeamFile(name, yourName)
			await host.team.use({ type: 'webdav', ...location }, password)
			await finish((await host.team.readTeamFile().catch(() => null))?.team ?? null, true)
		})

	const storageStep = (which: Kind) => {
		switch (which) {
			case 'folder':
				return (
					<div className="ngm-row">
						<Button
							variant="primary"
							disabled={working || (mode === 'setup' && !name.trim())}
							onClick={useFolder}
						>
							{mode === 'join' ? 'Choose the folder' : 'Choose the shared folder'}
						</Button>
					</div>
				)
			case 'connector':
				return (
					<ConnectorPicker
						host={host}
						addons={
							mode === 'join' && invite?.storage.type === 'connector'
								? settings.addons.filter(
										(addon) =>
											addon.connection.kind === 'http' &&
											invite.storage.type === 'connector' &&
											addon.connection.url === invite.storage.url,
									)
								: settings.addons
						}
						onPick={useConnector}
						onOpenConnectors={onOpenConnectors}
						working={working}
					/>
				)
			case 's3':
				return (
					<S3Form
						initial={invite?.storage.type === 's3' ? invite.storage : undefined}
						onUse={useS3}
						working={working || (mode === 'setup' && !name.trim())}
					/>
				)
			case 'webdav':
			case 'nextcloud':
				return (
					<WebdavForm
						host={host}
						inviteUrl={invite?.storage.type === 'webdav' ? invite.storage.url : undefined}
						nextcloudInvite={invite?.storage.type === 'nextcloud' ? invite.storage : undefined}
						onUse={useWebdav}
						working={working || (mode === 'setup' && !name.trim())}
					/>
				)
		}
	}

	return (
		<>
			<p className="ngm-muted">
				A team shares memory notes and ready-made tasks through storage it already has: a folder
				your sync app shares (Google Drive, OneDrive, Dropbox, Nextcloud, Syncthing), a folder on
				Nextcloud or another WebDAV server, S3 storage, or a connector that can hold a team. Nothing
				goes to us.
			</p>
			<div className="ngm-row">
				<Button variant={mode === 'setup' ? 'primary' : 'default'} onClick={() => setMode('setup')}>
					Set up a team
				</Button>
				<Button variant={mode === 'join' ? 'primary' : 'default'} onClick={() => setMode('join')}>
					Join a team
				</Button>
			</div>

			{mode && (
				<label>
					Your name, as the team will see it
					<Input value={yourName} onChange={(event) => setYourName(event.target.value)} />
				</label>
			)}

			{mode === 'setup' && (
				<div className="ngm-form">
					<label>
						The team's name
						<Input value={name} onChange={(event) => setName(event.target.value)} required />
					</label>
					<label>
						Where the team keeps its notes
						<Select value={kind} onChange={(event) => setKind(event.target.value as Kind)}>
							<option value="folder">A folder my sync app shares</option>
							<option value="webdav">Nextcloud or another WebDAV server</option>
							<option value="s3">S3 storage</option>
							<option value="connector">A connector</option>
						</Select>
					</label>
					<p className="ngm-muted">
						Everyone who can reach that storage can read and change the team's notes and tasks.
					</p>
					{storageStep(kind)}
				</div>
			)}

			{mode === 'join' && !invite && (
				<form
					className="ngm-form"
					onSubmit={(event) => {
						event.preventDefault()
						setProblem(null)
						try {
							setInvite(parseInvite(pasted))
						} catch (err) {
							setProblem(message(err))
						}
					}}
				>
					<label>
						The invite you were sent, a link or a code
						<TextArea rows={3} value={pasted} onChange={(event) => setPasted(event.target.value)} />
					</label>
					<div className="ngm-row">
						<Button type="submit" variant="primary" disabled={!pasted.trim()}>
							Read the invite
						</Button>
					</div>
				</form>
			)}

			{mode === 'join' && invite && (
				<div className="ngm-card">
					<strong>Join {invite.team}</strong>
					<p>{inviteWords(invite)}</p>
					{storageStep(invite.storage.type)}
					<div className="ngm-row">
						<Button onClick={() => setInvite(null)}>Back</Button>
					</div>
				</div>
			)}

			{problem && <p className="ngm-error">{problem}</p>}
		</>
	)
}

/** What joining needs, with the exact address shown: an invite can come from anyone. */
function inviteWords(invite: TeamInvite): string {
	const where = invite.storage
	switch (where.type) {
		case 'folder':
			return `This team keeps its notes in a shared folder called “${where.folderName}”. Make sure it has been shared with you and that your sync app has it, then pick it.`
		case 'connector':
			return `This team keeps its notes with the connector at ${where.url}. Connect it under Connectors with your own account first, then pick it here.`
		case 's3':
			return `This team keeps its notes in the bucket “${where.bucket}” at ${where.endpoint}. Enter the key the person who set up the team gave you. Never send a key in a chat.`
		case 'webdav':
			return `This team keeps its notes in a folder on the server at ${new URL(where.url).origin}. Make sure the folder has been shared with you, then sign in with your own account.`
		case 'nextcloud':
			return `This team keeps its notes in the folder “${where.folder}” on the Nextcloud at ${where.server}. Make sure it has been shared with you, then sign in with your own account.`
	}
}

function UsageLine({ label, usage }: { label: string; usage: ReturnType<typeof teamUsage> }) {
	return (
		<p className={usage.nearlyFull ? 'ngm-error' : 'ngm-muted'}>
			{label}: {formatTeamBytes(usage.used)} of {formatTeamBytes(usage.limit)}
			{usage.full ? ', full' : usage.nearlyFull ? ', nearly full' : ''}
		</p>
	)
}

function LimitsForm({
	file,
	onSave,
}: { file: TeamFile; onSave: (file: TeamFile) => Promise<void> }) {
	const { Button, Input } = usePrimitives()
	const [notesMb, setNotesMb] = useState(String(file.limits.notesBytes / 1_000_000))
	const [noteKb, setNoteKb] = useState(String(file.limits.noteBytes / 1_000))
	const [tasksMb, setTasksMb] = useState(String(file.limits.tasksBytes / 1_000_000))
	const valid = [notesMb, noteKb, tasksMb].every((value) => Number(value) > 0)
	return (
		<form
			className="ngm-form"
			onSubmit={async (event) => {
				event.preventDefault()
				await onSave({
					...file,
					limits: {
						notesBytes: Math.round(Number(notesMb) * 1_000_000),
						noteBytes: Math.round(Number(noteKb) * 1_000),
						tasksBytes: Math.round(Number(tasksMb) * 1_000_000),
					},
				})
			}}
		>
			<label>
				All team notes, in MB
				<Input
					inputMode="decimal"
					value={notesMb}
					onChange={(event) => setNotesMb(event.target.value)}
				/>
			</label>
			<label>
				One team note, in KB
				<Input
					inputMode="decimal"
					value={noteKb}
					onChange={(event) => setNoteKb(event.target.value)}
				/>
			</label>
			<label>
				All team tasks, in MB
				<Input
					inputMode="decimal"
					value={tasksMb}
					onChange={(event) => setTasksMb(event.target.value)}
				/>
			</label>
			<div className="ngm-row">
				<Button type="submit" disabled={!valid}>
					Save limits
				</Button>
			</div>
		</form>
	)
}

function SuggestForm({ onAdd }: { onAdd: (name: string, url: string) => Promise<void> }) {
	const { Button, Input } = usePrimitives()
	const [name, setName] = useState('')
	const [url, setUrl] = useState('')
	return (
		<form
			className="ngm-form"
			onSubmit={async (event) => {
				event.preventDefault()
				await onAdd(name.trim(), url.trim())
				setName('')
				setUrl('')
			}}
		>
			<label>
				Name
				<Input value={name} onChange={(event) => setName(event.target.value)} />
			</label>
			<label>
				Address
				<Input
					value={url}
					onChange={(event) => setUrl(event.target.value)}
					placeholder="https://"
				/>
			</label>
			<div className="ngm-row">
				<Button type="submit" disabled={!name.trim() || !isAllowedAddress(url.trim())}>
					Suggest to the team
				</Button>
			</div>
		</form>
	)
}

const ACCESS_WORDS: Record<TeamLocation['type'], string> = {
	folder:
		'Everyone who has this folder can read and change every team note and task. Who has it is set in your sync app, not here: to remove someone, stop sharing the folder with them. Changes reach the others while their sync app runs.',
	s3: 'Everyone with a key to this bucket can read and change every team note and task. Keys are made and taken back with your storage provider, not here.',
	webdav:
		'Everyone the folder on the server is shared with can read and change every team note and task. Sharing is set on the server, not here.',
	connector: "Who can read and change the team's notes is decided by the connector's service.",
}

const INVITE_FIRST: Record<TeamLocation['type'], string> = {
	folder: 'Share the folder with them first.',
	s3: 'Give them a key for the bucket first, by a safer way than a chat.',
	webdav: 'Share the folder on the server with them first.',
	connector: 'They need their own account with the service.',
}

/** Where the team is, as an invite carries it: never the key or the password. */
function inviteStorage(
	location: TeamLocation,
	connectorUrl: (id: string) => string | null,
): TeamInvite['storage'] | null {
	switch (location.type) {
		case 'folder':
			return { type: 'folder', folderName: folderName(location.path) }
		case 'connector': {
			const url = connectorUrl(location.addonId)
			return url ? { type: 'connector', url } : null
		}
		case 's3':
			return {
				type: 's3',
				endpoint: location.endpoint,
				region: location.region,
				bucket: location.bucket,
			}
		case 'webdav': {
			// Never the inviter's own account, which a Nextcloud address carries.
			const nextcloud = nextcloudParts(location.url)
			return nextcloud ? { type: 'nextcloud', ...nextcloud } : { type: 'webdav', url: location.url }
		}
	}
}

/** The invite for the team shown, or null when it has no place others can reach. */
export function teamInvite(
	file: TeamFile | null,
	location: TeamLocation | null,
	addons: Addon[],
): TeamInvite | null {
	const connectorUrl = (id: string) => {
		const addon = addons.find((candidate) => candidate.id === id)
		return addon?.connection.kind === 'http' ? addon.connection.url : null
	}
	const storage = location ? inviteStorage(location, connectorUrl) : null
	return file && storage ? { format: 1, team: file.name, storage } : null
}

function locationWords(location: TeamLocation, addons: Addon[]): string {
	switch (location.type) {
		case 'folder':
			return `in the shared folder ${location.path}`
		case 'connector':
			return `by the connector ${addons.find((addon) => addon.id === location.addonId)?.name ?? 'that was removed'}`
		case 's3':
			return `in the bucket ${location.bucket} at ${location.endpoint}`
		case 'webdav':
			return `on ${location.url}`
	}
}

export function TeamPanel(props: Props) {
	const { host, settings, team, onOpenConnectors } = props
	const { Button, Input } = usePrimitives()
	const [entries, setEntries] = useState<Record<'notes' | 'tasks', TeamEntry[]>>({
		notes: [],
		tasks: [],
	})
	const [problem, setProblem] = useState<string | null>(null)
	const [copied, setCopied] = useState<string | null>(null)
	const { file, location, store } = team
	const [adding, setAdding] = useState(false)

	useEffect(() => {
		if (!file || !store) return
		Promise.all([store.list('notes'), store.list('tasks')])
			.then(([notes, tasks]) => setEntries({ notes, tasks }))
			.catch(() => {})
	}, [store, file])

	const saveFile = async (next: TeamFile) => {
		setProblem(null)
		try {
			await host.team.writeTeamFile(next, team.version)
		} catch (err) {
			setProblem(
				err instanceof TeamConflict
					? 'Someone in the team changed the team settings meanwhile. Check them and save again.'
					: message(err),
			)
		}
		await team.refresh()
	}

	const copy = (text: string, what: string) =>
		navigator.clipboard.writeText(text).then(
			() => setCopied(what),
			() => setProblem('Could not copy. Select the text and copy it yourself.'),
		)

	const invite = teamInvite(file, location, settings.addons)
	const inviteText = invite ? inviteLink(invite) : null
	const { action, onActionDone } = props
	// biome-ignore lint/correctness/useExhaustiveDependencies: carried out once per request
	useEffect(() => {
		if (!action) return
		if (action === 'add') setAdding(true)
		if (action === 'copy-invite' && inviteText) copy(inviteText, 'link')
		onActionDone?.()
	}, [action])

	const incoming = (() => {
		try {
			return props.incomingInvite ? parseInvite(props.incomingInvite) : null
		} catch {
			return null
		}
	})()
	const knownTeam = incoming
		? team.memberships.find((membership) => membership.name === incoming.team)
		: undefined

	if (!location || adding || (props.incomingInvite && !knownTeam)) {
		return (
			<section className="ngm-panel">
				<h2>{location ? 'Another team' : 'Teams'}</h2>
				<NoTeam {...props} onDone={() => setAdding(false)} />
				{location && (
					<div className="ngm-row">
						<Button
							onClick={() => {
								setAdding(false)
								props.onInviteSeen?.()
							}}
						>
							Back to {file?.name ?? 'your team'}
						</Button>
					</div>
				)}
			</section>
		)
	}

	const notConnected = (file?.connectors ?? []).filter(
		(item) =>
			!settings.addons.some(
				(addon) => addon.connection.kind === 'http' && addon.connection.url === item.url,
			),
	)

	return (
		<section className="ngm-panel">
			<h2>{file ? file.name : 'Teams'}</h2>
			<p className="ngm-muted">
				Kept {locationWords(location, settings.addons)}
				{file?.createdBy ? `, set up by ${file.createdBy}` : ''}.
			</p>
			{props.incomingInvite && knownTeam && (
				<div className="ngm-card">
					<p>You opened an invite to {knownTeam.name}, and you are already in it.</p>
					<div className="ngm-row">
						{knownTeam.id !== team.activeId && (
							<Button
								variant="primary"
								onClick={async () => {
									props.onInviteSeen?.()
									await team.switchTo(knownTeam.id)
								}}
							>
								Switch to it
							</Button>
						)}
						<Button onClick={() => props.onInviteSeen?.()}>OK</Button>
					</div>
				</div>
			)}
			{!team.refusesOverwrites && (
				<p className="ngm-error">
					When the app tested this storage, it did not refuse to save over a note that had changed.
					If two people save the same note at once, the last save wins without a warning.
				</p>
			)}
			{team.problem && (
				<div className="ngm-card">
					<p className="ngm-error">{team.problem}</p>
					<div className="ngm-row">
						<Button onClick={() => team.refresh()}>Try again</Button>
						{location.type === 'folder' && (
							<Button onClick={() => host.team.chooseFolder().then(() => team.refresh())}>
								Choose the folder again
							</Button>
						)}
					</div>
				</div>
			)}

			{file && invite && (
				<>
					<p className="ngm-muted">{ACCESS_WORDS[location.type]}</p>

					<h3>Invite someone</h3>
					<p className="ngm-muted">
						{INVITE_FIRST[location.type]} The invite only says where the team is, never a password
						or key.
					</p>
					<Input readOnly value={inviteLink(invite)} onFocus={(event) => event.target.select()} />
					<div className="ngm-row">
						<Button onClick={() => copy(inviteLink(invite), 'link')}>
							{copied === 'link' ? 'Link copied' : 'Copy link'}
						</Button>
						<Button onClick={() => copy(inviteCode(invite), 'code')}>
							{copied === 'code' ? 'Code copied' : 'Copy code'}
						</Button>
					</div>

					<h3>Space</h3>
					<UsageLine label="Team notes" usage={teamUsage(file.limits, 'notes', entries.notes)} />
					<UsageLine label="Team tasks" usage={teamUsage(file.limits, 'tasks', entries.tasks)} />
					{team.brokenTasks.length > 0 && (
						<p className="ngm-error">
							These team tasks cannot be read and are left out: {team.brokenTasks.join(', ')}.
						</p>
					)}
					{team.settingsEditable ? (
						<LimitsForm key={team.version ?? ''} file={file} onSave={saveFile} />
					) : (
						<p className="ngm-muted">
							The limits and the suggested connectors are set by the connector's service.
						</p>
					)}

					<h3>Connectors the team suggests</h3>
					{file.connectors.length === 0 && <p className="ngm-muted">None yet.</p>}
					{file.connectors.map((item) => (
						<div className="ngm-row" key={item.url}>
							<span>
								{item.name} <span className="ngm-muted">{item.url}</span>
							</span>
							<span className="ngm-grow" />
							{team.settingsEditable && (
								<Button
									variant="quiet"
									onClick={() =>
										saveFile({
											...file,
											connectors: file.connectors.filter((other) => other.url !== item.url),
										})
									}
								>
									Remove
								</Button>
							)}
						</div>
					))}
					{notConnected.length > 0 && (
						<div className="ngm-row">
							<span className="ngm-muted">
								You have not connected {notConnected.map((item) => item.name).join(', ')} yet. Each
								person signs in with their own account.
							</span>
							<Button onClick={onOpenConnectors}>Open Connectors</Button>
						</div>
					)}
					{team.settingsEditable && (
						<SuggestForm
							onAdd={(name, url) =>
								saveFile({
									...file,
									connectors: [
										...file.connectors.filter((other) => other.url !== url),
										{ name, url },
									],
								})
							}
						/>
					)}
				</>
			)}

			{problem && <p className="ngm-error">{problem}</p>}

			<h3>Your teams</h3>
			<p className="ngm-muted">
				The active team's notes and tasks are the ones the assistant uses. Switching changes nothing
				in any team, and your own notes stay the same.
			</p>
			{team.memberships.map((membership) => (
				<div className="ngm-row" key={membership.id}>
					<span>
						{membership.name ?? 'A team not read yet'}{' '}
						<span className="ngm-muted">{locationWords(membership.location, settings.addons)}</span>
					</span>
					<span className="ngm-grow" />
					{membership.id === team.activeId ? (
						<span className="ngm-muted">Active</span>
					) : (
						<Button onClick={() => team.switchTo(membership.id)}>Switch to it</Button>
					)}
				</div>
			))}
			<div className="ngm-row">
				<Button onClick={() => setAdding(true)}>Join or set up another team</Button>
			</div>

			<h3>Leave</h3>
			<p className="ngm-muted">
				Stops using this team on this computer. Its notes and tasks stay where they are, and your
				own notes stay with you.
			</p>
			<div className="ngm-row">
				<Button
					onClick={async () => {
						await host.team.forget()
						await team.refresh()
					}}
				>
					Leave this team
				</Button>
			</div>
		</section>
	)
}
