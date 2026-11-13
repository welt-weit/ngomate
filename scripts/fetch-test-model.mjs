#!/usr/bin/env node
// Downloads a tiny model that llama.cpp keeps for its own tests, for the smoke test of the bundled model
// server in packages/tauri. It writes nothing useful, but it proves the server starts and answers.
// Prints only the model's path, so a workflow can put it in a variable.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const REPO = 'ggml-org/test-model-stories260K'
const COMMIT = '479896ec924af6d40fd419ab8f4d1eb2101de00d'
const FILE = 'stories260K-f32.gguf'
const SHA256 = '270cba1bd5109f42d03350f60406024560464db173c0e387d91f0426d3bd256d'

const folder = join(tmpdir(), 'ngomate-test-model')
const path = join(folder, FILE)
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

if (!existsSync(path) || sha256(readFileSync(path)) !== SHA256) {
	const url = `https://huggingface.co/${REPO}/resolve/${COMMIT}/${FILE}`
	console.error(`Downloading ${url}`)
	const response = await fetch(url)
	if (!response.ok) throw new Error(`Download failed: ${response.status}`)
	const bytes = Buffer.from(await response.arrayBuffer())
	const actual = sha256(bytes)
	if (actual !== SHA256) throw new Error(`Checksum mismatch: expected ${SHA256}, got ${actual}`)
	mkdirSync(folder, { recursive: true })
	writeFileSync(path, bytes)
}
console.log(path)
