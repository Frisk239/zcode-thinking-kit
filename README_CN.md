# zcode-thinking-kit

[English](./README.md)

给 [ZCode](https://zcode.z.ai) 自定义模型补上「思考强度」的本机回环代理。

ZCode 界面能选思考档位，`~/.zcode/v2/config.json` 里每个模型也可以写 `reasoning.variants`。但对不少自定义 provider，这个值出不了站：HTTP 请求体里根本没有 `reasoning_effort` / `thinking`。本工具监听 `127.0.0.1`，转发到真实上游，并在缺失时注入对应字段。

需要 **Node.js 18+**，无第三方依赖。

## 原理

```
ZCode  --baseURL-->  127.0.0.1:38771  --注入-->  真实供应商
```

1. 把某个 provider 的 `baseURL` 改成本地代理，**路径前缀保持原样**。  
   例：`https://opencode.ai/zen/go/v1` → `http://127.0.0.1:38771/zen/go/v1`
2. 代理把请求头（含 `Authorization`）转到 `routes[].upstream` 的 origin。
3. 若请求体已有思考字段，原样放行，避免 ZCode 修好后双重注入。
4. 档位跟随 `~/.zcode/cli/log/zcode-日期.jsonl` 里的 `session.reasoning_effort.updated`。多会话共用「最后一条事件」（已知限制）。

代理**只绑定 127.0.0.1**。审计不记录请求体、请求头和密钥。

## 快速开始

```bash
git clone https://github.com/Frisk239/zcode-thinking-kit.git
cd zcode-thinking-kit
copy thinking.config.example.json thinking.config.json
node cli.mjs suggest --write    # 可选：从 ZCode v2 配置生成路由
node cli.mjs start
node cli.mjs doctor
node cli.mjs status
```

打开 `http://127.0.0.1:38771/health`。然后在 ZCode 里只改 provider `baseURL` 的协议/主机/端口，保留路径，**新开会话**生效。

停止：`node cli.mjs stop`。前台运行：`node cli.mjs run`。

Windows 还可双击 `start.bat` / `stop.bat`，或 `install-autostart.bat` 开机启动。

## 配置

`thinking.config.json` 从 example 复制，不进 git。

| 字段 | 含义 |
| --- | --- |
| `listen.port` | 本地端口（host 始终是 `127.0.0.1`） |
| `levelSource.followZcodeLog` | 是否跟随 ZCode 内核日志档位 |
| `levelSource.staticLevel` | 还没有日志事件时的兜底档位 |
| `routes[].match` | 进站路径前缀（原 baseURL 的 path） |
| `routes[].upstream` | 只写 origin，如 `https://opencode.ai` |
| `routes[].followSession` | 该路由下所有模型跟随 UI 档位 |
| `routes[].defaultInject` | 按 API：`chat/completions` / `responses` / `messages` |
| `routes[].models.<id>.levelMap` | 档位改名，如 `{ "xhigh": "high" }` |

模板里的 `{level}` 会被替换。档位为 `off` / `none` / `disabled` 时不注入。

配置查找顺序：`--config=`、`$ZCODE_THINKING_KIT_CONFIG`、当前目录、工具目录、`~/.zcode-thinking-kit/`。

审计日志：`~/.zcode-thinking-kit/audit.jsonl`。

## 安全

- 本进程位于模型请求路径上，请只运行你读过的代码。
- 只监听回环，不要把端口暴露到局域网。
- 回滚：把 `baseURL` 改回原值即可。代理停掉不影响直连。

## License

MIT
