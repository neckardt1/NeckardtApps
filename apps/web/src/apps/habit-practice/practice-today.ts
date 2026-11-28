import { useEffect, useState } from "react";
import { useSiteSession } from "../../shell/session";
import type { PublicSupabaseConfig } from "../../shell/browser-auth.mts";
import { getSiteClient } from "../../shell/site-client";
import { pacificDate } from "../tasks/model";
import { hasUnfinishedRound } from "./durable-session";

type Status = "checking" | "pending" | "clear" | "unknown";

async function checkPractice(config: PublicSupabaseConfig, owner: string, day: string, signal: AbortSignal): Promise<Status> {
  const client = getSiteClient(config);
  const { data, error } = await client.rpc("recall_latest_round").select("round_id,finished_at").limit(1).abortSignal(signal);
  const latest = data?.[0];
  if (hasUnfinishedRound(config.url, owner, latest?.finished_at ? latest.round_id : undefined)) return "pending";
  if (error?.code === "42501" && error.message === "Deck enrollment required") return "clear";
  if (error) throw error;
  if (latest?.finished_at === null) return "pending";
  if (latest?.finished_at && pacificDate(new Date(latest.finished_at)) === day) return "clear";
  const [cards, actions] = await Promise.all([
    client.rpc("recall_due", { p_limit: 1 }).select("card_id").abortSignal(signal),
    client.rpc("recall_action_queue", { p_limit: 1 }).select("card_id").abortSignal(signal),
  ]);
  if (cards.error || actions.error) throw cards.error ?? actions.error;
  return cards.data?.length || actions.data?.length ? "pending" : "clear";
}

export function usePracticeToday(config: PublicSupabaseConfig | null, day: string) {
  const { user, isCurrent } = useSiteSession();
  const owner = user?.id;
  const [result, setResult] = useState<{ identity: typeof isCurrent; day: string; status: Status }>();
  useEffect(() => {
    if (!owner || !config) return;
    let request: AbortController;
    const load = () => {
      request?.abort();
      request = new AbortController();
      const { signal } = request;
      const publish = (status: Status) => {
        if (!signal.aborted && isCurrent()) setResult({ identity: isCurrent, day, status });
      };
      void checkPractice(config, owner, day, signal).then(publish, () => publish("unknown"));
    };
    const visible = () => { if (document.visibilityState === "visible") load(); };
    const stored = (event: StorageEvent) => { if (!event.key || event.key.startsWith("recall.")) load(); };
    load();
    window.addEventListener("focus", load);
    window.addEventListener("storage", stored);
    document.addEventListener("visibilitychange", visible);
    return () => {
      request.abort();
      window.removeEventListener("focus", load);
      window.removeEventListener("storage", stored);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [config, day, owner, isCurrent]);
  return result?.identity === isCurrent && result.day === day ? result.status : "checking";
}
