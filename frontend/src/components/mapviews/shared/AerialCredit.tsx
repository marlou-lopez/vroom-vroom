import type { AerialEdges } from "../../../api/types";

/** The imagery credit its licence asks for, shown while its edges are drawn (vroom-ueg.8). */
export function AerialCredit({ aerial, className }: { aerial: AerialEdges; className: string }) {
  return (
    <div className={className} data-controls="">
      Edges and kerbs (experimental): {aerial.attribution}
      {aerial.licence_url && <>{" "}<a href={aerial.licence_url} target="_blank" rel="noreferrer">Licence</a></>}
    </div>
  );
}
