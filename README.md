# copilot-token-counter

Minimal, realtime terminal token counter for GitHub Copilot CLI sessions. Built with [opentui](https://github.com/anomalyco/opentui) and Bun.

![Token Counter TUI](./image.png)

Tails `~/.copilot/session-state/*/events.jsonl` and aggregates `inputTokens` / `outputTokens` / `cacheReadTokens` / `reasoningTokens` from session metrics in real time.

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/pc-style/copilot-token-counter/main/install.sh | sh
```

Requires [bun](https://bun.sh) and `git`. Installs to `~/.copilot-token-counter` and drops a `copilot-tokens` launcher in `~/.local/bin`.

## Usage

```sh
copilot-tokens
```

Press `q` or `Ctrl-C` to exit.

## Run from source

```sh
git clone https://github.com/pc-style/copilot-token-counter.git
cd copilot-token-counter
bun install
bun start
```

## How it works

For every session file under `~/.copilot/session-state/<id>/events.jsonl`:

- `session.shutdown` events provide aggregated per-model usage (`inputTokens`, `outputTokens`, `cacheReadTokens`, `reasoningTokens`).
- For sessions still in progress (no shutdown yet), `outputTokens` is summed live from each `assistant.message` event.

New bytes are tailed on `fs.watch` notifications with a 1 s polling safety net for filesystems where append events don't fire reliably.

## License

MIT
