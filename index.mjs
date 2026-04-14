#!/usr/bin/env node

/**
 * MCP Hot-Swap Wrapper v2
 * Universal MCP Server proxy with runtime connection hot-swapping.
 *
 * Supports three parameter passing methods (can be combined):
 *   - MCP_WRAPPER_TEMPLATE: CLI argument template (e.g. redis)
 *   - MCP_WRAPPER_ENV_TEMPLATE: Environment variable template (e.g. postgres)
 *   - MCP_WRAPPER_CONFIG_TEMPLATE: Config file template, generates temp file (e.g. mcp-dbutils)
 *     Use MCP_WRAPPER_CONFIG_ARG to specify the argument name (default: --config)
 *
 * v2 changes:
 *   - Proxy resources and prompts (full MCP protocol passthrough)
 *   - Connection timeout (default 30s, configurable via MCP_WRAPPER_TIMEOUT)
 *   - Auto-reconnect on child process crash (3 retries, 2s interval)
 *   - Password masking in __status output
 *   - JSON parse errors logged to stderr instead of silently swallowed
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
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { writeFileSync, mkdirSync, unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// ─── Logging ─────────────────────────────────────────────────────
function log(name, msg) {
  process.stderr.write(`[hot-swap:${name}] ${msg}\n`);
}

// ─── Config Loading ──────────────────────────────────────────────
function loadConfig() {
  const name = process.env.MCP_WRAPPER_NAME || "mcp-proxy";
  const command = process.env.MCP_WRAPPER_COMMAND || "";
  const template = process.env.MCP_WRAPPER_TEMPLATE || "";
  const envTemplate = process.env.MCP_WRAPPER_ENV_TEMPLATE || "";
  const configTemplate = process.env.MCP_WRAPPER_CONFIG_TEMPLATE || "";
  const configArg = process.env.MCP_WRAPPER_CONFIG_ARG || "--config";
  const timeout = parseInt(process.env.MCP_WRAPPER_TIMEOUT || "30000", 10);

  let params = {};
  try {
    params = JSON.parse(process.env.MCP_WRAPPER_PARAMS || "{}");
  } catch (err) {
    log(name, `Warning: MCP_WRAPPER_PARAMS JSON parse failed: ${err.message}, using empty params`);
  }

  let defaultParams = null;
  try {
    const raw = process.env.MCP_WRAPPER_DEFAULT;
    if (raw) defaultParams = JSON.parse(raw);
  } catch (err) {
    log(name, `Warning: MCP_WRAPPER_DEFAULT JSON parse failed: ${err.message}, skipping default connection`);
  }

  return { name, command, template, envTemplate, configTemplate, configArg, timeout, params, defaultParams };
}

// ─── Template Utilities ──────────────────────────────────────────
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

// ─── Timeout Utility ─────────────────────────────────────────────
function withTimeout(promise, ms, msg) {
  if (!ms || ms <= 0) return promise;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(msg || `Timeout (${ms}ms)`)), ms);
    promise.then(
      (val) => { clearTimeout(timer); resolve(val); },
      (err) => { clearTimeout(timer); reject(err); }
    );
  });
}

// ─── Temp Config File Management ─────────────────────────────────
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

// ─── Build Launch Config ─────────────────────────────────────────
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

// ─── Child Process Management ────────────────────────────────────
class ChildMcp {
  constructor(wrapperName, timeout) {
    this.client = null;
    this.transport = null;
    this.tools = [];
    this.resources = [];
    this.prompts = [];
    this.params = null;
    this.wrapperName = wrapperName;
    this.timeout = timeout;
    this._lastCommand = null;
    this._lastArgs = null;
    this._lastEnv = null;
    this._reconnecting = false;
    this._intentionalDisconnect = false;
  }

  async connect(command, args, env) {
    this._intentionalDisconnect = true;
    await this._doDisconnect();
    this._intentionalDisconnect = false;

    this._lastCommand = command;
    this._lastArgs = args;
    this._lastEnv = env;

    await this._doConnect(command, args, env);
  }

  async _doConnect(command, args, env) {
    this.transport = new StdioClientTransport({ command, args, env: { ...process.env, ...env } });
    this.client = new Client({ name: "mcp-hot-swap-client", version: "2.0.0" }, { capabilities: {} });

    await withTimeout(
      this.client.connect(this.transport),
      this.timeout,
      `Connection timeout (${this.timeout}ms) — check MCP_WRAPPER_COMMAND`
    );

    // Listen for unexpected disconnects via SDK's Protocol.onclose callback
    this.client.onclose = () => this._handleClose();

    // Fetch tools
    try {
      this.tools = (await withTimeout(this.client.listTools(), this.timeout, "Timeout fetching tools")).tools || [];
    } catch (err) {
      log(this.wrapperName, `Failed to fetch tools: ${err.message}`);
      this.tools = [];
    }

    // Fetch resources/prompts only if the server declares support
    const serverCaps = this.client.getServerCapabilities?.() || {};

    if (serverCaps.resources) {
      try {
        const res = await withTimeout(this.client.listResources(), 5000, "Timeout fetching resources");
        this.resources = res.resources || [];
      } catch {
        this.resources = [];
      }
    } else {
      this.resources = [];
    }

    if (serverCaps.prompts) {
      try {
        const res = await withTimeout(this.client.listPrompts(), 5000, "Timeout fetching prompts");
        this.prompts = res.prompts || [];
      } catch {
        this.prompts = [];
      }
    } else {
      this.prompts = [];
    }
  }

  _handleClose() {
    if (this._intentionalDisconnect || this._reconnecting) return;
    log(this.wrapperName, "Child process disconnected, attempting auto-reconnect...");
    this._autoReconnect();
  }

  async _autoReconnect() {
    if (this._reconnecting) return;
    this._reconnecting = true;

    this.client = null;
    this.transport = null;

    const maxRetries = 3;
    const retryDelay = 2000;

    for (let i = 1; i <= maxRetries; i++) {
      try {
        log(this.wrapperName, `Auto-reconnect attempt ${i}/${maxRetries}...`);
        await new Promise(r => setTimeout(r, retryDelay));
        await this._doConnect(this._lastCommand, this._lastArgs, this._lastEnv);
        log(this.wrapperName, `Auto-reconnect succeeded, ${this.tools.length} tools`);
        this._reconnecting = false;
        return;
      } catch (err) {
        log(this.wrapperName, `Reconnect failed (${i}/${maxRetries}): ${err.message}`);
        this.client = null;
        this.transport = null;
      }
    }

    log(this.wrapperName, "Auto-reconnect failed after max retries. Call __connect manually to reconnect");
    this.tools = [];
    this.resources = [];
    this.prompts = [];
    this._reconnecting = false;
  }

  async callTool(name, args) {
    if (!this.client) throw new Error("Not connected");
    return await this.client.callTool({ name, arguments: args });
  }

  async readResource(uri) {
    if (!this.client) throw new Error("Not connected");
    return await this.client.readResource({ uri });
  }

  async getPrompt(name, args) {
    if (!this.client) throw new Error("Not connected");
    return await this.client.getPrompt({ name, arguments: args });
  }

  async disconnect() {
    this._intentionalDisconnect = true;
    await this._doDisconnect();
    this._intentionalDisconnect = false;
  }

  async _doDisconnect() {
    if (this.client) {
      this.client.onclose = null;
      try { await this.transport.close(); } catch {}
      this.client = null;
      this.transport = null;
      this.tools = [];
      this.resources = [];
      this.prompts = [];
      this.params = null;
    }
  }
}

// ─── Main ────────────────────────────────────────────────────────
async function main() {
  const config = loadConfig();
  const { name, params, defaultParams, timeout } = config;
  const child = new ChildMcp(name, timeout);

  if (!config.command) {
    log(name, "Error: MCP_WRAPPER_COMMAND is not set");
    process.exit(1);
  }

  // Connect with defaults on startup to discover capabilities
  let registeredTools = [];
  let registeredResources = [];
  let registeredPrompts = [];

  if (defaultParams) {
    try {
      const launch = buildLaunchConfig(config, defaultParams);
      await child.connect(launch.command, launch.args, launch.env);
      child.params = defaultParams;
      registeredTools = child.tools.map(t => ({
        name: t.name, description: t.description, inputSchema: t.inputSchema,
      }));
      registeredResources = child.resources.map(r => ({
        uri: r.uri, name: r.name, description: r.description, mimeType: r.mimeType,
      }));
      registeredPrompts = child.prompts.map(p => ({
        name: p.name, description: p.description, arguments: p.arguments,
      }));
      const caps = [
        `${registeredTools.length} tools`,
        registeredResources.length ? `${registeredResources.length} resources` : null,
        registeredPrompts.length ? `${registeredPrompts.length} prompts` : null,
      ].filter(Boolean).join(", ");
      log(name, `Connected with defaults, ${caps}`);
    } catch (err) {
      log(name, `Default connection failed: ${err.message}`);
    }
  } else {
    log(name, "No MCP_WRAPPER_DEFAULT set, use __connect manually");
  }

  // Build __connect schema from params
  const connectProps = {};
  const connectRequired = [];
  for (const [key, desc] of Object.entries(params)) {
    connectProps[key] = { type: "string", description: String(desc) };
    if (!/default|optional|默认|可选/i.test(String(desc))) connectRequired.push(key);
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

  // Server — always declare all capabilities; return empty lists if unsupported
  const capabilities = { tools: {}, resources: {}, prompts: {} };

  const server = new Server(
    { name: `hot-swap:${name}`, version: "2.0.0" },
    { capabilities }
  );

  // ─── Tools handler ─────────────────────────────────────────
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

        // Always sync tools (supports switching to different server types)
        const oldToolCount = registeredTools.length;
        registeredTools = child.tools.map(t => ({
          name: t.name, description: t.description, inputSchema: t.inputSchema,
        }));
        if (oldToolCount !== registeredTools.length || oldToolCount === 0) {
          try { await server.notification({ method: "notifications/tools/list_changed" }); } catch {}
        }

        registeredResources = child.resources.map(r => ({
          uri: r.uri, name: r.name, description: r.description, mimeType: r.mimeType,
        }));
        registeredPrompts = child.prompts.map(p => ({
          name: p.name, description: p.description, arguments: p.arguments,
        }));

        const caps = [
          `${child.tools.length} tools`,
          child.resources.length ? `${child.resources.length} resources` : null,
          child.prompts.length ? `${child.prompts.length} prompts` : null,
        ].filter(Boolean).join(", ");

        return {
          content: [{
            type: "text",
            text: `[${name}] Connection switched: ${JSON.stringify(toolArgs)}\nAvailable: ${caps}`,
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
      // Mask sensitive fields
      const safeParams = child.params ? Object.fromEntries(
        Object.entries(child.params).map(([k, v]) =>
          /password|passwd|secret|token/i.test(k) ? [k, "***"] : [k, v]
        )
      ) : null;
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            name,
            connected: true,
            params: safeParams,
            tools_count: child.tools.length,
            resources_count: child.resources.length,
            prompts_count: child.prompts.length,
          }, null, 2),
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

  // ─── Resources handler ─────────────────────────────────────
  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    return { resources: registeredResources };
  });

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    if (!child.client) {
      throw new Error(`[${name}] Not connected. Call __connect first`);
    }
    try {
      return await child.readResource(request.params.uri);
    } catch (err) {
      throw new Error(`Failed to read resource: ${err.message}`);
    }
  });

  // ─── Prompts handler ───────────────────────────────────────
  server.setRequestHandler(ListPromptsRequestSchema, async () => {
    return { prompts: registeredPrompts };
  });

  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    if (!child.client) {
      throw new Error(`[${name}] Not connected. Call __connect first`);
    }
    try {
      return await child.getPrompt(request.params.name, request.params.arguments);
    } catch (err) {
      throw new Error(`Failed to get prompt: ${err.message}`);
    }
  });

  // ─── Start ─────────────────────────────────────────────────
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log(name, "Wrapper started");

  const cleanup = async () => { await child.disconnect(); cleanTmpConfig(); process.exit(0); };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
}

main().catch((err) => { console.error("Startup failed:", err); process.exit(1); });
