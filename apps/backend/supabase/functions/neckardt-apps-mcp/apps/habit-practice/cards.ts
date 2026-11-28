import { z } from "zod";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { dataTool, id } from "../../data-tool.ts";

const wording = z.string().regex(/\S/);
const card = z.strictObject({ id, front: wording, back: wording });
const item = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("fact"), card }),
  z.strictObject({ kind: z.literal("habit"), cue: card, action: card }),
]);

export const cardTools = [
  dataTool("get_cards", "Get your Habit Practice cards, including prompt, answer, pair link, active status and due date. Supply IDs for exact lookup or use next_after to page through the deck.",
    z.strictObject({ ids: z.array(id).min(1).max(100).optional(), after: id.optional(), limit: z.int().min(1).max(100).optional() }),
    { readOnlyHint: true }, args => {
      if (args.ids && (args.after || args.limit))
        throw new McpError(ErrorCode.InvalidParams, "Use IDs or pagination.");
      return args;
    }),
  dataTool("create_cards", "Save approved facts and paired habits. First show the entire batch privately, numbered, with each bold front above its blockquoted back. Wait for explicit approval of that exact wording. Preview again after edits. Include only approved items and keep each pair together. Reuse the same card IDs after an uncertain result. Returns verified saved cards.",
    z.strictObject({ approved_exact_wording: z.literal(true), items: z.array(item).min(1).max(50) }),
    { readOnlyHint: false, destructiveHint: false, idempotentHint: true }, ({ items }) => {
      const cards = items.flatMap(item => item.kind === "fact"
        ? [{ ...item.card, kind: "fact", cue_card_id: null as string | null }]
        : [{ ...item.cue, kind: "habit-recall", cue_card_id: null }, { ...item.action, kind: "habit-action", cue_card_id: item.cue.id }]);
      if (new Set(cards.map(card => card.id.toLowerCase())).size !== cards.length)
        throw new McpError(ErrorCode.InvalidParams, "Each card needs its own stable ID.");
      return { cards };
    }),
];
