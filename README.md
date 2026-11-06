# NGOmate

A free, open-source AI assistant for the back-office work of organizations in the NGO space. It runs on an open-weight model on your own computer, so what you type stays there unless you connect something else.

**Status: early and unreleased.** There are no installers yet. Expect things to change.

## What it does

- Chats with a local model, which is a separate download. You can also point it at a model server you run.
- Reads the documents you give it (PDF, Word, text) and drafts from them.
- Keeps memory as plain Markdown files you can read, edit and delete. It asks before saving anything.
- Connects other tools through the [Model Context Protocol](https://modelcontextprotocol.io), including search services you bring your own key for. Anything that changes something asks you first.
- Comes with ready-made tasks: finding funding opportunities, drafting a proposal section, and writing an update or report. A connected server can offer more.

Local models make mistakes, including mixing up real figures. NGOmate flags dates and links it cannot trace to your material or a tool, but you still need to check names and numbers before using a draft.

## What it needs

| Model | Download | Recommended memory |
|---|---|---|
| Qwen 3 8B, Ministral 3 8B, Granite 4.2 8B | about 5 GB | 12 GB or more |
| Qwen 3 4B | 2.5 GB | 6 GB or more |
| Granite 4.2 3B, with weaker drafts | 2.2 GB | 4 GB or more |

The app offers the largest model that fits your computer, holds less text at once on a smaller one, and unloads the model after 10 minutes without use.

## Run it from source

You need Node 22, Yarn 4 and [Rust](https://rustup.rs), plus the [Tauri prerequisites](https://tauri.app/start/prerequisites/) for your system.

```sh
yarn install
yarn build
yarn desktop
```

The first run downloads the pinned [llama.cpp](https://github.com/ggml-org/llama.cpp) server. Then choose a model under **Model**.

## Packages

| Path | What it is |
|---|---|
| `packages/core` | The agent, model connection, tools, memory and safety checks. No interface. |
| `packages/ui` | The interface in plain React, styled with CSS variables. It works through a small host interface, so it can sit inside another app. |
| `packages/tauri` | A Tauri plugin: local model runner, downloads, keychain, documents and files. |
| `packages/cli` | A small command-line host. |
| `apps/desktop` | The standalone desktop app. |
| `apps/site` | The website at ngomate.ai, published when a change to it reaches `main`. |

To see every screen without a model or the desktop app, run `yarn storybook` and open http://localhost:6006. It uses made-up data.

Checks: `yarn lint`, `yarn typecheck`, `yarn test`, and `cargo test` in `packages/tauri`.

## Contributing

Feedback is welcome as issues. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Licence

[MIT](LICENSE). Each model has its own licence, shown before you download it.
