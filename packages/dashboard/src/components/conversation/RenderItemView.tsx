import type { RenderItem } from "@autonomos/core";

interface RenderItemViewProps {
  item: RenderItem;
}

/**
 * Simple text renderer for RenderItems.
 * Renders markdown-ish content as plain text for now.
 * This is the component to upgrade with proper markdown rendering later.
 */
export function RenderItemView({ item }: RenderItemViewProps) {
  switch (item.type) {
    case "text":
      return <span className="whitespace-pre-wrap">{item.content}</span>;
    case "user_prompt":
      return <span className="whitespace-pre-wrap">{item.content}</span>;
    case "system":
      return (
        <span className="text-xs italic opacity-50">[{item.subtype}]</span>
      );
    default:
      return null;
  }
}
