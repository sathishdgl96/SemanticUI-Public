import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("../api/reports", () => ({ exportReport: vi.fn() }));
import { exportReport } from "../api/reports";
import ExportPanel from "./ExportPanel";

const exportMock = vi.mocked(exportReport);

describe("ExportPanel", () => {
  it("shows the document verbatim in a selectable, read-only box", async () => {
    exportMock.mockResolvedValue('{\n  "schemaVersion": 1\n}\n');
    render(<ExportPanel reportId="r1" onClose={() => {}} />);
    const box = await screen.findByLabelText(/report definition/i);
    await waitFor(() => expect(box).toHaveValue('{\n  "schemaVersion": 1\n}\n'));
    expect(box).toHaveAttribute("readonly");
  });

  it("surfaces a failure rather than showing an empty box", async () => {
    exportMock.mockRejectedValue(new Error("nope"));
    render(<ExportPanel reportId="r1" onClose={() => {}} />);
    expect(await screen.findByRole("alert")).toBeInTheDocument();
  });
});
