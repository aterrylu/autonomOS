// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { useUndoableTextValue } from "./useUndoableTextValue";

/** Drive the hook through a real useState so value/setValue stay in sync. */
function useHarness(initial: string) {
  const [value, setValue] = useState(initial);
  const handlers = useUndoableTextValue(value, setValue);
  return { value, handlers };
}

function change(value: string) {
  return {
    target: { value },
  } as unknown as React.ChangeEvent<HTMLTextAreaElement>;
}

function key(opts: { shift?: boolean } = {}) {
  let prevented = false;
  return {
    key: "z",
    metaKey: true,
    ctrlKey: false,
    shiftKey: opts.shift ?? false,
    preventDefault: () => {
      prevented = true;
    },
    get prevented() {
      return prevented;
    },
  } as unknown as React.KeyboardEvent<HTMLTextAreaElement> & {
    prevented: boolean;
  };
}

describe("useUndoableTextValue", () => {
  it("restores text after an accidental clear via Cmd+Z", () => {
    const { result } = renderHook(() => useHarness("hello world"));

    // User selects all and deletes — one onChange to empty string.
    act(() => result.current.handlers.onChange(change("")));
    expect(result.current.value).toBe("");

    // Cmd+Z restores the cleared text.
    act(() => result.current.handlers.onKeyDown(key()));
    expect(result.current.value).toBe("hello world");
  });

  it("supports redo with Cmd+Shift+Z", () => {
    const { result } = renderHook(() => useHarness("draft"));

    act(() => result.current.handlers.onChange(change("")));
    act(() => result.current.handlers.onKeyDown(key())); // undo
    expect(result.current.value).toBe("draft");

    act(() => result.current.handlers.onKeyDown(key({ shift: true }))); // redo
    expect(result.current.value).toBe("");
  });

  it("is a no-op when there is nothing to undo", () => {
    const { result } = renderHook(() => useHarness("start"));
    act(() => result.current.handlers.onKeyDown(key()));
    expect(result.current.value).toBe("start");
  });
});
