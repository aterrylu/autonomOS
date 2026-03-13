import claudeSvg from "@vscode/codicons/src/icons/claude.svg?raw";
import pinSvg from "@vscode/codicons/src/icons/pin.svg?raw";
import pinnedSvg from "@vscode/codicons/src/icons/pinned.svg?raw";

function extractPaths(raw: string): string[] {
  return [...raw.matchAll(/\bd="([^"]+)"/g)].map((m) => m[1]);
}

const ICONS = {
  claude: extractPaths(claudeSvg),
  pin: extractPaths(pinSvg),
  pinned: extractPaths(pinnedSvg),
} as const;

export type CodiconName = keyof typeof ICONS;

export function Codicon({
  name,
  size = 14,
}: {
  name: CodiconName;
  size?: number;
}) {
  const paths = ICONS[name];
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="currentColor"
      className="inline-block shrink-0"
      role="img"
      aria-hidden="true"
    >
      {paths.map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}
