# MCP Hot-Swap

[中文文档](README_CN.md)

Runtime hot-swap proxy for [MCP (Model Context Protocol)](https://modelcontextprotocol.io/) Servers. Switch Redis, PostgreSQL, MySQL, and other MCP Server connections on the fly — no restart needed.

## Problem

Claude Code's MCP Server config lives in `~/.claude.json`. Any connection change requires a full restart. Switching between dev / staging / prod databases is painful.

## Solution

MCP Hot-Swap sits between Claude Code and your actual MCP Server as a transparent proxy:

```
Claude Code <--stdio--> MCP Hot-Swap <--stdio--> Actual MCP Server
```

It:
1. Starts with default connection params, registers all tools from the wrapped MCP Server
2. Proxies all tool calls transparently — you use `get`, `set`, `query`, etc. as usual
3. Injects 3 management tools (`__connect`, `__status`, `__disconnect`) for runtime switching
4. On `__connect`, kills the old process and spawns a new one with updated params

## Requirements

- Node.js >= 18
- Claude Code with MCP support

## Install

```bash
# Clone
git clone https://github.com/blackhumors/mcp-hot-swap.git ~/.mcp-wrapper

# Install dependencies
cd ~/.mcp-wrapper && npm install
```

## Configuration

Replace your existing MCP Server entries in `~/.claude.json` with wrapped versions.

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `MCP_WRAPPER_NAME` | Yes | Display name (e.g. `redis`, `postgres`, `mysql`) |
| `MCP_WRAPPER_COMMAND` | Yes | Path to the wrapped MCP Server executable |
| `MCP_WRAPPER_TEMPLATE` | No | CLI argument template with `${key}` placeholders |
| `MCP_WRAPPER_ENV_TEMPLATE` | No | Env var template, comma-separated (e.g. `PG_HOST=${host},PG_PORT=${port}`) |
| `MCP_WRAPPER_CONFIG_TEMPLATE` | No | Config file content template — generates a temp file passed to the MCP Server |
| `MCP_WRAPPER_CONFIG_ARG` | No | Argument name for config file path (default: `--config`) |
| `MCP_WRAPPER_PARAMS` | Yes | JSON describing required params and their descriptions |
| `MCP_WRAPPER_DEFAULT` | No | JSON with default connection params (auto-connects on startup) |

### Three Parameter Passing Methods

You can combine these as needed:

- **CLI args** (`MCP_WRAPPER_TEMPLATE`): For MCP Servers that take connection info via command-line arguments
- **Env vars** (`MCP_WRAPPER_ENV_TEMPLATE`): For MCP Servers that read environment variables
- **Config file** (`MCP_WRAPPER_CONFIG_TEMPLATE`): For MCP Servers that require a config file (e.g. YAML)

## Examples

### Redis (CLI argument template)

```json
{
  "mcpServers": {
    "redis": {
      "command": "node",
      "args": ["~/.mcp-wrapper/index.mjs"],
      "type": "stdio",
      "env": {
        "MCP_WRAPPER_NAME": "redis",
        "MCP_WRAPPER_COMMAND": "/path/to/redis-mcp-server",
        "MCP_WRAPPER_TEMPLATE": "--url redis://:${password}@${host}:${port}/${db}",
        "MCP_WRAPPER_PARAMS": "{\"host\":\"Redis host\",\"port\":\"Redis port\",\"password\":\"Redis password\",\"db\":\"Database number, default 0\"}",
        "MCP_WRAPPER_DEFAULT": "{\"host\":\"127.0.0.1\",\"port\":\"6379\",\"password\":\"your-password\",\"db\":\"0\"}"
      }
    }
  }
}
```

### PostgreSQL (env var template)

```json
{
  "mcpServers": {
    "postgres": {
      "command": "node",
      "args": ["~/.mcp-wrapper/index.mjs"],
      "type": "stdio",
      "env": {
        "MCP_WRAPPER_NAME": "postgres",
        "MCP_WRAPPER_COMMAND": "mcp-postgres",
        "MCP_WRAPPER_ENV_TEMPLATE": "PG_HOST=${host},PG_PORT=${port},PG_USER=${user},PG_PASSWORD=${password},PG_DATABASE=${database}",
        "MCP_WRAPPER_PARAMS": "{\"host\":\"Database host\",\"port\":\"Database port\",\"user\":\"Username\",\"password\":\"Password\",\"database\":\"Database name\"}",
        "MCP_WRAPPER_DEFAULT": "{\"host\":\"127.0.0.1\",\"port\":\"5432\",\"user\":\"postgres\",\"password\":\"your-password\",\"database\":\"mydb\"}"
      }
    }
  }
}
```

### MySQL / mcp-dbutils (config file template)

For MCP Servers that require a YAML config file:

```json
{
  "mcpServers": {
    "mysql": {
      "command": "node",
      "args": ["~/.mcp-wrapper/index.mjs"],
      "type": "stdio",
      "env": {
        "MCP_WRAPPER_NAME": "mysql",
        "MCP_WRAPPER_COMMAND": "/path/to/mcp-dbutils",
        "MCP_WRAPPER_CONFIG_TEMPLATE": "connections:\n  mysql:\n    type: mysql\n    host: ${host}\n    port: ${port}\n    database: ${database}\n    user: ${user}\n    password: ${password}\n    charset: utf8mb4",
        "MCP_WRAPPER_CONFIG_ARG": "--config",
        "MCP_WRAPPER_PARAMS": "{\"host\":\"MySQL host\",\"port\":\"MySQL port\",\"database\":\"Database name\",\"user\":\"Username\",\"password\":\"Password\"}",
        "MCP_WRAPPER_DEFAULT": "{\"host\":\"127.0.0.1\",\"port\":\"3306\",\"database\":\"mydb\",\"user\":\"root\",\"password\":\"your-password\"}"
      }
    }
  }
}
```

### Wrapping Any MCP Server

Just figure out three things:

1. How does the MCP Server start? (the `command`)
2. How are connection params passed?
   - CLI args → use `MCP_WRAPPER_TEMPLATE`
   - Env vars → use `MCP_WRAPPER_ENV_TEMPLATE`
   - Config file → use `MCP_WRAPPER_CONFIG_TEMPLATE` + `MCP_WRAPPER_CONFIG_ARG`
3. What params are needed? → put them in `MCP_WRAPPER_PARAMS`

## Usage

### Auto-connect on startup

With `MCP_WRAPPER_DEFAULT` configured, the wrapper auto-connects on startup. All original tools are immediately available — the experience is identical to using the MCP Server directly.

### Runtime switching

Just tell the AI:

- *"Switch Redis to 10.0.0.1:6379, password is xxx"*
- *"Read Redis config from application-dev.properties and connect"*
- *"Switch PostgreSQL to the prod database"*
- *"Connect MySQL to the staging server"*

The AI calls `__connect` with the right params — no restart needed.

### Check status

- *"Which Redis instance am I connected to?"*

The AI calls `__status` and shows current connection info.

## Architecture

```
┌─────────────┐     stdio      ┌──────────────────┐     stdio      ┌─────────────────┐
│ Claude Code  │ ◄────────────► │  MCP Hot-Swap    │ ◄────────────► │ Actual MCP      │
│              │                │                  │                │ Server          │
│ Sees tools:  │                │ On startup:      │                │ (redis/pg/mysql) │
│ - dbsize     │                │ connects with    │                │                 │
│ - get        │                │ defaults, grabs  │  __connect     │                 │
│ - set        │                │ tool list        │ ──────────────►│ Kill old proc   │
│ - __connect  │                │                  │                │ Spawn new proc  │
│ - __status   │                │ On __connect:    │                │ New params      │
│ - ...        │                │ swaps underlying │                │                 │
│              │                │ connection       │                │                 │
└─────────────┘                └──────────────────┘                └─────────────────┘
```

## Notes

- Always set `MCP_WRAPPER_DEFAULT` — without it, the tools list is empty on startup and the AI can't call any tools until you manually `__connect`
- Tools don't change when switching connections (a Redis MCP always has `get`, `set`, `dbsize`, etc. regardless of which instance)
- Sensitive info (passwords) will appear in `~/.claude.json` — set proper file permissions
- Requires `@modelcontextprotocol/sdk` and Node.js 18+
- Temp config files are auto-cleaned on disconnect or connection switch

## License

[MIT](LICENSE)
