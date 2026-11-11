import { describe, expect, it } from 'vitest'

import { systemOf } from './system'

describe('systemOf', () => {
	it('picks Windows and Linux from the platform hint or the user agent', () => {
		expect(systemOf('Windows')).toBe('windows')
		expect(systemOf('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe('windows')
		expect(systemOf('Linux')).toBe('linux')
		expect(systemOf('Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:140.0)')).toBe('linux')
	})

	it('leaves the Mac lead alone, and offers nothing first to phones and ChromeOS', () => {
		expect(systemOf('macOS')).toBeNull()
		expect(systemOf('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')).toBeNull()
		expect(systemOf('Mozilla/5.0 (Linux; Android 15; Pixel 9)')).toBeNull()
		expect(systemOf('Mozilla/5.0 (X11; CrOS x86_64 16181.61.0)')).toBeNull()
		expect(systemOf('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)')).toBeNull()
	})
})
