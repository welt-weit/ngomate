#!/usr/bin/env node
// Cuts, checks and publishes a release of the desktop app.
//
//   yarn release patch|minor|major|x.y.z   bump, commit, tag, and push development, main and the tag together
//   yarn release:check [x.y.z]             is the draft complete? (default: the app's current version)
//   yarn release:publish [x.y.z]           publish the draft, then test the website's download links
//   yarn promote                            move main to development without a release, and push both
//
// The Release workflow builds the installers into a draft when the tag arrives. Publishing that draft is
// what moves every "latest" download link, so check the installers before you publish.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { fileURLToPath } from 'node:url'

const REPO = 'welt-weit/ngomate'
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const VERSION_FILES = [
	'apps/desktop/package.json',
	'apps/desktop/src-tauri/tauri.conf.json',
	'apps/desktop/src-tauri/Cargo.toml',
	'apps/desktop/src-tauri/Cargo.lock',
]
// The copies the Release workflow attaches under fixed names, which the website and the README link to.
const FIXED_NAMES = [
	'NGOmate-mac-apple-silicon.dmg',
	'NGOmate-mac-intel.dmg',
	'NGOmate-windows-setup.exe',
	'NGOmate-linux.AppImage',
	'NGOmate-linux.deb',
	'NGOmate-linux.rpm',
]

const run = (command, args, options = {}) =>
	execFileSync(command, args, { cwd: root, encoding: 'utf8', ...options })
const quiet = (command, args) => run(command, args, { stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const loud = (command, args) => run(command, args, { stdio: 'inherit' })
const git = (...args) => quiet('git', args)
const succeeds = (command, args) => {
	try {
		quiet(command, args)
		return true
	} catch {
		return false
	}
}
const stop = (message) => {
	console.error(`\n✗ ${message}`)
	process.exit(1)
}
const appVersion = () =>
	JSON.parse(readFileSync(join(root, 'apps/desktop/src-tauri/tauri.conf.json'), 'utf8')).version

async function confirm(question) {
	if (process.argv.includes('--yes')) return true
	const prompt = createInterface({ input: process.stdin, output: process.stdout })
	const answer = await prompt.question(`${question} [y/N] `)
	prompt.close()
	return /^y(es)?$/i.test(answer.trim())
}

function preflight({ needsGitHubCli = true } = {}) {
	if (needsGitHubCli && !succeeds('gh', ['auth', 'status']))
		stop('The GitHub CLI is not signed in. Run: gh auth login')
	const branch = git('rev-parse', '--abbrev-ref', 'HEAD')
	if (branch !== 'development') stop(`main only moves to development, and this is ${branch}.`)
	if (git('status', '--porcelain', '--untracked-files=no'))
		stop('There are uncommitted changes. Commit or stash them first.')
	loud('git', ['fetch', '--quiet', '--tags', 'origin'])
	if (!succeeds('git', ['merge-base', '--is-ancestor', 'origin/development', 'HEAD']))
		stop('GitHub has development commits you do not. Pull first.')
	if (!succeeds('git', ['merge-base', '--is-ancestor', 'origin/main', 'HEAD']))
		stop(
			'main has commits development does not, so it cannot simply move forward. Merge main into development first.',
		)
}

async function cut(kind) {
	if (!kind) stop('Say which version: yarn release patch | minor | major | x.y.z')
	preflight()
	console.log('\nChecking the code before releasing it…')
	for (const script of ['build', 'lint', 'typecheck', 'test']) loud('yarn', [script])

	loud('node', ['scripts/bump-version.mjs', kind])
	const version = appVersion()
	const tag = `v${version}`
	if (git('tag', '--list', tag) || git('ls-remote', '--tags', 'origin', tag)) {
		// The tree was clean before the bump, so this only takes back the bump itself.
		loud('git', ['checkout', '--', ...VERSION_FILES])
		stop(`The tag ${tag} already exists. The version files are back as they were.`)
	}
	// Asking for the version the files already carry (a bump committed earlier) tags it without a new commit.
	const bumped = !succeeds('git', ['diff', '--quiet', '--', ...VERSION_FILES])
	if (bumped) {
		loud('git', ['add', ...VERSION_FILES])
		loud('git', ['commit', '--quiet', '-m', `chore(release): ${version}`])
	}
	loud('git', ['tag', '-a', tag, '-m', `NGOmate ${version}`])

	console.log(`\nReady: ${tag} on ${git('rev-parse', '--short', 'HEAD')}. Pushing will`)
	console.log('  · move development and main on GitHub to this commit (main publishes the website)')
	console.log(`  · push ${tag}, which starts the Release workflow (a draft, nothing public yet)`)
	if (!(await confirm('Push now?'))) {
		// Taken back here, so a later push of development cannot carry a release nobody tagged on GitHub.
		loud('git', ['tag', '-d', tag])
		if (bumped) loud('git', ['reset', '--quiet', '--keep', 'HEAD~1'])
		console.log('\nNothing pushed. The release commit and tag are undone.')
		return
	}
	// All three or none, so main never moves without its tag.
	loud('git', ['push', '--atomic', 'origin', 'development', 'development:main', tag])
	// GitHub refuses the workflow's own token when it creates a release in this repo (403 "Resource not
	// accessible by integration", since v0.0.2), though it may upload into one. So the draft is made here,
	// with the person's own sign-in. The builds take minutes before they look for it.
	if (!releaseOf(tag)) {
		loud('gh', [
			'release',
			'create',
			tag,
			'-R',
			REPO,
			'--draft',
			'--verify-tag',
			'--title',
			`NGOmate ${version}`,
			'--notes',
			'A preview build. See the README for what it needs and what is not finished.',
		])
	}
	console.log('\n✓ Pushed, and the draft is ready. The build takes about 20 to 30 minutes:')
	console.log(`  https://github.com/${REPO}/actions/workflows/release.yml`)
	console.log(`Then: yarn release:check ${version}`)
}

function releaseOf(tag) {
	try {
		return JSON.parse(
			quiet('gh', [
				'release',
				'view',
				tag,
				'-R',
				REPO,
				'--json',
				'isDraft,isPrerelease,assets,url',
			]),
		)
	} catch {
		return null
	}
}

function check(version) {
	const tag = `v${version}`
	const runs = JSON.parse(
		quiet('gh', [
			'run',
			'list',
			'-R',
			REPO,
			'--workflow',
			'release.yml',
			'--branch',
			tag,
			'--json',
			'status,conclusion,url',
			'--limit',
			'1',
		]),
	)
	const build = runs[0]
	if (!build) stop(`No Release run for ${tag} yet. Was the tag pushed?`)
	console.log(
		`Build: ${build.status}${build.conclusion ? `, ${build.conclusion}` : ''}  ${build.url}`,
	)
	if (build.status !== 'completed') stop('The build is still running. Check again later.')
	if (build.conclusion !== 'success')
		stop('The build did not succeed. Open the run above to see which system failed.')

	const release = releaseOf(tag)
	if (!release) stop(`The build finished but there is no release ${tag}.`)
	const names = new Set(release.assets.map((asset) => asset.name))
	const missing = FIXED_NAMES.filter((name) => !names.has(name))
	console.log(`Release: ${release.isDraft ? 'draft' : 'published'}  ${release.url}`)
	for (const name of FIXED_NAMES) console.log(`  ${names.has(name) ? '✓' : '✗'} ${name}`)
	if (missing.length)
		stop(`Missing: ${missing.join(', ')}. The website's buttons for these would not work.`)
	if (release.isPrerelease) stop('It is marked as a prerelease, which the "latest" links skip.')
	console.log('\n✓ Complete. Install it on a real computer, then: yarn release:publish')
	return release
}

async function linksWork(version) {
	let ok = true
	for (const name of FIXED_NAMES) {
		const url = `https://github.com/${REPO}/releases/latest/download/${name}`
		const response = await fetch(url, { method: 'HEAD', redirect: 'manual' })
		const target = response.headers.get('location') ?? ''
		const good = response.status === 302 && target.includes(`/v${version}/`)
		ok &&= good
		console.log(
			`  ${good ? '✓' : '✗'} ${name}${good ? '' : ` (${response.status}${target ? ` → ${target}` : ''})`}`,
		)
	}
	return ok
}

/**
 * The build writes latest.json while the release is a draft, so it points at GitHub API addresses
 * (api.github.com/…/assets/<id>). Those need a special request and allow about 60 an hour per internet
 * address without sign-in, which an office or school network shares. So before publishing, each one is
 * replaced with the plain download address of this version's file of the same name.
 */
function useDownloadLinksForUpdates(version) {
	const tag = `v${version}`
	// `gh release view` sees a draft, which the API's release-by-tag does not.
	const { assets } = JSON.parse(
		quiet('gh', ['release', 'view', tag, '-R', REPO, '--json', 'assets']),
	)
	if (!assets.some((asset) => asset.name === 'latest.json')) {
		console.log('No latest.json in this release, so installed copies are not offered it.')
		return
	}
	const names = new Map(assets.map((asset) => [asset.apiUrl, asset.name]))
	const work = mkdtempSync(join(tmpdir(), 'ngomate-release-'))
	try {
		loud('gh', ['release', 'download', tag, '-R', REPO, '-p', 'latest.json', '-D', work])
		const file = join(work, 'latest.json')
		const manifest = JSON.parse(readFileSync(file, 'utf8'))
		for (const [system, entry] of Object.entries(manifest.platforms ?? {})) {
			if (!entry.url.startsWith('https://api.github.com/')) continue
			const name = names.get(entry.url)
			if (!name) stop(`latest.json names a file this release does not have (${system}).`)
			entry.url = `https://github.com/${REPO}/releases/download/${tag}/${encodeURIComponent(name)}`
		}
		writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`)
		loud('gh', ['release', 'upload', tag, file, '-R', REPO, '--clobber'])
	} finally {
		rmSync(work, { recursive: true, force: true })
	}
}

/** Installed copies read latest.json from the newest release and download what it names. */
async function updatesWork(version) {
	const response = await fetch(`https://github.com/${REPO}/releases/latest/download/latest.json`)
	if (!response.ok) {
		console.log('  (no latest.json, so no update is offered)')
		return true
	}
	const manifest = await response.json()
	let ok = manifest.version === version
	console.log(`  ${ok ? '✓' : '✗'} latest.json offers ${manifest.version}`)
	for (const [system, entry] of Object.entries(manifest.platforms ?? {})) {
		const reply = await fetch(entry.url, { method: 'HEAD', redirect: 'manual' })
		const good = reply.status === 302 && Boolean(entry.signature)
		ok &&= good
		if (!good) console.log(`  ✗ ${system} (${reply.status}${entry.signature ? '' : ', unsigned'})`)
	}
	if (ok) console.log("  ✓ every system's update downloads, signed")
	return ok
}

async function publish(version) {
	const release = check(version)
	if (release.isDraft) {
		if (
			!(await confirm(`Publish v${version}? Every download link on the website will point to it.`))
		)
			return console.log('Not published.')
		useDownloadLinksForUpdates(version)
		loud('gh', ['release', 'edit', `v${version}`, '-R', REPO, '--draft=false'])
	}
	console.log("\nThe website's download links:")
	if (!(await linksWork(version)))
		stop('Some links do not lead to this release yet. Try again in a minute.')
	console.log('\nUpdates for installed copies:')
	if (!(await updatesWork(version)))
		stop('Installed copies cannot update to this release yet. Try again in a minute.')
	console.log('\n✓ Published, every download link works, and installed copies are offered it.')
}

/** Code on main without a new version, for when a release is not wanted yet. No tag, so no build. */
async function promote() {
	preflight({ needsGitHubCli: false })
	const ahead = git('rev-list', '--count', 'origin/main..HEAD')
	if (ahead === '0') return console.log('main already has everything on development.')
	console.log(
		`\nmain moves forward by ${ahead} commit(s) to ${git('rev-parse', '--short', 'HEAD')}:`,
	)
	console.log(git('log', '--oneline', 'origin/main..HEAD'))
	const site = git('diff', '--name-only', 'origin/main', 'HEAD', '--', 'apps/site')
	if (site)
		console.log(`\n! This changes the website, which goes live when main is pushed:\n${site}`)
	if (!(await confirm('Push development and main now?'))) return console.log('Nothing pushed.')
	// Both or neither, so main never holds a commit development does not.
	loud('git', ['push', '--atomic', 'origin', 'development', 'development:main'])
	console.log('\n✓ main is at development on GitHub.')
}

const [command, argument] = process.argv.slice(2).filter((arg) => !arg.startsWith('--'))
if (command === 'cut') await cut(argument)
else if (command === 'check') check(argument ?? appVersion())
else if (command === 'publish') await publish(argument ?? appVersion())
else if (command === 'promote') await promote()
else
	stop(
		'Usage: release.mjs cut <patch|minor|major|x.y.z> | check [x.y.z] | publish [x.y.z] | promote',
	)
