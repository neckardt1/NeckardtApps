import { scopes } from "../../auth.ts";

const reviewUrl = "https://apps.neckardt.com/recall/";
const securitySchemes = [{ type: "oauth2", scopes }];
export const linkTool = {
  name: "get_habit_practice_link",
  title: "Open Habit Practice",
  description: "Get the link to start or resume a review in the Habit Practice web app.",
  inputSchema: { type: "object" as const, properties: { debrief: { type: "boolean", description: "Legacy option. All links open the review directly." } }, additionalProperties: false },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  securitySchemes,
  _meta: { securitySchemes },
};

export function getHabitPracticeLink() {
  const url = reviewUrl;
  return { content: [{ type: "text", text: url }], structuredContent: { url } };
}
