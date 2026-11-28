import { createContext, useContext, useLayoutEffect } from "react";
import { useLocation, useNavigate } from "react-router";
import { useSiteSession } from "./session";

// Back and Forward restore views in this document. A reload or a different owner starts at the landing page.
export function useAppView(home: string) {
  const location = useLocation();
  const navigate = useNavigate();
  const { user } = useSiteSession();
  const entry = location.state?.appView;
  const view: string = user && entry?.owner === user.id && entry.document === performance.timeOrigin ? entry.name : home;

  function choose(name: string) {
    const { pathname, search, hash } = location;
    void navigate({ pathname, search, hash }, {
      state: name === home ? null : { appView: { owner: user?.id, document: performance.timeOrigin, name } },
      replace: name === view,
    });
  }
  return [view, choose] as const;
}

export const AppHomeBusy = createContext<((busy: boolean) => void) | null>(null);

export function useAppHomeBusy(busy: boolean) {
  const setBusy = useContext(AppHomeBusy);
  useLayoutEffect(() => {
    if (!busy || !setBusy) return;
    setBusy(true);
    return () => setBusy(false);
  }, [busy, setBusy]);
}
