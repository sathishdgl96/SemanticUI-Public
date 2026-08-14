import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "../api/client";
import type { Me } from "../api/types";

export function useMe() {
  return useQuery({
    queryKey: ["me"],
    queryFn: () => apiFetch<Me>("/api/me"),
    retry: false,
  });
}
