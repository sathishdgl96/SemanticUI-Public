import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";

export interface Branding {
  name: string;
  logoUrl: string | null;
}

const FALLBACK: Branding = { name: "SemanticUI", logoUrl: null };

/** The deployment's name and logo, from SEMANTICUI_APP_NAME /
 *  SEMANTICUI_APP_LOGO_URL on the server. Falls back to the product's own
 *  name when the endpoint is unreachable, so the shell never renders
 *  nameless -- and the browser tab follows whatever the answer is. */
export function useBranding(): Branding {
  const query = useQuery({
    queryKey: ["branding"],
    // Raw fetch, not apiFetch: the endpoint is public and pre-auth, and
    // branding must never entangle itself with the session machinery --
    // or with anything a test taught apiFetch to answer.
    queryFn: async (): Promise<Branding> => {
      const response = await fetch("/api/branding");
      if (!response.ok) throw new Error(`branding: ${response.status}`);
      return response.json();
    },
    staleTime: Infinity,
    retry: false,
  });
  // `?.name` and not a bare null-check: an answer without a name (a proxy
  // error page, a mock) must not render a nameless shell.
  const branding = query.data?.name ? query.data : FALLBACK;

  useEffect(() => {
    document.title = branding.name;
  }, [branding.name]);

  useEffect(() => {
    // The tab icon follows the logo. Only when one is configured -- the
    // default favicon.svg stays for an unbranded deployment.
    if (!branding.logoUrl) return;
    const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (link) {
      link.href = branding.logoUrl;
      link.removeAttribute("type");
    }
  }, [branding.logoUrl]);

  return branding;
}
