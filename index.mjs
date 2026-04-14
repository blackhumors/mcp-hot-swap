#!/usr/bin/env node

/**
 * MCP Hot-Swap Wrapper
 * Universal MCP Server proxy with runtime connection hot-swapping.
 *
 * Supports three parameter passing methods (can be combined):
 *   - MCP_WRAPPER_TEMPLATE: CLI argument template (e.g. redis)
 *   - MCP_WRAPPER_ENV_TEMPLATE: Environment variable template (e.g. postgres)
 *   - MCP_WRAPPER_CONFIG_TEMPLATE: Config file template, generates temp file (e.g. mcp-dbutils)
 *     Use MCP_WRAPPER_CONFIG_ARG to specify the argument name (default: --config)
 *
 * @author wangyulong
 * @license MIT
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { writeFileSync, mkdirSync, unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// ─── Config Loading ─────────────────────────────────────────────────
function loadConfig() {
  const name = process.env.MCP_WRAPPER_NAME || "mcp-proxy";
  const command = process.env.MCP_WRAPPER_COMMAND || "";
  const template = process.env.MCP_WRAPPER_TEMPLATE || "";
  const envTemplate = process.env.MCP_WRAPPER_ENV_TEMPLATE || "";
  const configTemplate = process.env.MCP_WRAPPER_CONFIG_TEMPLATE || "";
  const configArg = process.env.MCP_WRAPPER_CONFIG_ARG || "--config";

  let params = {};
  try { params = JSON.parse(process.env.MCP_WRAPPER_PARAMS || "{}"); } catch { params = {}; }

  let defaultParams = null;
  try {
    const raw = process.env.MCP_WRAPPER_DEFAULT;
    if (raw) defaultParams = JSON.parse(raw);
  } catch { defaultParams = null; }

  return { name, command, template, envTemplate, configTemplate, configArg, params, defaultParams };
}

// ─── Template Utilities ─────────────────────────────────────────────
function render(tpl, values) {
  return tpl.replace(/\$\{(\w+)\}/g, (_, k) => values[k] !== undefined ? values[k] : "");
}

function shellSplit(str) {
  const args = []; let cur = "", inQ = false, qc = "";
  for (const ch of str) {
    if (inQ) { if (ch === qc) inQ = false; else cur += ch; }
    else if (ch === '"' || ch === "'") { inQ = true; qc = ch; }
    else if (ch === " " || ch === "\t") { if (cur) { args.push(cur); cur = ""; } }
    else cur += ch;
  }
  if (cur) args.push(cur);
  return args;
}

function parseEnvTpl(rendered) {
  const env = {};
  if (!rendered) return env;
  for (const p of rendered.split(",")) {
    const i = p.indexOf("=");
    if (i > 0) env[p.slice(0, i).trim()] = p.slice(i + 1).trim();
  }
  return env;
}

// ─── Temp Config File Management ────────────────────────────────────
const tmpDir = join(tmpdir(), "mcp-hot-swap");
mkdirSync(tmpDir, { recursive: true });
let currentTmpFile = null;

function writeTmpConfig(name, content) {
  cleanTmpConfig();
  const file = join(tmpDir, `${name}-${Date.now()}.yaml`);
  writeFileSync(file, content, "utf-8");
  currentTmpFile = file;
  return file;
}

function cleanTmpConfig() {
  if (currentTmpFile) {
    try { unlinkSync(currentTmpFile); } catch {}
    currentTmpFile = null;
  }
}

// ─── Build Launch Config ────────────────────────────────────────────
function buildLaunchConfig(config, values) {
  const { command, template, envTemplate, configTemplate, configArg } = config;

  const renderedArgs = template ? render(template, values) : "";
  const finalArgs = renderedArgs ? shellSplit(renderedArgs) : [];

  const renderedEnv = envTemplate ? render(envTemplate, values) : "";
  const finalEnv = parseEnvTpl(renderedEnv);

  if (configTemplate) {
    const renderedConfig = render(configTemplate, values);
    const tmpFile = writeTmpConfig(config.name, renderedConfig);
    finalArgs.push(configArg, tmpFile);
  }

  return { command, args: finalArgs, env: finalEnv };
}

// ─── Child Process Management ───────────────────────────────────────
class ChildMcp {
  constructor() { this.client = null; this.transport = null; this.tools = []; this.params = null; }

  async connect(command, args, env) {
    await this.disconnect();
    this.transport = new StdioClientTransport({ command, args, env: { ...process.env, ...env } });
    this.client = new Client({ name: "mcp-hot-swap-client", version: "1.0.0" }, { capabilities: {} });
    await this.client.connect(this.transport);
    try { this.tools = (await this.client.listTools()).tools || []; } catch { this.tools = []; }
  }

  async callTool(name, args) {
    if (!this.client) throw new Error("Not connected");
    return await this.client.callTool({ name, arguments: args });
  }

  async disconnect() {
    if (this.client) {
      try { await this.transport.close(); } catch {}
      this.client = null; this.transport = null; this.tools = []; this.params = null;
    }
  }
}

// ─── Main ───────────────────────────────────────────────────────────
async function main() {
  const config = loadConfig();
  const { name, params, defaultParams } = config;
  const child = new ChildMcp();

  if (!config.command) {
    process.stderr.write(`[hot-swap:${name}] Error: MCP_WRAPPER_COMMAND is not set\n`);
    process.exit(1);
  }

  // Connect with default params on startup to get tools list
  let registeredTools = [];
  if (defaultParams) {
    try {
      const launch = buildLaunchConfig(config, defaultParams);
      await child.connect(launch.command, launch.args, launch.env);
      child.params = defaultParams;
      registeredTools = child.tools.map(t => ({
        name: t.name, description: t.description, inputSchema: t.inputSchema,
      }));
      process.stderr.write(`[hot-swap:${name}] Connected with defaults, ${registeredTools.length} tools registered\n`);
    } catch (err) {
      process.stderr.write(`[hot-swap:${name}] Default connection failed: ${err.message}\n`);
    }
  } else {
    process.stderr.write(`[hot-swap:${name}] No MCP_WRAPPER_DEFAULT set, use __connect manually\n`);
  }

  // Build __connect schema from params
  const connectProps = {};
  const connectRequired = [];
  for (const [key, desc] of Object.entries(params)) {
    connectProps[key] = { type: "string", description: String(desc) };
    if (!/default|optional|可选|默认/.test(String(desc))) connectRequired.push(key);
  }
  const paramDesc = Object.entries(params).map(([k, v]) => `  - ${k}: ${v}`).join("\n");

  // Management tools
  const mgmtTools = [
    {
      name: "__connect",
      description: [
        `Switch [${name}] connection. Pass new connection parameters to switch to a different instance without restarting.`,
        paramDesc ? `Parameters:\n${paramDesc}` : "",
      ].filter(Boolean).join("\n"),
      inputSchema: { type: "object", properties: connectProps, required: connectRequired },
    },
    {
      name: "__status",
      description: `View current [${name}] connection info.`,
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "__disconnect",
      description: `Disconnect current [${name}] connection.`,
      inputSchema: { type: "object", properties: {} },
    },
  ];

  // Server
  const server = new Server(
    { name: `hot-swap:${name}`, version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: [...mgmtTools, ...registeredTools] };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name: toolName, arguments: toolArgs } = request.params;

    if (toolName === "__connect") {
      try {
        const launch = buildLaunchConfig(config, toolArgs);
        await child.connect(launch.command, launch.args, launch.env);
        child.params = toolArgs;

        if (registeredTools.length === 0 && child.tools.length > 0) {
          registeredTools = child.tools.map(t => ({
            name: t.name, description: t.description, inputSchema: t.inputSchema,
          }));
          try { await server.notification({ method: "notifications/tools/list_changed" }); } catch {}
        }

        return {
          content: [{
            type: "text",
            text: `[${name}] Connection switched: ${JSON.stringify(toolArgs)}\nAvailable tools: ${child.tools.length}`,
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Connection failed: ${err.message}` }], isError: true };
      }
    }

    if (toolName === "__status") {
      if (!child.client) {
        return { content: [{ type: "text", text: `[${name}] Not connected` }] };
      }
      return {
        content: [{
          type: "text",
          text: JSON.stringify({ name, connected: true, params: child.params, tools_count: child.tools.length }, null, 2),
        }],
      };
    }

    if (toolName === "__disconnect") {
      await child.disconnect();
      cleanTmpConfig();
      return { content: [{ type: "text", text: `[${name}] Disconnected` }] };
    }

    // Proxy to child process
    if (!child.client) {
      return {
        content: [{ type: "text", text: `[${name}] Not connected. Call __connect first with: ${Object.keys(params).join(", ")}` }],
        isError: true,
      };
    }
    try {
      return await child.callTool(toolName, toolArgs);
    } catch (err) {
      return { content: [{ type: "text", text: `${toolName} failed: ${err.message}` }], isError: true };
    }
  });

  // Start
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(`[hot-swap:${name}] Wrapper started\n`);

  const cleanup = async () => { await child.disconnect(); cleanTmpConfig(); process.exit(0); };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
}

main().catch((err) => { console.error("Startup failed:", err); process.exit(1); });
