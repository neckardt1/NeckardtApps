import { z } from "zod";
import { ErrorCode, McpError, ToolSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { scopes } from "./auth.ts";

export class DataToolError extends Error {}

type Fields = Record<string, unknown>;
export type DataRpc = (client: string, actor: string, operation: string, args: Fields, session: string, receipts: string[]) => Promise<unknown>;

export function dataTool<S extends z.ZodObject>(
  name: string, description: string, schema: S, annotations: Tool["annotations"],
  prepare: (value: z.output<S>) => Fields = value => value,
) {
  const securitySchemes = [{ type: "oauth2", scopes }];
  const definition = {
    name, description, inputSchema: ToolSchema.shape.inputSchema.parse(z.toJSONSchema(schema)),
    annotations: { openWorldHint: false, ...annotations }, securitySchemes, _meta: { securitySchemes },
  };
  return { definition, parse(args: Fields) {
    const result = schema.safeParse(args);
    if (!result.success) throw new McpError(ErrorCode.InvalidParams, "Invalid arguments for " + name + ".");
    return prepare(result.data);
  } };
}

export const id = z.string().regex(/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i);
