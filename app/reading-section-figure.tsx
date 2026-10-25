import type { PaperBundle } from "../shared/types.ts";
import type { ReadingFigure } from "../shared/reading-figures.ts";
import { ResearchImage } from "./research-image.tsx";
import { useCropImage } from "./research-slide.tsx";

export function ReadingSectionFigure({
  figure,
  paper,
  onCitation,
}: {
  figure: ReadingFigure;
  paper: PaperBundle;
  onCitation: (id: string) => void;
}) {
  const { source, panel } = figure;
  const original =
    source.displayImage ??
    source.image ??
    `/api/papers/${encodeURIComponent(paper.id)}/sources/${encodeURIComponent(source.id)}/image`;
  const image = useCropImage(original, panel?.region);
  const title =
    source.title + (panel ? " · " + panel.label.toUpperCase() + " 选区" : "");
  if (!image || image.failed)
    return (
      <button onClick={() => onCitation(source.id)}>查看 {source.title}</button>
    );
  return (
    <figure
      className="rw-answer-figure reading-section-figure"
      data-source-id={source.id}
      data-panel-id={panel ? source.id + ":" + panel.label : undefined}
    >
      <ResearchImage
        url={image.url}
        title={title}
        caption={source.caption ?? source.text}
        thumbnail
        onPage={() => onCitation(source.id)}
      />
      <figcaption>
        {title}
        {source.page ? " · PDF 第 " + source.page + " 页" : ""} · 点击放大
        {panel && (
          <>
            {" "}
            ·{" "}
            <ResearchImage
              url={original}
              title="完整原图与图注"
              caption={source.caption ?? source.text}
              onPage={() => onCitation(source.id)}
            />
          </>
        )}
      </figcaption>
    </figure>
  );
}
