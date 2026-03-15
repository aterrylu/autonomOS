import claudeSvg from "@vscode/codicons/src/icons/claude.svg?raw";
import closeSvg from "@vscode/codicons/src/icons/close.svg?raw";
import copySvg from "@vscode/codicons/src/icons/copy.svg?raw";
import gearSvg from "@vscode/codicons/src/icons/gear.svg?raw";
import linkExternalSvg from "@vscode/codicons/src/icons/link-external.svg?raw";
import markdownSvg from "@vscode/codicons/src/icons/markdown.svg?raw";

function extractPaths(raw: string): string[] {
  return [...raw.matchAll(/\bd="([^"]+)"/g)].map((m) => m[1]);
}

const ICONS = {
  claude: extractPaths(claudeSvg),
  close: extractPaths(closeSvg),
  copy: extractPaths(copySvg),
  gear: extractPaths(gearSvg),
  "link-external": extractPaths(linkExternalSvg),
  markdown: extractPaths(markdownSvg),
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
