import type { Preview } from '@storybook/react-vite'
import { createElement } from 'react'
import '../src/default-theme.css'
import '../src/styles.css'

const preview: Preview = {
	parameters: { layout: 'fullscreen' },
	// The interface fills its parent, as it would inside any host.
	decorators: [
		(Story) => createElement('div', { style: { height: '100vh' } }, createElement(Story)),
	],
}

export default preview
