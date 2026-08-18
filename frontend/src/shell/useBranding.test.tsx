import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useBranding } from "./useBranding";

function Probe() {
  const branding = useBranding();
  return <span>{branding.name}</span>;
}

function wrap() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <Probe />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useBranding", () => {
  it("serves the configured name, retitles the tab, and swaps the favicon", async () => {
    document.head.innerHTML = '<link rel="icon" type="image/svg+xml" href="/favicon.svg" />';
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ name: "AcmeBI", logoUrl: "/api/branding/logo" }),
      }),
    );
    wrap();
    expect(await screen.findByText("AcmeBI")).toBeInTheDocument();
    await waitFor(() => expect(document.title).toBe("AcmeBI"));
    const icon = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    expect(icon?.getAttribute("href")).toBe("/api/branding/logo");
  });

  it("falls back to the built-in name when the endpoint is unreachable", async () => {
    document.head.innerHTML = '<link rel="icon" href="/favicon.svg" />';
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("down")));
    wrap();
    expect(await screen.findByText("SemanticUI")).toBeInTheDocument();
    // No logo: the default favicon stays.
    expect(document.querySelector('link[rel="icon"]')?.getAttribute("href")).toBe(
      "/favicon.svg",
    );
  });
});
