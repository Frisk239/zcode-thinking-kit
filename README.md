# zcode-thinking-kit

[中文文档](./README_CN.md)

A tiny **loopback proxy** that restores thinking / reasoning strength for [ZCode](https://zcode.z.ai) custom models.

ZCode's UI lets you pick a thought level, and `~/.zcode/v2/config.json` even stores `reasoning.variants` per model. For many custom providers that value never leaves the machine: the HTTP body has **no** `reasoning_effort` / `thinking` field. This kit sits on `127.0.0.1`, forwards to the real upstream, and injects the field when it is missing.

Requires **Node.js 18+**. Zero npm dependencies.

## How it works

```
ZCode  --baseURL-->  127.0.0.1:38771  --inject-->  real provider
```

1. Point a provider `baseURL` at the proxy. Keep the original path prefix.
   `https://opencode.ai/zen/go/v1` → `http://127.0.0.1:38771/zen/go/v1`
2. The proxy copies headers (including `Authorization`) to the upstream origin from `routes[].upstream`.
3. If the JSON body already has a thinking field, it is forwarded unchanged (so a future ZCode fix will not double-inject).
4. Thought level follows `session.reasoning_effort.updated` in `~/.zcode/cli/log/zcode-YYYY-MM-DD.jsonl`. Concurrent sessions share the last event (known limit).

The proxy **always binds 127.0.0.1**. It never logs request bodies, headers, or API keys.

## Quick start

```bash
git clone https://github.com/Frisk239/zcode-thinking-kit.git
cd zcode-thinking-kit
cp thinking.config.example.json thinking.config.json   # Windows: copy
node cli.mjs suggest --write    # optional: build routes from ZCode v2 config
node cli.mjs start
node cli.mjs doctor
node cli.mjs status
```

Open `http://127.0.0.1:38771/health`. Then in ZCode, change only the host/port of the provider `baseURL`, keep the path, start a **new session**.

Stop with `node cli.mjs stop`. Foreground: `node cli.mjs run` or `node server.mjs`.

Windows helpers: `start.bat` / `stop.bat` / `install-autostart.bat`.

## Config

`thinking.config.json` (copied from the example, not committed):

| Field | Meaning |
| --- | --- |
| `listen.port` | Local port (host is always `127.0.0.1`) |
| `levelSource.followZcodeLog` | Tail ZCode kernel logs for UI levels |
| `levelSource.staticLevel` | Fallback when no log event yet |
| `routes[].match` | Incoming path prefix (the path of the original baseURL) |
| `routes[].upstream` | Origin only, e.g. `https://opencode.ai` |
| `routes[].followSession` | Use the latest UI level for every model on this route |
| `routes[].defaultInject` | Per API shape: `chat/completions`, `responses`, `messages` |
| `routes[].models.<id>.levelMap` | Rename levels, e.g. `{ "xhigh": "high" }` |

`{level}` in a template is replaced by the resolved thought level. `off` / `none` / `disabled` skip injection.

CLI looks for config in this order: `--config=`, `$ZCODE_THINKING_KIT_CONFIG`, `./thinking.config.json`, the kit directory, then `~/.zcode-thinking-kit/`.

Audit log: `~/.zcode-thinking-kit/audit.jsonl`.

## Safety

- This process is on the LLM request path. Only run code you can read.
- Bind is loopback-only. Do not expose the port.
- Rollback: restore the original `baseURL`. A stopped proxy will not affect a direct URL.

## License

MIT
