import type { Meta, StoryObj } from '@storybook/react-vite'
import { userEvent, within } from 'storybook/test'
import { NgomateApp } from '../src/NgomateApp.js'
import { DRAFT, SAMPLE_CONVERSATION, call, createFakeHost, fakeModels, say } from './fakeHost.js'

const meta: Meta<typeof NgomateApp> = { title: 'App', component: NgomateApp }
export default meta
type Story = StoryObj<typeof NgomateApp>

const send = async (canvasElement: HTMLElement, text: string) => {
	const canvas = within(canvasElement)
	await userEvent.type(await canvas.findByRole('textbox', { name: 'Message' }), text)
	await userEvent.click(canvas.getByRole('button', { name: 'Send' }))
}

export const FirstRun: Story = { args: { host: createFakeHost() } }

export const NoModelChosen: Story = {
	args: { host: createFakeHost({ settings: { model: null } }) },
	play: ({ canvasElement }) => send(canvasElement, 'Hello'),
}

export const StreamingAnAnswer: Story = {
	args: { host: createFakeHost({ replies: [say(DRAFT)] }) },
	play: ({ canvasElement }) => send(canvasElement, 'Draft the answer to question 2.'),
}

export const WithWarnings: Story = {
	args: { host: createFakeHost({ conversations: [SAMPLE_CONVERSATION] }) },
	play: async ({ canvasElement }) => {
		await userEvent.click(
			await within(canvasElement).findByRole('button', { name: SAMPLE_CONVERSATION.title }),
		)
	},
}

export const AskingToSaveANote: Story = {
	args: {
		host: createFakeHost({
			replies: [
				call('save_memory', {
					name: 'funders',
					text: 'Fictional Water Fund prefers short reports.',
				}),
				say('Saved.'),
			],
		}),
	},
	play: ({ canvasElement }) =>
		send(canvasElement, 'Remember that this funder prefers short reports.'),
}

export const AskingToUseAConnector: Story = {
	args: {
		host: createFakeHost({
			settings: {
				addons: [
					{
						id: 'a',
						name: 'Address book',
						connection: { kind: 'http', url: 'https://tools.example/mcp' },
						enabled: true,
						allowDestructive: false,
					},
				],
			},
			replies: [call('add_contact', { name: 'A. Person' }), say('Not added.')],
		}),
	},
	play: ({ canvasElement }) => send(canvasElement, 'Add A. Person to the address book.'),
}

export const ReadyMadeTask: Story = {
	args: { host: createFakeHost() },
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement)
		await userEvent.click(await canvas.findByRole('button', { name: 'Draft a proposal section' }))
		await userEvent.click(await canvas.findByRole('button', { name: 'Attach document' }))
	},
}

export const ModelSettings: Story = {
	args: {
		host: createFakeHost({
			settings: { model: { kind: 'local', id: 'qwen3-8b-q4' } },
			models: fakeModels(),
		}),
	},
	play: async ({ canvasElement }) => {
		await userEvent.click(await within(canvasElement).findByRole('button', { name: 'Model' }))
	},
}

export const ConnectorSettings: Story = {
	args: {
		host: createFakeHost({
			settings: {
				addons: [
					{
						id: 'a',
						name: 'Grant search',
						connection: { kind: 'http', url: 'https://tools.example/mcp' },
						enabled: true,
						allowDestructive: false,
						note: 'Bills your account by use.',
					},
					{
						id: 'b',
						name: 'Local files tool',
						connection: { kind: 'command', command: 'files-tool', args: ['--read-only'] },
						enabled: false,
						allowDestructive: false,
					},
				],
			},
		}),
	},
	play: async ({ canvasElement }) => {
		await userEvent.click(await within(canvasElement).findByRole('button', { name: 'Connectors' }))
	},
}

export const ConnectorsToStart: Story = {
	args: { host: createFakeHost() },
	play: async ({ canvasElement }) => {
		await userEvent.click(await within(canvasElement).findByRole('button', { name: 'Connectors' }))
	},
}

export const ConnectingAConnector: Story = {
	args: { host: createFakeHost() },
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement)
		await userEvent.click(await canvas.findByRole('button', { name: 'Connectors' }))
		await userEvent.click(
			await canvas.findByRole('button', { name: 'Connect Action Network Worldwide' }),
		)
	},
}

export const WrongToken: Story = {
	args: { host: createFakeHost() },
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement)
		await userEvent.click(await canvas.findByRole('button', { name: 'Connectors' }))
		await userEvent.click(await canvas.findByRole('button', { name: 'Connect Apify' }))
		await userEvent.type(await canvas.findByLabelText(/Paste your token/), 'wrong')
		await userEvent.click(canvas.getByRole('button', { name: 'Connect' }))
	},
}

export const ManagingAConnector: Story = {
	args: {
		host: createFakeHost({
			settings: {
				addons: [
					{
						id: 'a',
						name: 'Grant search',
						connection: { kind: 'http', url: 'https://tools.example/mcp' },
						enabled: true,
						allowDestructive: false,
						note: 'Bills your account by use.',
					},
				],
			},
		}),
	},
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement)
		await userEvent.click(await canvas.findByRole('button', { name: 'Connectors' }))
		await userEvent.click(await canvas.findByRole('button', { name: 'Manage Grant search' }))
	},
}

const hostButtonStyle = {
	padding: '7px 14px',
	font: 'inherit',
	fontWeight: 600,
	cursor: 'pointer',
	border: 'none',
	borderRadius: 999,
}

/** A made-up host with its own colors, fonts and buttons. */
export const WhiteLabel: Story = {
	args: {
		embedded: true,
		host: createFakeHost({ conversations: [SAMPLE_CONVERSATION] }),
		theme: {
			background: '#fbf8f3',
			panel: '#f1eadf',
			line: '#ddd2c0',
			text: '#2b2118',
			muted: '#75664f',
			accent: '#a4432b',
			accentText: '#ffffff',
			link: '#a4432b',
			radius: '14px',
			font: 'Georgia, serif',
		},
		primitives: {
			Button: ({ variant, active, style, ...props }) => (
				<button
					type="button"
					style={{
						...hostButtonStyle,
						textAlign: variant === 'nav' ? 'left' : 'center',
						color: variant === 'primary' ? '#fff' : '#2b2118',
						background: variant === 'primary' ? '#a4432b' : active ? '#ddd2c0' : 'transparent',
						...style,
					}}
					{...props}
				/>
			),
		},
	},
}

export const MemorySettings: Story = {
	args: {
		host: createFakeHost({
			notes: { funders: 'Fictional Water Fund prefers short reports.', style: 'Plain language.' },
		}),
	},
	play: async ({ canvasElement }) => {
		await userEvent.click(await within(canvasElement).findByRole('button', { name: 'Memory' }))
	},
}

export const UpdateReady: Story = {
	args: {
		host: {
			...createFakeHost({ conversations: [SAMPLE_CONVERSATION] }),
			checkForUpdate: async () => ({
				version: '0.0.4',
				notes:
					'Drafts now list figures your material does not back.\nThe model server falls back to the processor when there is no graphics card.',
				install: async (onProgress) => {
					for (let step = 1; step <= 10; step++) {
						await new Promise((resolve) => setTimeout(resolve, 300))
						onProgress(step / 10)
					}
					await new Promise(() => {})
				},
			}),
		},
	},
}
