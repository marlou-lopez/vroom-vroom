/** The imagery credit its licence asks for, shown while its edges (vroom-ueg.8) or the picture itself (vroom-ueg.9) are drawn. */
export function AerialCredit({ aerial, className, what = "Edges and kerbs" }: { aerial: { attribution: string; licence_url: string | null }; className: string; what?: string }) {
  return (
    <div className={className} data-controls="">
      {what} (experimental): {aerial.attribution}
      {aerial.licence_url && <>{" "}<a href={aerial.licence_url} target="_blank" rel="noreferrer">Licence</a></>}
    </div>
  );
}
