import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Certification } from "../api/provenance";
import CertifyPanel from "./CertifyPanel";

const getMock = vi.hoisted(() => vi.fn());
const putMock = vi.hoisted(() => vi.fn());

vi.mock("../api/provenance", () => ({
  getCertification: getMock,
  putCertification: putMock,
}));

const VIEW = { database: "SALES", schema: "PUBLIC", name: "REVENUE" };

function record(over: Partial<Certification> = {}): Certification {
  return {
    certified: false,
    owner: { name: null, contact: null },
    certifiedBy: null,
    note: null,
    canCertify: true,
    ...over,
  };
}

function show() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <CertifyPanel view={VIEW} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  getMock.mockReset();
  putMock.mockReset();
  putMock.mockResolvedValue(record({ certified: true }));
});

describe("CertifyPanel", () => {
  it("offers the control to whoever holds the owning role", async () => {
    getMock.mockResolvedValue(record({ canCertify: true }));
    show();

    expect(
      await screen.findByRole("button", { name: /certify this model/i }),
    ).toBeInTheDocument();
  });

  it("explains the absence rather than just hiding the button", async () => {
    // A control that silently is not there reads as a missing feature. Saying
    // who may act is the same courtesy the rest of the app extends to a
    // Snowflake refusal.
    getMock.mockResolvedValue(record({ canCertify: false }));
    show();

    expect(
      await screen.findByText(/role that owns this model/i),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /certify this model/i }),
    ).not.toBeInTheDocument();
  });

  it("sends the owner and note along with the certification", async () => {
    getMock.mockResolvedValue(record({ canCertify: true }));
    show();

    await userEvent.click(
      await screen.findByRole("button", { name: /certify this model/i }),
    );
    await userEvent.type(screen.getByLabelText(/owner/i), "Revenue team");
    await userEvent.type(screen.getByLabelText(/contact/i), "rev@example.com");
    await userEvent.type(screen.getByLabelText(/note/i), "quarter close");
    await userEvent.click(screen.getByRole("button", { name: /^certify$/i }));

    await waitFor(() =>
      expect(putMock).toHaveBeenCalledWith(VIEW, {
        certified: true,
        ownerName: "Revenue team",
        ownerContact: "rev@example.com",
        note: "quarter close",
      }),
    );
  });

  it("opens the form already holding what is on record", async () => {
    // Re-certifying should not mean retyping what was already true.
    getMock.mockResolvedValue(
      record({
        certified: true,
        owner: { name: "Revenue team", contact: "rev@example.com" },
        note: "quarter close",
        certifiedBy: { role: "DATA_ENG", at: "2026-08-20T09:00:00Z" },
      }),
    );
    show();

    await userEvent.click(
      await screen.findByRole("button", { name: /edit certification/i }),
    );

    expect(screen.getByLabelText(/owner/i)).toHaveValue("Revenue team");
    expect(screen.getByLabelText(/note/i)).toHaveValue("quarter close");
  });

  it("offers withdrawal only once something has been certified", async () => {
    getMock.mockResolvedValue(record({ certified: true }));
    show();

    expect(
      await screen.findByRole("button", { name: /withdraw/i }),
    ).toBeInTheDocument();
  });

  it("surfaces a refusal instead of appearing to have saved", async () => {
    getMock.mockResolvedValue(record({ canCertify: true }));
    putMock.mockRejectedValue(new Error("Certifying this model needs the owning role."));
    show();

    await userEvent.click(
      await screen.findByRole("button", { name: /certify this model/i }),
    );
    await userEvent.click(screen.getByRole("button", { name: /^certify$/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/owning role/i);
  });
});
