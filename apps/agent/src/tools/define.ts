import type { z } from 'zod';

/** A custom tool as written in tools.config.ts. `execute` gets arguments typed from `parameters`. */
export interface ToolConfig<S extends z.ZodObject> {
  name: string;
  description: string;
  parameters: S;
  /** Whatever it returns is sent to the LLM (strings as-is, anything else as JSON). Throw to report a failure. */
  execute: (args: z.infer<S>) => unknown | Promise<unknown>;
  /**
   * Optional Markdown file, relative to apps/agent (for example `skills/jaeger.md`), that tells the
   * LLM how to use this tool. It's added to the agent's instructions. Tools that share a file share one section.
   */
  knowledgeFile?: string;
}

/** A tool after defineTool: its argument type is erased so tools with different schemas fit in one list. */
export type CustomTool = Omit<ToolConfig<z.ZodObject>, 'execute'> & {
  execute: (args: unknown) => unknown | Promise<unknown>;
};

/** Keeps the Zod type inference for `execute` while writing the tool, then erases it for the tool list. */
export function defineTool<S extends z.ZodObject>(tool: ToolConfig<S>): CustomTool {
  // Safe: LiveKit validates the LLM's arguments against `parameters` before calling execute.
  return tool as unknown as CustomTool;
}
