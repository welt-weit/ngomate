export type DownloadSystem = 'windows' | 'linux'

/**
 * The download to put first for a visitor, from the browser's platform or user-agent string. A Mac gives
 * null, because a browser cannot tell Apple silicon from Intel and the page already leads with Apple
 * silicon; so do phones, tablets and ChromeOS, which cannot install any of the downloads.
 */
export function systemOf(platform: string): DownloadSystem | null {
	if (/android|cros|iphone|ipad/i.test(platform)) return null
	if (/windows|win32|win64/i.test(platform)) return 'windows'
	if (/linux|x11/i.test(platform)) return 'linux'
	return null
}
