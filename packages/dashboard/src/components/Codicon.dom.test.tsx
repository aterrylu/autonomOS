// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import "../test/setup-dom";
import { Codicon } from "./Codicon";

/**
 * Codicon — renders a VS Code codicon as an inline <svg> built from the
 * `d="..."` path data extracted out of the raw SVG at module-load. These tests
 * assert the rendered DOM shape and prop wiring, not the exact path strings
 * (which are upstream-owned and would make the test brittle).
 */
describe("Codicon", () => {
  it("renders an svg with at least one path for a known icon", () => {
    const { container } = render(<Codicon name="bell" />);
    const svg = container.querySelector("svg");
    expect(svg).not.toBeNull();
    // Every codicon we ship has at least one path extracted from its source.
    expect(svg?.querySelectorAll("path").length).toBeGreaterThan(0);
  });

  it("applies the size prop to width and height", () => {
    const { container } = render(<Codicon name="gear" size={28} />);
    const svg = container.querySelector("svg");
    expect(svg).toHaveAttribute("width", "28");
    expect(svg).toHaveAttribute("height", "28");
  });

  it("defaults to size 14 when no size is given", () => {
    const { container } = render(<Codicon name="check" />);
    const svg = container.querySelector("svg");
    expect(svg).toHaveAttribute("width", "14");
    expect(svg).toHaveAttribute("height", "14");
  });

  it("renders distinct path geometry for different icons", () => {
    const bell = render(<Codicon name="bell" />);
    const bellPaths = [...bell.container.querySelectorAll("path")].map((p) =>
      p.getAttribute("d"),
    );
    bell.unmount();

    const trash = render(<Codicon name="trash" />);
    const trashPaths = [...trash.container.querySelectorAll("path")].map((p) =>
      p.getAttribute("d"),
    );

    // Two different codicons should not produce identical path data.
    expect(trashPaths).not.toEqual(bellPaths);
  });

  it("forwards inline style overrides to the svg", () => {
    const { container } = render(
      <Codicon name="close" style={{ opacity: 0.5 }} />,
    );
    const svg = container.querySelector("svg");
    expect(svg).toHaveStyle({ opacity: "0.5" });
  });
});
