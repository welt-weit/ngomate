#!/usr/bin/env node
// Sets the desktop app's version everywhere it is written, so a release tag can be checked against any of them.
//
//   yarn bump:patch | yarn bump:minor | yarn bump:major
//   node scripts/bump-version.mjs 0.2.0
//
// Then review the diff, commit, and tag `v<version>`.
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const app = join(dirname(fileURLToPath(import.meta.url)), '..', 'apps', 'desktop')
const files = {
	pkg: join(app, 'package.json'),
	conf: join(app, 'src-tauri', 'tauri.conf.json'),
	cargo: join(app, 'src-tauri', 'Cargo.toml'),
	lock: join(app, 'src-tauri', 'Cargo.lock'),
}

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-[\w.]+)?$/

function next(current, kind) {
	if (SEMVER.test(kind)) return kind
	const match = SEMVER.exec(current)
	if (!match) throw new Error(`The current version "${current}" is not a version number`)
	const [major, minor, patch] = match.slice(1, 4).map(Number)
	if (kind === 'patch') return `${major}.${minor}.${patch + 1}`
	if (kind === 'minor') return `${major}.${minor + 1}.0`
	if (kind === 'major') return `${major + 1}.0.0`
	throw new Error(`Expected patch, minor, major or a version number, not "${kind}"`)
}

function replaceOnce(text, pattern, replacement, where) {
	if (!pattern.test(text)) throw new Error(`No version found in ${where}`)
	return text.replace(pattern, replacement)
}

const kind = process.argv[2]
if (!kind) {
	console.error('Usage: bump-version.mjs <patch|minor|major|x.y.z>')
	process.exit(2)
}

const before = Object.fromEntries(
	Object.entries(files).map(([key, path]) => [key, readFileSync(path, 'utf8')]),
)
const current = JSON.parse(before.pkg).version
const version = next(current, kind)

// Every file is worked out before any is written, so a failure leaves them all as they were.
const after = {
	// Only the version line changes, so each file keeps its own formatting.
	pkg: replaceOnce(before.pkg, /^(\t"version": ")[^"]*(")/m, `$1${version}$2`, files.pkg),
	conf: replaceOnce(before.conf, /^(\t"version": ")[^"]*(")/m, `$1${version}$2`, files.conf),
	// The first `version =` is the package's own; dependencies come later.
	cargo: replaceOnce(
		before.cargo,
		/^version\s*=\s*"[^"]*"/m,
		`version = "${version}"`,
		files.cargo,
	),
	lock: replaceOnce(
		before.lock,
		/(\[\[package\]\]\nname = "ngomate-desktop"\nversion = ")[^"]*(")/,
		`$1${version}$2`,
		files.lock,
	),
}
for (const [key, text] of Object.entries(after)) writeFileSync(files[key], text)
console.log(`${current} → ${version}. Review the diff, commit, then tag v${version}.`)
