import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** apps/agent: relative SYSTEM_CONTEXT_PATH values resolve from here, like mcp.json's paths. */
const AGENT_DIR = fileURLToPath(new URL('..', import.meta.url));

/**
 * Reads the system context file named by SYSTEM_CONTEXT_PATH: what the application under
 * investigation is and how its services fit together. Unset means no system context. Set but
 * missing, unreadable or empty throws, so the agent never starts without the context it was given.
 */
export function loadSystemContext(path = process.env.SYSTEM_CONTEXT_PATH, baseDir = AGENT_DIR) {
  if (!path) {
    console.log('[agent] no system context (SYSTEM_CONTEXT_PATH is not set)');
    return undefined;
  }
  const fullPath = resolve(baseDir, path);
  let text: string;
  try {
    text = readFileSync(fullPath, 'utf8').trim();
  } catch (err) {
    throw new Error(`SYSTEM_CONTEXT_PATH=${path}: could not read ${fullPath}: ${(err as Error).message}`);
  }
  if (!text) throw new Error(`SYSTEM_CONTEXT_PATH=${path}: ${fullPath} is empty`);
  console.log(`[agent] system context: ${path} (${text.length} chars)`);
  return text;
}

/** Commander's instructions: the persona, then the system context, then the MCP servers' knowledge files. */
export function buildInstructions(base: string, systemContext?: string, toolKnowledge?: string) {
  return [
    base,
    systemContext && `# System context: the application you are investigating\n\n${systemContext}`,
    toolKnowledge,
  ]
    .filter(Boolean)
    .join('\n\n');
}
