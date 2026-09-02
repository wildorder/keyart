/**
 * `react-markdown` wrapper with safe defaults: raw HTML is NOT rendered (no
 * `rehype-raw`), so markdown text renders as formatted content without an
 * injection surface. Output is scoped by the `.markdown` container class.
 */
import React from "react";
import ReactMarkdown from "react-markdown";

export function Markdown({
  children,
  className,
}: {
  children: string | null | undefined;
  className?: string;
}) {
  const text = children ?? "";
  return (
    <div className={className ? `markdown ${className}` : "markdown"}>
      <ReactMarkdown
        // Links open safely in a new tab; everything else uses react-markdown's
        // default safe element set (raw HTML is dropped).
        components={{
          a: ({ children: linkChildren, href }) => (
            <a href={href} target="_blank" rel="noreferrer noopener">
              {linkChildren}
            </a>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
