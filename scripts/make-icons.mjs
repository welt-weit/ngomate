#!/usr/bin/env node
// Makes every app and site icon from the two drawings in assets/icon, so they never drift apart.
//
//   yarn icons
//
// icon.svg fills its square, as Windows, Linux and browsers expect. icon-macos.svg is the same drawing
// on Apple's icon grid, which leaves a margin round it. Needs rsvg-convert (librsvg). The mobile icons
// under apps/desktop/src-tauri/icons/android and ios are left as they are. Review the diff afterwards:
// icon.icns and some PNGs come out with new bytes for the same pictures, which needs no commit.
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = join(root, 'assets', 'icon')
const desktop = join(root, 'apps', 'desktop', 'src-tauri', 'icons')
const site = join(root, 'apps', 'site', 'public')
const work = mkdtempSync(join(tmpdir(), 'ngomate-icons-'))

const render = (svg, size, out) =>
	execFileSync('rsvg-convert', ['-w', String(size), '-h', String(size), svg, '-o', out])
const tauriIcon = (png, out) =>
	execFileSync('yarn', ['workspace', '@ngomate/desktop', 'tauri', 'icon', png, '-o', out], {
		cwd: root,
		stdio: 'ignore',
	})

try {
	try {
		execFileSync('rsvg-convert', ['--version'], { stdio: 'ignore' })
	} catch {
		throw new Error('rsvg-convert is needed: brew install librsvg, or apt install librsvg2-bin')
	}

	const full = join(source, 'icon.svg')
	const mac = join(source, 'icon-macos.svg')
	// Home screens round the corners themselves, and a maskable icon is cut to shape, so both start square.
	const square = join(work, 'square.svg')
	writeFileSync(square, readFileSync(full, 'utf8').replace('rx="22"', 'rx="0"'))
	// A launcher may cut a maskable icon to a small circle: the drawing at its plain size stays inside it.
	const maskable = join(work, 'maskable.svg')
	writeFileSync(maskable, readFileSync(square, 'utf8').replace('scale(1.25)', 'scale(1)'))

	render(full, 1024, join(work, 'full.png'))
	render(mac, 1024, join(work, 'mac.png'))
	tauriIcon(join(work, 'full.png'), join(work, 'full'))
	tauriIcon(join(work, 'mac.png'), join(work, 'mac'))

	const fromFull = [
		'32x32.png',
		'64x64.png',
		'128x128.png',
		'128x128@2x.png',
		'icon.ico',
		'StoreLogo.png',
	]
	for (const size of [30, 44, 71, 89, 107, 142, 150, 284, 310])
		fromFull.push(`Square${size}x${size}Logo.png`)
	for (const name of fromFull) copyFileSync(join(work, 'full', name), join(desktop, name))
	for (const name of ['icon.icns', 'icon.png'])
		copyFileSync(join(work, 'mac', name), join(desktop, name))

	copyFileSync(full, join(site, 'favicon.svg'))
	copyFileSync(join(work, 'full', 'icon.ico'), join(site, 'favicon.ico'))
	render(full, 192, join(site, 'icon-192.png'))
	render(full, 512, join(site, 'icon-512.png'))
	render(square, 180, join(site, 'apple-touch-icon.png'))
	render(maskable, 512, join(site, 'icon-maskable-512.png'))
	console.log('Icons made. Review the diff, then commit.')
} finally {
	rmSync(work, { recursive: true, force: true })
}
