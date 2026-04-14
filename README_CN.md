# MCP Hot-Swap

[English](README.md)

> [MCP (Model Context Protocol)](https://modelcontextprotocol.io/) Server 运行时热切换代理。无需重启 Claude Code，即可动态切换 Redis、PostgreSQL、MySQL 等服务的连接实例。

## 快速开始

```bash
# 1. 克隆并安装
git clone https://github.com/blackhumors/mcp-hot-swap.git ~/.mcp-wrapper
cd ~/.mcp-wrapper && npm install

# 2. 在 ~/.claude.json 中添加配置（以 Redis 为例，替换路径和密码）
```

```json
{
  "mcpServers": {
    "redis": {
      "command": "node",
      "args": ["/Users/你的用户名/.mcp-wrapper/index.mjs"],
      "type": "stdio",
      "env": {
        "MCP_WRAPPER_NAME": "redis",
        "MCP_WRAPPER_COMMAND": "/path/to/redis-mcp-server",
        "MCP_WRAPPER_TEMPLATE": "--url redis://:${password}@${host}:${port}/${db}",
        "MCP_WRAPPER_PARAMS": "{\"host\":\"Redis 主机地址\",\"port\":\"Redis 端口\",\"password\":\"Redis 密码\",\"db\":\"数据库编号，默认 0\"}",
        "MCP_WRAPPER_DEFAULT": "{\"host\":\"127.0.0.1\",\"port\":\"6379\",\"password\":\"your-password\",\"db\":\"0\"}"
      }
    }
  }
}
```

```bash
# 3. 重启 Claude Code —— 搞定！所有 Redis tools 立即可用。
# 4. 需要切换时，直接对 AI 说 "帮我切换 Redis 到 10.0.0.1:6379，密码 xxx"
```

> **注意：** `args` 中的路径必须是绝对路径（如 `/Users/yourname/.mcp-wrapper/index.mjs`）。JSON 中 `~` 不会被 shell 展开。

## v2 新特性

- **完整 MCP 协议代理** — 同时代理 tools、resources 和 prompts（v1 仅代理 tools）
- **连接超时** — 默认 30s，可通过 `MCP_WRAPPER_TIMEOUT` 配置
- **自动重连** — 子进程崩溃时自动重连（最多 3 次，间隔 2s）
- **密码脱敏** — `__status` 自动隐藏 password、secret、token 等敏感字段
- **错误日志** — JSON 解析错误输出到 stderr，不再静默吞掉

## 背景

Claude Code 的 MCP Server 配置写在 `~/.claude.json` 中，修改后必须重启才能生效。在 dev / staging / prod 等不同环境之间切换数据库连接时，体验很差。

## 方案

MCP Hot-Swap 作为透明代理层，位于 Claude Code 和实际 MCP Server 之间：

```
Claude Code <--stdio--> MCP Hot-Swap <--stdio--> 实际 MCP Server
```

核心设计：
1. 启动时用默认参数连接被包装的 MCP Server，获取完整 tools/resources/prompts 列表并注册
2. 透明代理所有调用 —— `get`、`set`、`query` 等照常使用
3. 额外注入 3 个管理 tool（`__connect`、`__status`、`__disconnect`）用于运行时切换
4. `__connect` 时杀掉旧进程，用新参数启动新进程

## 环境要求

- Node.js >= 18
- 支持 MCP 的 Claude Code

## 安装

```bash
git clone https://github.com/blackhumors/mcp-hot-swap.git ~/.mcp-wrapper
cd ~/.mcp-wrapper && npm install
```

## 配置

在 `~/.claude.json` 的 `mcpServers` 中，将原有的 MCP 配置替换为 wrapper 包装版本。

### 环境变量说明

| 变量 | 必填 | 说明 |
|------|------|------|
| `MCP_WRAPPER_NAME` | 是 | 显示名称，如 `redis`、`postgres`、`mysql` |
| `MCP_WRAPPER_COMMAND` | 是 | 被包装 MCP Server 的可执行命令路径 |
| `MCP_WRAPPER_TEMPLATE` | 否 | 命令行参数模板，用 `${key}` 占位符 |
| `MCP_WRAPPER_ENV_TEMPLATE` | 否 | 环境变量模板，逗号分隔（如 `PG_HOST=${host},PG_PORT=${port}`） |
| `MCP_WRAPPER_CONFIG_TEMPLATE` | 否 | 配置文件内容模板，动态生成临时文件传给 MCP Server |
| `MCP_WRAPPER_CONFIG_ARG` | 否 | 传递配置文件路径的参数名，默认 `--config` |
| `MCP_WRAPPER_PARAMS` | 是 | JSON 格式的参数描述，告诉 AI 需要哪些参数及含义 |
| `MCP_WRAPPER_DEFAULT` | 否 | JSON 格式的默认连接参数，启动时自动连接 |
| `MCP_WRAPPER_TIMEOUT` | 否 | 连接超时时间（毫秒），默认 `30000` |

### 三种传参方式

可按需组合使用：

| 方式 | 环境变量 | 适用场景 |
|------|---------|----------|
| 命令行参数 | `MCP_WRAPPER_TEMPLATE` | MCP Server 通过 CLI 参数接收连接信息 |
| 环境变量 | `MCP_WRAPPER_ENV_TEMPLATE` | MCP Server 通过环境变量读取连接信息 |
| 配置文件 | `MCP_WRAPPER_CONFIG_TEMPLATE` | MCP Server 需要配置文件（如 YAML） |

## 配置示例

### Redis（命令行参数模板）

```json
{
  "mcpServers": {
    "redis": {
      "command": "node",
      "args": ["/Users/你的用户名/.mcp-wrapper/index.mjs"],
      "type": "stdio",
      "env": {
        "MCP_WRAPPER_NAME": "redis",
        "MCP_WRAPPER_COMMAND": "/path/to/redis-mcp-server",
        "MCP_WRAPPER_TEMPLATE": "--url redis://:${password}@${host}:${port}/${db}",
        "MCP_WRAPPER_PARAMS": "{\"host\":\"Redis 主机地址\",\"port\":\"Redis 端口\",\"password\":\"Redis 密码\",\"db\":\"数据库编号，默认 0\"}",
        "MCP_WRAPPER_DEFAULT": "{\"host\":\"127.0.0.1\",\"port\":\"6379\",\"password\":\"your-password\",\"db\":\"0\"}"
      }
    }
  }
}
```

### PostgreSQL（环境变量模板）

```json
{
  "mcpServers": {
    "postgres": {
      "command": "node",
      "args": ["/Users/你的用户名/.mcp-wrapper/index.mjs"],
      "type": "stdio",
      "env": {
        "MCP_WRAPPER_NAME": "postgres",
        "MCP_WRAPPER_COMMAND": "mcp-postgres",
        "MCP_WRAPPER_ENV_TEMPLATE": "PG_HOST=${host},PG_PORT=${port},PG_USER=${user},PG_PASSWORD=${password},PG_DATABASE=${database}",
        "MCP_WRAPPER_PARAMS": "{\"host\":\"数据库主机地址\",\"port\":\"数据库端口\",\"user\":\"用户名\",\"password\":\"密码\",\"database\":\"数据库名\"}",
        "MCP_WRAPPER_DEFAULT": "{\"host\":\"127.0.0.1\",\"port\":\"5432\",\"user\":\"postgres\",\"password\":\"your-password\",\"database\":\"mydb\"}"
      }
    }
  }
}
```

### MySQL / mcp-dbutils（配置文件模板）

适用于需要 YAML 配置文件的 MCP Server：

```json
{
  "mcpServers": {
    "mysql": {
      "command": "node",
      "args": ["/Users/你的用户名/.mcp-wrapper/index.mjs"],
      "type": "stdio",
      "env": {
        "MCP_WRAPPER_NAME": "mysql",
        "MCP_WRAPPER_COMMAND": "/path/to/mcp-dbutils",
        "MCP_WRAPPER_CONFIG_TEMPLATE": "connections:\n  mysql:\n    type: mysql\n    host: ${host}\n    port: ${port}\n    database: ${database}\n    user: ${user}\n    password: ${password}\n    charset: utf8mb4",
        "MCP_WRAPPER_CONFIG_ARG": "--config",
        "MCP_WRAPPER_PARAMS": "{\"host\":\"MySQL 主机地址\",\"port\":\"MySQL 端口\",\"database\":\"数据库名\",\"user\":\"用户名\",\"password\":\"密码\"}",
        "MCP_WRAPPER_DEFAULT": "{\"host\":\"127.0.0.1\",\"port\":\"3306\",\"database\":\"mydb\",\"user\":\"root\",\"password\":\"your-password\"}"
      }
    }
  }
}
```

### 包装其他 MCP Server

只需搞清楚三件事：

1. 被包装的 MCP Server 怎么启动？（`command` 是什么）
2. 连接参数怎么传？
   - 命令行参数 → 用 `MCP_WRAPPER_TEMPLATE`
   - 环境变量 → 用 `MCP_WRAPPER_ENV_TEMPLATE`
   - 配置文件 → 用 `MCP_WRAPPER_CONFIG_TEMPLATE` + `MCP_WRAPPER_CONFIG_ARG`
3. 需要哪些连接参数？→ 写到 `MCP_WRAPPER_PARAMS`

## 使用方式

### 启动即可用

配置了 `MCP_WRAPPER_DEFAULT` 后，重启 Claude Code 即自动连接默认实例，所有原生 tools 立即可用，体验与未包装时完全一致。

### 运行时切换

对 AI 说：

- *"帮我切换 Redis 到 10.0.0.1:6379，密码是 xxx"*
- *"从 application-dev.properties 读取 Redis 配置然后连上"*
- *"切换 PostgreSQL 到 prod 环境的数据库"*
- *"切换 MySQL 到 staging 的 mydb 库"*

AI 会自动调用 `__connect` 传入参数完成切换，无需重启。

### 查看状态

- *"当前 Redis 连的是哪个实例？"*

AI 会调用 `__status` 返回当前连接信息（密码自动脱敏）。

## 架构图

```
┌─────────────┐     stdio      ┌──────────────────┐     stdio      ┌─────────────────┐
│ Claude Code  │ ◄────────────► │  MCP Hot-Swap    │ ◄────────────► │ 实际 MCP Server │
│              │                │                  │                │ (redis/pg/mysql) │
│ 看到的能力:  │                │ 启动时连接默认    │                │                 │
│ - tools      │                │ 实例获取 tools/  │                │                 │
│ - resources  │                │ resources/prompts│   __connect    │                 │
│ - prompts    │                │ 列表并注册       │ ──────────────►│ 杀掉旧进程      │
│ - __connect  │                │                  │                │ 启动新进程      │
│ - __status   │                │ __connect 时     │                │ 新的连接参数    │
│ - ...        │                │ 换底层连接       │                │                 │
│              │                │                  │                │ 崩溃时自动重连  │
└─────────────┘                └──────────────────┘                └─────────────────┘
```

## 常见问题

| 问题 | 解决方案 |
|------|----------|
| 启动后 tools 列表为空 | 设置 `MCP_WRAPPER_DEFAULT` 并填入有效的连接参数，让 wrapper 启动时能连接并发现 tools |
| 报错 `MCP_WRAPPER_COMMAND is not set` | 忘记设置 `MCP_WRAPPER_COMMAND` 环境变量，需要指向实际 MCP Server 的可执行文件路径 |
| `__connect` 报 spawn error | 检查 `MCP_WRAPPER_COMMAND` 指向的路径是否正确，手动运行一下验证 |
| JSON 配置中 `~` 路径不生效 | 使用绝对路径（如 `/Users/yourname/.mcp-wrapper/index.mjs`），JSON 不支持 shell 的 `~` 展开 |
| 连接超时 | 增大 `MCP_WRAPPER_TIMEOUT`（默认 30000ms），检查 MCP Server 是否能正常启动 |
| tools 能用但 `__connect` 切换无效 | 确认新参数是否正确，查看 Claude Code 的 MCP 日志（stderr）中 `[hot-swap:xxx]` 的输出 |

## 注意事项

- 建议始终配置 `MCP_WRAPPER_DEFAULT`，否则启动时 tools 列表为空，AI 无法直接调用原生 tools
- 同类型 MCP Server 的 tools 列表是固定的（不管连哪个 Redis 实例，tools 都是 `dbsize`、`get`、`set` 等），切换连接不影响 tools 列表
- `__status` 会自动隐藏 password、secret、token 等敏感字段
- 子进程崩溃时会自动重连，最多 3 次，间隔 2 秒
- 密码等敏感信息会出现在 `~/.claude.json` 中，注意文件权限（建议 `chmod 600`）
- 依赖 `@modelcontextprotocol/sdk`，需要 Node.js 18+
- 使用配置文件模板时，临时文件会在切换连接或断开时自动清理

## 开源协议

[MIT](LICENSE)
