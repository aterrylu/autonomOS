// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import "../test/setup-dom";
import { CopyToast } from "./CopyToast";

describe("CopyToast", () => {
  it("renders nothing when there is no toast", () => {
    const { container } = render(<CopyToast toast={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows the copied character count on success", () => {
    render(<CopyToast toast={{ id: 1, chars: 218, ok: true }} />);
    expect(screen.getByRole("status")).toHaveTextContent("Copied 218 chars");
  });

  it("uses the singular 'char' for a single character", () => {
    render(<CopyToast toast={{ id: 2, chars: 1, ok: true }} />);
    expect(screen.getByRole("status")).toHaveTextContent("Copied 1 char");
  });

  it("shows a failure message when ok is false", () => {
    render(<CopyToast toast={{ id: 3, chars: 99, ok: false }} />);
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("Copy failed");
    expect(status).not.toHaveTextContent("99");
  });
});
