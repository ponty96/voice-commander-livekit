import type { z } from 'zod';

/** A custom tool the LLM can call. `execute` gets arguments typed from `parameters`. */
export interface ToolConfig<S extends z.ZodObject = z.ZodObject> {
  name: string;
  description: string;
  parameters: S;
  /** Whatever it returns is sent to the LLM (strings as-is, anything else as JSON). Throw to report a failure. */
  execute: (args: z.infer<S>) => unknown | Promise<unknown>;
}

/** Identity helper that keeps the Zod type inference for `execute`. */
export function defineTool<S extends z.ZodObject>(tool: ToolConfig<S>): ToolConfig<S> {
  return tool;
}
