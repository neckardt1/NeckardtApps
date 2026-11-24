import { MemoryRouter } from "react-router";
import { SiteRoot } from '../../../src/shell/SiteRoot.tsx';
import type { SessionApi, SessionUser } from '../../../src/shell/session.tsx';
import { App } from '../../../src/apps/habit-practice/App.tsx';
import type { RecallApi } from '../../../src/apps/habit-practice/recall-api.ts';

// Synthetic observer-backed auth for the real shared shell; no SDK or network.
export function makeSessionFixture(initialOwner: string | null | undefined = 'owner') {
  let owner = initialOwner;
  const observers = new Set<{ change: (user: SessionUser | null) => void; error?: (error: unknown) => void }>();
  const emit = (nextOwner: string | null) => {
    owner = nextOwner;
    for (const observer of observers) observer.change(owner ? { id: owner } : null);
  };
  const api: SessionApi = {
    observe(change, error) {
      const observer = { change, error }; observers.add(observer);
      if (owner !== undefined) change(owner ? { id: owner } : null);
      return () => { observers.delete(observer); };
    },
    async signIn() { emit('owner'); },
    async signOut() { emit(null); }
  };
  return { api, emit, fail() { for (const observer of observers) observer.error?.(new Error('Synthetic session failure')); } };
}

export function ReviewFixture({ api, sessionApi }: { api: RecallApi | null; sessionApi: SessionApi | null }) {
  return <MemoryRouter initialEntries={["/recall/"]}>
    <SiteRoot api={sessionApi}><App api={api} /></SiteRoot>
  </MemoryRouter>;
}
