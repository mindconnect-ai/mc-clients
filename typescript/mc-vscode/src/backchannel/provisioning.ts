import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentToolBinding, MindconnectClient } from "../api/client";

/** Registration id and tool prefix: the tools reach the agents as vscode_edit_file etc. */
export const MCP_SERVER_ID = "vscode";
export const VSCODE_AGENT = "vscode-assistant";
const TEMPLATE_AGENT = "coding-assistant";

/** The back channel's tools, as the MCP gateway names them. */
export const VSCODE_TOOLS = ["vscode_edit_file", "vscode_write_file", "vscode_open_file", "vscode_get_diagnostics"];
/** The template's tools that write to disk themselves — replaced by the reviewed ones. */
const REPLACED_TOOLS = new Set(["file_edit", "file_write"]);

const PROMPT_ADDENDUM = `

## Working in VS Code

You run inside the user's VS Code; every message starts with an <editor-context> block saying which folder, file and selection they are looking at.

- Change files only with vscode_edit_file and vscode_write_file. The user reviews each change as a diff and accepts or rejects it; their unsaved editor changes are part of what you edit. A rejected change is final — ask what they want instead of trying again another way.
- Use vscode_open_file to show the user a place in the code.
- Use vscode_get_diagnostics to see the compiler's and linter's errors and warnings, before and after a change.`;

/**
 * Registers the extension's MCP server with the MindConnect server by
 * dropping its registration file where the gateway reads them — the store
 * re-reads the directory on every lookup, no restart needed. Only possible
 * for a managed server: this is its data directory.
 */
export async function registerToolServer(dataDir: string, namespace: string, url: string, token: string): Promise<void> {
  const dir = path.join(dataDir, namespace, "system", "mcp-servers");
  await fs.mkdir(dir, { recursive: true });
  const registration = {
    id: MCP_SERVER_ID,
    displayName: "VS Code",
    description: "The VS Code window running the MindConnect extension: reviewed file changes, opening files, diagnostics.",
    enabled: true,
    toolNamePrefix: MCP_SERVER_ID,
    target: { type: "http", url, headers: { Authorization: `Bearer ${token}` } },
    updatedAt: new Date().toISOString(),
  };
  const file = path.join(dir, `${MCP_SERVER_ID}.json`);
  await fs.writeFile(`${file}.tmp`, JSON.stringify(registration, null, 2), { mode: 0o600 });
  await fs.rename(`${file}.tmp`, file);
}

/**
 * Makes sure the agent @mindconnect uses by default exists: a copy of
 * coding-assistant whose own file writers are swapped for the reviewed VS Code
 * tools. An existing one only gets missing VS Code tools added — whatever
 * else was changed on it in the Admin UI stays.
 */
export async function ensureVsCodeAgent(client: MindconnectClient): Promise<void> {
  const agents = await client.listAgents();
  const existing = agents.find((a) => a.name === VSCODE_AGENT);
  if (existing) {
    const definition = await client.agentDefinition(existing.id);
    const tools = definition.tools ?? [];
    const missing = VSCODE_TOOLS.filter((name) => !tools.some((t) => t.name === name));
    if (missing.length) await client.updateTools(existing.id, [...tools, ...missing.map(binding)]);
    return;
  }

  const template = agents.find((a) => a.name === TEMPLATE_AGENT);
  if (!template) throw new Error(`The server has no ${TEMPLATE_AGENT} agent to base ${VSCODE_AGENT} on.`);
  const source = await client.agentDefinition(template.id);
  const copy = await client.copyAgent(template.id);
  await client.updateAgent(copy.id, {
    name: VSCODE_AGENT,
    description: "Works in the user's VS Code: reads the project, proposes changes as diffs the user accepts or rejects.",
    systemPrompt: (source.systemPrompt ?? "") + PROMPT_ADDENDUM,
  });
  const tools = (source.tools ?? [])
    .filter((t) => !REPLACED_TOOLS.has(t.name))
    // Tool ids are per agent — the copy gets fresh ones.
    .map(({ id: _id, ...rest }) => rest);
  await client.updateTools(copy.id, [...tools, ...VSCODE_TOOLS.map(binding)]);
}

function binding(name: string): AgentToolBinding {
  // No approval dialog: reviewing the diff is the approval.
  return { name, enabled: true, deferred: false, needsApproval: false };
}
