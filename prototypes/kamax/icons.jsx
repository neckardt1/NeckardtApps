import React from "react";

const paths = {
  today: (
    <>
      <rect x="3.5" y="5" width="17" height="16" rx="3" />
      <path d="M7.5 3v4m9-4v4M4 10h16" />
      <circle cx="12" cy="15.5" r="1.5" />
    </>
  ),
  week: (
    <>
      <rect x="3.5" y="5" width="17" height="16" rx="3" />
      <path d="M7.5 3v4m9-4v4M4 10h16m-12 4h2m4 0h2m-8 3h2" />
    </>
  ),
  projects: (
    <>
      <path d="M3 8a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </>
  ),
  spark: (
    <>
      <path d="m12 3 1.9 6.1L20 11l-6.1 1.9L12 19l-1.9-6.1L4 11l6.1-1.9zM19 2v4m-2-2h4" />
    </>
  ),
  target: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <circle cx="12" cy="12" r="4.2" />
      <circle cx="12" cy="12" r=".9" fill="currentColor" stroke="none" />
    </>
  ),
  stack: (
    <>
      <path d="m3 8 9-4 9 4-9 4zM3.5 12l8.5 4 8.5-4m-17 4 8.5 4 8.5-4" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  flag: (
    <>
      <path d="M6 21V4m0 1c5-4 8 4 13 0v9c-5 4-8-4-13 0" />
    </>
  ),
  repeat: (
    <>
      <path d="m17 3 3 3-3 3M4 11V9a3 3 0 0 1 3-3h12M7 21l-3-3 3-3m13-2v2a3 3 0 0 1-3 3H5" />
    </>
  ),
  people: (
    <>
      <circle cx="9" cy="8" r="3" />
      <path d="M3 19v-2a5 5 0 0 1 10 0v2M16 5a3 3 0 0 1 0 6m1 2a5 5 0 0 1 4 5" />
    </>
  ),
  lock: (
    <>
      <rect x="5" y="10" width="14" height="10" rx="2.5" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3" />
    </>
  ),
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19m0-14-1.5 1.5m-11 11L5 19" />
    </>
  ),
  sunset: (
    <>
      <path d="M3 16h18M5 20h14M7 16a5 5 0 1 1 10 0M12 3v3M3 9l2 2m16-2-2 2" />
    </>
  ),
  inbox: (
    <>
      <path d="M3 12.5 6 5h12l3 7.5V19H3zM3 13h5l2 3h4l2-3h5" />
    </>
  ),
  hash: (
    <>
      <path d="m10 3-4 18m12-18-4 18M4 9h16M3 15h16" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  down: <path d="m6 9 6 6 6-6" />,
  right: <path d="m9 6 6 6-6 6" />,
  left: <path d="m15 6-6 6 6 6" />,
  menu: <path d="M4 6h16M4 12h16M4 18h16" />,
  close: <path d="m6 6 12 12M18 6 6 18" />,
  check: <path d="m5 12 4 4 10-10" />,
  more: (
    <>
      <circle cx="5" cy="12" r="1" fill="currentColor" />
      <circle cx="12" cy="12" r="1" fill="currentColor" />
      <circle cx="19" cy="12" r="1" fill="currentColor" />
    </>
  ),
  revisit: (
    <>
      <path d="M4 5v5h5M4.5 10a8 8 0 1 1 .8 7" />
      <path d="M12 8v5l3 2" />
    </>
  ),
  sliders: (
    <>
      <path d="M4 7h9m4 0h3M4 17h3m4 0h9" />
      <circle cx="15" cy="7" r="2" />
      <circle cx="9" cy="17" r="2" />
    </>
  ),
  panel: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M9 4v16" />
    </>
  ),
  bell: (
    <>
      <path d="M5 17h14l-2-3V9a5 5 0 0 0-10 0v5zM10 20h4" />
    </>
  ),
  leaf: (
    <>
      <path d="M19 4C8 4 4 8 6 15c6 5 14 0 13-11ZM5 20l9-11" />
    </>
  ),
};
export function Icon({ name, size = 18, className = "" }) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.65"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {paths[name]}
    </svg>
  );
}
export function Brand() {
  return (
    <span className="brand">
      <svg aria-hidden="true" width="32" height="32" viewBox="0 0 32 32">
        <rect width="32" height="32" rx="9" fill="#C9543F" />
        <path d="M8.5 9.5v13H12v-5.2l5.6 5.2h5.3l-8-7 8-7h-5.2L12 14V9.5z" fill="white" />
      </svg>
      Kamax
    </span>
  );
}
