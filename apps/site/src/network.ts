/**
 * The moving network behind the page: nodes drift slowly and link up when they come close, like the
 * commons the page describes. Colors come from the --node and --edge CSS variables, so it follows the
 * light and dark theme. With reduced motion it draws one still frame; it pauses while the tab is hidden.
 */

type Node = { x: number; y: number; vx: number; vy: number; r: number }

const LINK_DISTANCE = 160
const SPEED = 0.12
const EDGE_OPACITY = 0.3

export function startNetwork(canvas: HTMLCanvasElement): () => void {
	const context = canvas.getContext('2d')
	if (!context) return () => {}
	const ctx = context
	const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)')
	const darkScheme = matchMedia('(prefers-color-scheme: dark)')
	let nodes: Node[] = []
	let width = 0
	let height = 0
	let nodeColor = ''
	let edgeRgb = ''
	let frame = 0

	function readColors() {
		const style = getComputedStyle(document.documentElement)
		nodeColor = style.getPropertyValue('--node').trim()
		edgeRgb = style.getPropertyValue('--edge').trim()
	}

	function resize() {
		const ratio = Math.min(window.devicePixelRatio || 1, 2)
		width = window.innerWidth
		height = window.innerHeight
		canvas.width = Math.round(width * ratio)
		canvas.height = Math.round(height * ratio)
		ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
		// About one node per 22,000 square pixels, so a phone gets a sparse network and a wide screen a fuller one.
		const count = Math.min(60, Math.max(16, Math.round((width * height) / 22000)))
		nodes = Array.from({ length: count }, () => ({
			x: Math.random() * width,
			y: Math.random() * height,
			vx: (Math.random() - 0.5) * 2 * SPEED,
			vy: (Math.random() - 0.5) * 2 * SPEED,
			r: 1 + Math.random() * 1.4,
		}))
	}

	function draw() {
		ctx.clearRect(0, 0, width, height)
		for (let i = 0; i < nodes.length; i++) {
			const a = nodes[i]
			for (let j = i + 1; j < nodes.length; j++) {
				const b = nodes[j]
				const distance = Math.hypot(a.x - b.x, a.y - b.y)
				if (distance > LINK_DISTANCE) continue
				ctx.strokeStyle = `rgb(${edgeRgb} / ${(1 - distance / LINK_DISTANCE) * EDGE_OPACITY})`
				ctx.lineWidth = 1
				ctx.beginPath()
				ctx.moveTo(a.x, a.y)
				ctx.lineTo(b.x, b.y)
				ctx.stroke()
			}
		}
		ctx.fillStyle = nodeColor
		for (const node of nodes) {
			ctx.beginPath()
			ctx.arc(node.x, node.y, node.r, 0, Math.PI * 2)
			ctx.fill()
		}
	}

	function step() {
		for (const node of nodes) {
			node.x += node.vx
			node.y += node.vy
			if (node.x < 0 || node.x > width) node.vx *= -1
			if (node.y < 0 || node.y > height) node.vy *= -1
		}
		draw()
		frame = requestAnimationFrame(step)
	}

	function start() {
		cancelAnimationFrame(frame)
		if (reducedMotion.matches || document.hidden) draw()
		else frame = requestAnimationFrame(step)
	}

	function onResize() {
		resize()
		start()
	}

	function onScheme() {
		readColors()
		draw()
	}

	readColors()
	resize()
	start()
	window.addEventListener('resize', onResize)
	document.addEventListener('visibilitychange', start)
	reducedMotion.addEventListener('change', start)
	darkScheme.addEventListener('change', onScheme)

	return () => {
		cancelAnimationFrame(frame)
		window.removeEventListener('resize', onResize)
		document.removeEventListener('visibilitychange', start)
		reducedMotion.removeEventListener('change', start)
		darkScheme.removeEventListener('change', onScheme)
	}
}

const canvas = document.createElement('canvas')
canvas.className = 'network'
canvas.setAttribute('aria-hidden', 'true')
document.body.prepend(canvas)
startNetwork(canvas)
