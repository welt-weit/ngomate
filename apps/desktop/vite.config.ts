import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
	plugins: [react()],
	clearScreen: false,
	server: { port: 1430, strictPort: true, host: '127.0.0.1' },
	build: { outDir: 'dist', target: 'es2022' },
})
