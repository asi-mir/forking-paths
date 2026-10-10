import type { SVGProps } from "react";

/** Inline SVG icons (no icon font, no emoji). They inherit currentColor. */

type P = SVGProps<SVGSVGElement> & { size?: number };

const base = ({ size = 20, ...rest }: P) => ({
  width: size,
  height: size,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
  ...rest,
});

export const PlayIcon = (p: P) => (
  <svg {...base(p)}>
    <path d="M8 5.5v13l10.5-6.5z" fill="currentColor" stroke="none" />
  </svg>
);

export const StopIcon = (p: P) => (
  <svg {...base(p)}>
    <rect x="7" y="7" width="10" height="10" rx="1.5" fill="currentColor" stroke="none" />
  </svg>
);

export const CameraIcon = (p: P) => (
  <svg {...base(p)}>
    <path d="M4 8.5h3l1.6-2.5h6.8L17 8.5h3a1 1 0 0 1 1 1V18a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9.5a1 1 0 0 1 1-1z" />
    <circle cx="12" cy="13.5" r="3.5" />
  </svg>
);

export const ExternalIcon = (p: P) => (
  <svg {...base(p)}>
    <path d="M14 5h5v5M19 5l-8 8M17 14v4a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1h4" />
  </svg>
);

export const PinIcon = (p: P) => (
  <svg {...base(p)}>
    <path d="M12 21s-6.5-6.2-6.5-11a6.5 6.5 0 0 1 13 0c0 4.8-6.5 11-6.5 11z" />
    <circle cx="12" cy="10" r="2.3" />
  </svg>
);

export const CheckIcon = (p: P) => (
  <svg {...base(p)}>
    <path d="M5 12.5l4.5 4.5L19 7.5" />
  </svg>
);

export const ArrowRightIcon = (p: P) => (
  <svg {...base(p)}>
    <path d="M5 12h14M13 6l6 6-6 6" />
  </svg>
);

export const ArrowUpIcon = (p: P) => (
  <svg {...base(p)}>
    <path d="M12 20V5M6 11l6-6 6 6" />
  </svg>
);

export const ReplayIcon = (p: P) => (
  <svg {...base(p)}>
    <path d="M4 12a8 8 0 1 0 2.4-5.7M4 4v4.5h4.5" />
  </svg>
);

export const LockIcon = (p: P) => (
  <svg {...base(p)}>
    <rect x="5" y="10.5" width="14" height="10" rx="2" />
    <path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" />
  </svg>
);

export const DeskIcon = (p: P) => (
  <svg {...base(p)}>
    <rect x="3" y="5" width="18" height="11" rx="1.5" />
    <path d="M8 20h8M12 16v4" />
  </svg>
);

/** The mark: one path that forks and meets again at the answer. */
export const ForkMark = ({ size = 28, ...rest }: P) => (
  <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden {...rest}>
    <circle cx="5" cy="16" r="2.6" fill="currentColor" />
    <path d="M7.5 16H12c2.5 0 3.5-7 7-7h2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    <path d="M12 16c2.5 0 3.5 7 7 7h2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeDasharray="2.2 2.6" />
    <path d="M21 9c3 0 3.4 7 5 7M21 23c3 0 3.4-7 5-7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    <circle cx="27" cy="16" r="3" fill="var(--stamp)" />
  </svg>
);
