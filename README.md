# zcode-thinking-kit

[中文文档](./README_CN.md)

A tiny **loopback proxy** that restores thinking / reasoning strength for [ZCode](https://zcode.z.ai) custom models.

ZCode's UI lets you pick a thought level (main session **and** subagents). For many custom providers that value never leaves the machine: the HTTP body has **no** `reasoning_effort` / `thinking` field. This kit sits on `127.0.0.1`, forwards to the real upstream, and injects the field when it is missing.

Requires **Node.js 18+**. Zero npm dependencies.

## How it works

```
ZCode  --baseURL-->  127.0.0.1:38771  --inject-->  real provider
```

1. Point a provider `baseURL` at the proxy. Keep the original path prefix.
   `https://opencode.ai/zen/go/v1` → `http://127.0.0.1:38771/zen/go/v1`
   Use `127.0.0.1`, not `localhost`.
2. The proxy copies headers (including `Authorization`) to `routes[].upstream`.
3. If the JSON body already has a thinking field, it is forwarded unchanged.
4. Thought level, in order: `x-session-id` map from ZCode kernel logs → model id suffix like `foo(high)` → last main-session log event → `staticLevel`.

Subagents use the same HTTP assembler as the main agent. Their requests go through the proxy if that model's `baseURL` does. A **dedicated** subagent `thoughtLevel` is **not** in the kernel jsonl kit follows; until ZCode logs it, the kit can only use `x-session-id` when a matching log event exists, the `(level)` model suffix, or the last main-session level (inherit-shaped fallback). That last case is an approximation, not a guarantee.

## Quick start

```bash
git clone https://github.com/Frisk239/zcode-thinking-kit.git
cd zcode-thinking-kit
cp thinking.config.example.json thinking.config.json   # Windows: copy
node cli.mjs suggest --write    # optional: build routes from ZCode v2 config
node cli.mjs start              # waits until /health is this kit
node cli.mjs doctor
node cli.mjs status
```

Open the console at `http://127.0.0.1:38771/` (plain HTML, no framework) or `http://127.0.0.1:38771/health`. Copy the proxied `baseURL`, paste it into ZCode (keep the path), then start a **new session**. The console exists only while the proxy is running — start it with `cli start` / `start.bat`.

Stop with `node cli.mjs stop` (kills the process only if `/health` is this kit). Foreground: `node cli.mjs run`.

Windows helpers: `start.bat` / `stop.bat` / `install-autostart.bat`.

## Config

`thinking.config.json` (copied from the example, not committed):

| Field | Meaning |
| --- | --- |
| `listen.port` | Local port (host is always forced to `127.0.0.1`) |
| `levelSource.followZcodeLog` | Tail ZCode kernel logs for UI levels (local calendar date) |
| `levelSource.staticLevel` | Fallback when no log event yet |
| `routes[].match` | Incoming path prefix; `/v1` will **not** match `/v10`. Prefixes must be unique |
| `routes[].stripPrefix` | Optional. Strip this prefix before forwarding (disambiguate two `/v1` origins) |
| `routes[].upstream` | Origin only, e.g. `https://opencode.ai` |
| `routes[].followSession` | Follow UI / session map for models on this route |
| `routes[].defaultInject` | Per API: `chat/completions`, `responses`, `messages` |
| `routes[].models.<id>.levelMap` | Rename levels, e.g. `{ "xhigh": "high" }` |

`{level}` in a template is replaced by the resolved thought level. `{budget}` is a numeric Anthropic thinking budget derived from the level. `off` / `none` / `disabled` / `nothink` skip injection.

Hot reload watches the config file and applies **routes, inject templates, and staticLevel**. Changing `listen.port` requires a restart.

CLI looks for config in this order: `--config=`, `$ZCODE_THINKING_KIT_CONFIG`, `./thinking.config.json`, the kit directory, then `~/.zcode-thinking-kit/`.

Env: `ZCODE_THINKING_KIT_HOME`, `ZCODE_LOG_DIR`, `ZCODE_V2_CONFIG`.

Audit log: `~/.zcode-thinking-kit/audit.jsonl` (or that home dir). No bodies, headers, or API keys.

## Safety

- This process is on the LLM request path. Only run code you can read.
- Bind is loopback-only. Do not expose the port.
- Rollback: restore the original `baseURL`. A stopped proxy will not affect a direct URL.

## License

MIT
