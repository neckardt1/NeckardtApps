import type { ReactNode } from "react";
import type { apps } from "./apps.ts";

type AppId = (typeof apps)[number]["id"];

const artwork: Record<AppId, ReactNode> = {
  recall: <>
    <rect x="9" y="11" width="23" height="29" rx="4" transform="rotate(-12 20 25)" fill="#b5dec3" />
    <rect x="15" y="8" width="24" height="29" rx="4" fill="#fff9df" />
    <path d="M26 29v-5" stroke="#21735d" strokeWidth="2.3" strokeLinecap="round" />
    <path d="M26 25c-5 0-7-3-7-7 5 0 8 3 7 7Z" fill="#70a657" />
    <path d="M26 25c0-6 3-10 9-11 0 6-3 10-9 11Z" fill="#287e60" />
  </>,
  sites: <>
    <rect x="6" y="9" width="36" height="29" rx="5" fill="#f4f4ff" />
    <path d="M6 17h36" stroke="#a7b8eb" strokeWidth="2" />
    <path d="M11 13h.1m3.6 0h.1m3.6 0h.1" stroke="#6877ad" strokeWidth="2" strokeLinecap="round" />
    <path d="M20 26v-2a4 4 0 0 1 8 0v2" fill="none" stroke="#425998" strokeWidth="2.6" />
    <rect x="17.5" y="25" width="13" height="9" rx="2.4" fill="#425998" />
    <circle cx="24" cy="29" r="1.3" fill="#f4f4ff" />
  </>,
  tasks: <>
    <rect x="9" y="6" width="30" height="36" rx="5" fill="#fff9eb" />
    <path d="m14 16 2 2 4-5m-6 12 2 2 4-5" fill="none" stroke="#b55134" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
    <circle cx="17" cy="34" r="2.1" fill="none" stroke="#c18a70" strokeWidth="1.8" />
    <path d="M24 16h9m-9 9h9m-9 9h6" stroke="#915139" strokeWidth="2.3" strokeLinecap="round" />
  </>
};

export function AppTileIcon({ id }: { id: AppId }) {
  return <span className={`app-tile-icon ${id}`} aria-hidden="true">
    <svg viewBox="0 0 48 48">{artwork[id]}</svg>
  </span>;
}
