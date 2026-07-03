/** Small inline SVG icons (stroke/fill use currentColor). 16px viewBox. */

type IconProps = { size?: number; className?: string };

function svg(path: React.ReactNode, vb = 16) {
  return ({ size = 14, className }: IconProps) => (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${vb} ${vb}`}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      {path}
    </svg>
  );
}

export const CommentIcon = svg(
  <path d="M2.5 4.5a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2H6l-3 2.5V11.5a2 2 0 0 1-.5-1.3z" />,
);

export const SwapIcon = svg(
  <>
    <path d="M5 2.5 2.5 5 5 7.5" />
    <path d="M2.5 5h9" />
    <path d="m11 13.5 2.5-2.5L11 8.5" />
    <path d="M13.5 11h-9" />
  </>,
);

export const ResetIcon = svg(
  <>
    <path d="M3 8a5 5 0 1 1 1.6 3.7" />
    <path d="M3 11.5V8h3.5" />
  </>,
);

export const CloseIcon = svg(
  <>
    <path d="M4 4l8 8" />
    <path d="M12 4l-8 8" />
  </>,
);
