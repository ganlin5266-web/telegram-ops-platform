// One consistent line-icon language for the Mini (24px grid, 1.8 stroke).
const paths: Record<string, string> = {
  check: "M5 12.5l4.2 4.2L19 7",
  link: "M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1",
  users:
    "M16 19v-1a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v1M9.5 10a3 3 0 1 0 0-6 3 3 0 0 0 0 6M21 19v-1a4 4 0 0 0-3-3.9M15.5 4.1a3 3 0 0 1 0 5.8",
  growth: "M4 17l5-5 4 4 7-8M15 8h5v5",
  clock: "M12 7v5l3 2M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18",
  gift: "M4 11h16v9H4zM3 7h18v4H3zM12 7v13M12 7c-1.5-3-5-3-5-1s3 1 5 1c2 0 5 1 5-1s-3.5-2-5 1",
  arrow: "M5 12h14M13 6l6 6-6 6",
  home: "M4 11l8-7 8 7v9h-5v-6H9v6H4z",
  badge: "M12 3l2.5 5 5.5.8-4 3.9.9 5.5L12 15.6 7.1 18.2l.9-5.5-4-3.9 5.5-.8z",
  spark:
    "M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6",
  game: "M6 9h12a3 3 0 0 1 3 3v2a3 3 0 0 1-5.2 2H8.2A3 3 0 0 1 3 14v-2a3 3 0 0 1 3-3zM8 11v3M6.5 12.5h3M15 12h.01M17 13.5h.01",
  user: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8M4 21a8 8 0 0 1 16 0",
};
export function Icon({ name }: { name: keyof typeof paths | string }) {
  return (
    <svg
      className="mini-icon"
      viewBox="0 0 24 24"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={paths[name] ?? paths.arrow} />
    </svg>
  );
}
