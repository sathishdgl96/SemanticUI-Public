import { useQuery } from "@tanstack/react-query";
import { getProvenance } from "../api/provenance";
import AboutPage from "./AboutPage";

/**
 * The About tab's data. Split from `AboutPage` so the page itself stays
 * presentational and can be tested against every state without a server.
 */
export default function AboutPanel({ reportId }: { reportId: string }) {
  const provenance = useQuery({
    queryKey: ["provenance", reportId],
    queryFn: () => getProvenance(reportId),
    // Freshness is the point of the page, so a cached answer from ten
    // minutes ago would be the one thing it must not show.
    staleTime: 0,
    retry: false,
  });

  if (provenance.isLoading) {
    return <p className="about-page tile-hint">Reading this report's sources…</p>;
  }
  if (provenance.isError || !provenance.data) {
    return (
      <p className="about-page" role="alert">
        Could not read this report's provenance.
      </p>
    );
  }
  return <AboutPage data={provenance.data} />;
}
