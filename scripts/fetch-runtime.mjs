#!/usr/bin/env node
// Downloads the pinned llama.cpp server for this platform into the desktop app's bundle folder.
// The checksums are of the release archives, so a changed download fails rather than ships.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
	cpSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const BUILD = 'b12072'
const ARCHIVES = {
	'darwin-arm64': [
		'macos-arm64.tar.gz',
		'759a1c2484b93e3977778d7db0ec021ab6197be88947e0df8a622ecb00212484',
	],
	'darwin-x64': [
		'macos-x64.tar.gz',
		'98ec3c86b6d20570c94f948d51e52bd6321d1fb16ced753967f06cb5a6b3dc54',
	],
	'linux-x64': [
		'ubuntu-vulkan-x64.tar.gz',
		'8b1c658f638c46f5348da0075425d46bc2d41c4e1d743cb9c568adcb4b544fa6',
	],
	'win32-x64': [
		'win-vulkan-x64.zip',
		'402b46162187ee4a982abab0335f19f32d9ea52e19f78635715814a6c6d8cfa3',
	],
}

const here = dirname(fileURLToPath(import.meta.url))
const target = join(here, '..', 'apps', 'desktop', 'src-tauri', 'runtime')
const marker = join(target, 'BUILD')
const platform = `${process.platform}-${process.arch}`
const archive = ARCHIVES[platform]
if (!archive) throw new Error(`No pinned llama.cpp build for ${platform}`)

if (
	!process.argv.includes('--force') &&
	existsSync(marker) &&
	readFileSync(marker, 'utf8').trim() === `${BUILD}-${platform}`
) {
	console.log(`llama.cpp ${BUILD} is already in place.`)
	process.exit(0)
}

const [suffix, sha256] = archive
const name = `llama-${BUILD}-bin-${suffix}`
const url = `https://github.com/ggml-org/llama.cpp/releases/download/${BUILD}/${name}`
console.log(`Downloading ${url}`)
const response = await fetch(url)
if (!response.ok) throw new Error(`Download failed: ${response.status}`)
const bytes = Buffer.from(await response.arrayBuffer())
const actual = createHash('sha256').update(bytes).digest('hex')
if (actual !== sha256) throw new Error(`Checksum mismatch: expected ${sha256}, got ${actual}`)

const work = mkdtempSync(join(tmpdir(), 'ngomate-runtime-'))
try {
	const file = join(work, name)
	writeFileSync(file, bytes)
	const unpacked = join(work, 'unpacked')
	mkdirSync(unpacked)
	execFileSync('tar', ['-xf', file, '-C', unpacked])
	const inner = readdirSync(unpacked)
	const source = inner.length === 1 ? join(unpacked, inner[0]) : unpacked
	rmSync(target, { recursive: true, force: true })
	mkdirSync(target, { recursive: true })
	// Only the server, its libraries and the licences. The archive also holds dozens of other tools.
	const needed = (entry) =>
		/^llama-server(\.exe)?$/.test(entry) ||
		(/\.(dylib|so|dll|metal)(\.|$)/.test(entry) &&
			!/^(lib)?llama-(?!common|server).*impl/.test(entry)) ||
		/licen[cs]e/i.test(entry)
	// An installer turns symlinks into copies, which stored every library three times. So one file per
	// library, under the name the programs load it by: libggml.0.dylib, not libggml.0.28.0.dylib.
	const entries = readdirSync(source).filter(needed)
	const isLink = (entry) => lstatSync(join(source, entry)).isSymbolicLink()
	const loadedBy = /\.\d+\.dylib$|\.so\.\d+$/
	const reached = new Set(entries.filter(isLink).map((entry) => realpathSync(join(source, entry))))
	for (const entry of entries) {
		const path = join(source, entry)
		if (isLink(entry) ? !loadedBy.test(entry) : reached.has(realpathSync(path))) continue
		cpSync(realpathSync(path), join(target, entry))
	}
	writeFileSync(marker, `${BUILD}-${platform}\n`)
} finally {
	rmSync(work, { recursive: true, force: true })
}
console.log(`llama.cpp ${BUILD} is in ${target}`)
