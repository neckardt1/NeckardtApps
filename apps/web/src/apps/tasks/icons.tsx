const paths = {
  inbox: "m3 14 3-9h12l3 9v5H3z M3 14h5l2 3h4l2-3h5",
  today: "M4 6h16v14H4z M8 3v5m8-5v5M4 10h16m-11 4h4",
  week: "M3 6h18v14H3z M7 3v5m10-5v5M3 10h18m-13 4h2m4 0h2",
  private: "M6 10h12v10H6z M8 10V7a4 4 0 0 1 8 0v3",
  household: "m3 11 9-8 9 8M5 10v11h5v-7h4v7h5V10",
  tasks: "M4 6l1.5 1.5L9 4m3 2h8M4 13l1.5 1.5L9 11m3 2h8m-8 6h8",
  browse: "M3 4h7v7H3z M14 4h7v7h-7z M3 15h7v6H3z M14 15h7v6h-7z",
  add: "M12 4v16M4 12h16",
  close: "m6 6 12 12M6 18 18 6",
  bell: "M5 17h14l-2-3V9a5 5 0 0 0-10 0v5z M10 20a2.5 2.5 0 0 0 4 0",
  refresh: "M19 9a7.5 7.5 0 1 0 .3 6M19 4v5h-5",
  edit: "m5 15 10-10 4 4L9 19l-5 1z M13 7l4 4",
  more: "M4 12h1m6 0h1m6 0h1",
  focus: "M12 3v4m9 5h-4m-5 9v-4m-9-5h4 M19.5 12a7.5 7.5 0 1 1-15 0a7.5 7.5 0 1 1 15 0",
  deprioritize: "m3 7 9-4 9 4-9 4z M3 12l9 4 9-4M3 17l9 4 9-4",
  tomorrow: "M12 2v3m0 14v3M2 12h3m14 0h3M5 5l2 2m10 10 2 2M5 19l2-2M17 7l2-2 M16 12a4 4 0 1 1-8 0a4 4 0 1 1 8 0",
  weekend: "M2 16h20M4 20h16M7 16a5 5 0 0 1 10 0M12 4v3M4 8l2 2m12 0 2-2",
  nextWeek: "M3 6h18v14H3zM7 3v5m10-5v5M3 10h18m-13 5h8m-3-3 3 3-3 3",
  later: "M3 6h18v14H3zM7 3v5m10-5v5M3 10h18m-11 3 2 2-2 2m4-4 2 2-2 2",
  left: "m14 5-7 7 7 7",
  right: "m10 5 7 7-7 7",
  check: "m4 12 5 5L20 6"
} as const;

export function TaskIcon({ name, size = 18 }: { name: keyof typeof paths; size?: number }) {
  return <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24"
    fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round"
    strokeWidth={name === "more" ? 3.5 : 1.7}><path d={paths[name]} /></svg>;
}
