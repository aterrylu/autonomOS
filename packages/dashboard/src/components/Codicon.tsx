import bellSvg from "@vscode/codicons/src/icons/bell.svg?raw";
import bellDotSvg from "@vscode/codicons/src/icons/bell-dot.svg?raw";
import checkSvg from "@vscode/codicons/src/icons/check.svg?raw";
import chevronDownSvg from "@vscode/codicons/src/icons/chevron-down.svg?raw";
import chevronRightSvg from "@vscode/codicons/src/icons/chevron-right.svg?raw";
import circleLargeSvg from "@vscode/codicons/src/icons/circle-large.svg?raw";
import claudeSvg from "@vscode/codicons/src/icons/claude.svg?raw";
import closeSvg from "@vscode/codicons/src/icons/close.svg?raw";
import commentDiscussionSvg from "@vscode/codicons/src/icons/comment-discussion.svg?raw";
import debugStartSvg from "@vscode/codicons/src/icons/debug-start.svg?raw";
import eyeSvg from "@vscode/codicons/src/icons/eye.svg?raw";
import eyeClosedSvg from "@vscode/codicons/src/icons/eye-closed.svg?raw";
import gearSvg from "@vscode/codicons/src/icons/gear.svg?raw";
import linkExternalSvg from "@vscode/codicons/src/icons/link-external.svg?raw";
import listFlatSvg from "@vscode/codicons/src/icons/list-flat.svg?raw";
import listTreeSvg from "@vscode/codicons/src/icons/list-tree.svg?raw";
import lockSvg from "@vscode/codicons/src/icons/lock.svg?raw";
import pinSvg from "@vscode/codicons/src/icons/pin.svg?raw";
import pinnedSvg from "@vscode/codicons/src/icons/pinned.svg?raw";
import radioTowerSvg from "@vscode/codicons/src/icons/radio-tower.svg?raw";
import sendSvg from "@vscode/codicons/src/icons/send.svg?raw";
import trashSvg from "@vscode/codicons/src/icons/trash.svg?raw";
import typeHierarchySvg from "@vscode/codicons/src/icons/type-hierarchy.svg?raw";
import warningSvg from "@vscode/codicons/src/icons/warning.svg?raw";

function extractPaths(raw: string): string[] {
  return [...raw.matchAll(/\bd="([^"]+)"/g)].map((m) => m[1]);
}

const ICONS = {
  bell: extractPaths(bellSvg),
  "bell-dot": extractPaths(bellDotSvg),
  check: extractPaths(checkSvg),
  "chevron-down": extractPaths(chevronDownSvg),
  "chevron-right": extractPaths(chevronRightSvg),
  "circle-large": extractPaths(circleLargeSvg),
  claude: extractPaths(claudeSvg),
  close: extractPaths(closeSvg),
  "comment-discussion": extractPaths(commentDiscussionSvg),
  "debug-start": extractPaths(debugStartSvg),
  eye: extractPaths(eyeSvg),
  "eye-closed": extractPaths(eyeClosedSvg),
  gear: extractPaths(gearSvg),
  "link-external": extractPaths(linkExternalSvg),
  "list-flat": extractPaths(listFlatSvg),
  "list-tree": extractPaths(listTreeSvg),
  lock: extractPaths(lockSvg),
  pin: extractPaths(pinSvg),
  pinned: extractPaths(pinnedSvg),
  "radio-tower": extractPaths(radioTowerSvg),
  send: extractPaths(sendSvg),
  trash: extractPaths(trashSvg),
  "type-hierarchy": extractPaths(typeHierarchySvg),
  warning: extractPaths(warningSvg),
} as const;

export type CodiconName = keyof typeof ICONS;

export function Codicon({
  name,
  size = 14,
  style,
}: {
  name: CodiconName;
  size?: number;
  style?: React.CSSProperties;
}) {
  const paths = ICONS[name];
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="currentColor"
      className="inline-block shrink-0"
      style={style}
      role="img"
      aria-hidden="true"
    >
      {paths.map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}
