import { createRoot } from 'react-dom/client'

/**
 * Inside the Tauri window, the app; in a plain browser (`yarn preview`), the same interface on made-up
 * data. Each loads only its own code.
 */
const inTauri = '__TAURI_INTERNALS__' in window
const root = createRoot(document.getElementById('root') as HTMLElement)
const app = inTauri ? import('./desktop.js') : import('./preview.js')
app.then(({ start }) => start(root))
