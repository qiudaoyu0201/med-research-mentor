import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

export function ResearchMarkdown({ text }: { text: string }) {
  return (
    <div className="rw-markdown">
      <Markdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        components={{
          // Remote model-supplied images cannot leak reading context or displace paper figures.
          img: ({ alt }) => <span>{alt}</span>,
          a: ({ href, children }) =>
            href && /^https?:\/\//i.test(href) ? (
              <a href={href} target="_blank" rel="noreferrer">
                {children}
              </a>
            ) : (
              <span>{children}</span>
            ),
          table: ({ children }) => (
            <div className="rw-table-scroll">
              <table>{children}</table>
            </div>
          ),
        }}
      >
        {text}
      </Markdown>
    </div>
  );
}
