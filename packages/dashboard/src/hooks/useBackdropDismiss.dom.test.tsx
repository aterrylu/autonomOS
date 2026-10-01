// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import "../test/setup-dom";
import { useBackdropDismiss } from "./useBackdropDismiss";

/**
 * useBackdropDismiss — dismiss only when BOTH the press and the release land
 * on the backdrop (#392: a text selection released over the backdrop closed
 * the update dialog). The browser dispatches the trailing `click` to the
 * nearest common ancestor of mousedown and mouseup, so every gesture below
 * ends with a click ON THE BACKDROP, exactly as a browser would send it.
 */
function Harness({ onDismiss }: { onDismiss: () => void }) {
  const backdrop = useBackdropDismiss(onDismiss);
  return (
    <div data-testid="backdrop" {...backdrop}>
      <div data-testid="dialog">release notes to copy</div>
    </div>
  );
}

function setup() {
  const onDismiss = vi.fn();
  render(<Harness onDismiss={onDismiss} />);
  return {
    onDismiss,
    backdrop: screen.getByTestId("backdrop"),
    dialog: screen.getByTestId("dialog"),
  };
}

describe("useBackdropDismiss", () => {
  it("press + release on the backdrop dismisses", () => {
    const { onDismiss, backdrop } = setup();
    fireEvent.mouseDown(backdrop);
    fireEvent.mouseUp(backdrop);
    fireEvent.click(backdrop);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("a selection dragged out of the dialog and released on the backdrop does NOT", () => {
    const { onDismiss, backdrop, dialog } = setup();
    fireEvent.mouseDown(dialog);
    fireEvent.mouseUp(backdrop);
    fireEvent.click(backdrop);
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("pressed on the backdrop, released inside, does NOT", () => {
    const { onDismiss, backdrop, dialog } = setup();
    fireEvent.mouseDown(backdrop);
    fireEvent.mouseUp(dialog);
    fireEvent.click(backdrop);
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("a click inside the dialog does NOT", () => {
    const { onDismiss, dialog } = setup();
    fireEvent.mouseDown(dialog);
    fireEvent.mouseUp(dialog);
    fireEvent.click(dialog);
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("an aborted drag doesn't arm the NEXT click: state resets after every click", () => {
    const { onDismiss, backdrop, dialog } = setup();
    // Full backdrop press/release, but the click lands inside (no dismiss)…
    fireEvent.mouseDown(backdrop);
    fireEvent.mouseUp(backdrop);
    fireEvent.click(dialog);
    // …then a bare click with no fresh press must not ride the stale state.
    fireEvent.click(backdrop);
    expect(onDismiss).not.toHaveBeenCalled();
  });
});
