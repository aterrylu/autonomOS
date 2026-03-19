import {
  Group as PanelGroup,
  Panel,
  Separator as PanelResizeHandle,
} from "react-resizable-panels";
import { THEMES, useStore } from "../store";
import type { LayoutBranch, LayoutLeaf, LayoutNode } from "./layoutTree";
import { PaneSlot } from "./PaneSlot";

interface SplitLayoutProps {
  node: LayoutNode;
}

/**
 * SplitLayout — recursively renders the binary layout tree.
 *
 * Branch → PanelGroup + Panel + PanelResizeHandle + Panel
 * Leaf   → PaneSlot (drop zones, focus ring, close button)
 *
 * No terminal DOM lives here — SessionMountLayer handles that via
 * absolute positioning into the slot rects registered by PaneSlot.
 */
export function SplitLayout({ node }: SplitLayoutProps) {
  if (node.kind === "leaf") {
    return <LeafNode leaf={node} />;
  }
  return <BranchNode branch={node} />;
}

function LeafNode({ leaf }: { leaf: LayoutLeaf }) {
  const focusedLeafId = useStore((s) => s.focusedLeafId);
  return (
    <PaneSlot leafId={leaf.id} focused={leaf.id === focusedLeafId} />
  );
}

function BranchNode({ branch }: { branch: LayoutBranch }) {
  const theme = useStore((s) => s.theme);
  const page = THEMES[theme].page;
  const setLeafSizes = useStore((s) => s.setLeafSizes);

  // react-resizable-panels v4:
  //   orientation="horizontal" → side-by-side columns
  //   orientation="vertical"   → top/bottom rows
  // Our LayoutBranch.direction maps 1:1.
  const orientation = branch.direction;

  return (
    <PanelGroup
      orientation={orientation}
      onLayoutChange={(sizes) => {
        setLeafSizes(branch.id, [sizes[0], sizes[1]] as [number, number]);
      }}
      style={{ height: "100%", width: "100%" }}
    >
      <Panel defaultSize={branch.sizes[0]} minSize={10}>
        <SplitLayout node={branch.first} />
      </Panel>
      <PanelResizeHandle
        style={{
          width: direction === "horizontal" ? "4px" : "100%",
          height: direction === "vertical" ? "4px" : "100%",
          background: page.border,
          cursor: direction === "horizontal" ? "col-resize" : "row-resize",
          flexShrink: 0,
        }}
      />
      <Panel defaultSize={branch.sizes[1]} minSize={10}>
        <SplitLayout node={branch.second} />
      </Panel>
    </PanelGroup>
  );
}
