"use client";

import { Fragment } from "react";
import { TurnRefText } from "@/components/turn-ref-text";
import { cn } from "@/lib/utils";

export interface MarkdownProps {
  text: string;
  /** Called with a clean-turn id (e.g. "T14") when an inline [Tn] anchor is clicked. */
  onNavigate?: (turnId: string) => void;
  /** When provided, [Tn] refs not in the set render as plain text. */
  knownIds?: ReadonlySet<string>;
  className?: string;
}

// Emphasis kept deliberately narrow (**bold**, _italic_, `code`) so a lone `*`
// in prose or a bullet marker is never mistaken for emphasis. Inline plain text
// and emphasis contents still flow through TurnRefText for [Tn] anchors.
const INLINE_RE = /\*\*([^*]+?)\*\*|`([^`]+?)`|_([^_]+?)_/g;

function Inline({ text, onNavigate, knownIds }: Omit<MarkdownProps, "className">) {
  const anchored = (s: string, key: number) =>
    s ? (
      <TurnRefText key={key} text={s} onNavigate={onNavigate} knownIds={knownIds} />
    ) : null;

  const nodes: React.ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  INLINE_RE.lastIndex = 0;
  while ((m = INLINE_RE.exec(text)) !== null) {
    if (m.index > last) nodes.push(anchored(text.slice(last, m.index), last));
    if (m[1] != null) {
      nodes.push(
        <strong key={m.index}>
          <TurnRefText text={m[1]} onNavigate={onNavigate} knownIds={knownIds} />
        </strong>,
      );
    } else if (m[2] != null) {
      nodes.push(
        <code
          key={m.index}
          className="rounded bg-background px-1 py-0.5 font-mono text-[0.85em]"
        >
          {m[2]}
        </code>,
      );
    } else if (m[3] != null) {
      nodes.push(
        <em key={m.index}>
          <TurnRefText text={m[3]} onNavigate={onNavigate} knownIds={knownIds} />
        </em>,
      );
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) nodes.push(anchored(text.slice(last), last));
  return (
    <>
      {nodes.map((n, i) => (
        <Fragment key={i}>{n}</Fragment>
      ))}
    </>
  );
}

type Block =
  | { kind: "heading"; text: string }
  | { kind: "ul"; items: string[] }
  | { kind: "ol"; items: string[] }
  | { kind: "para"; text: string };

function parseBlocks(md: string): Block[] {
  const blocks: Block[] = [];
  let para: string[] = [];
  let list: { kind: "ul" | "ol"; items: string[] } | null = null;

  const flushPara = () => {
    if (para.length) blocks.push({ kind: "para", text: para.join("\n") });
    para = [];
  };
  const flushList = () => {
    if (list) blocks.push(list);
    list = null;
  };

  for (const line of md.split("\n")) {
    const t = line.trim();
    if (!t) {
      flushPara();
      flushList();
      continue;
    }
    const heading = /^#{1,6}\s+(.*)$/.exec(t);
    if (heading) {
      flushPara();
      flushList();
      blocks.push({ kind: "heading", text: heading[1]! });
      continue;
    }
    const bullet = /^[-*]\s+(.*)$/.exec(t);
    if (bullet) {
      flushPara();
      if (list?.kind !== "ul") flushList(), (list = { kind: "ul", items: [] });
      list.items.push(bullet[1]!);
      continue;
    }
    const ordered = /^\d+[.)]\s+(.*)$/.exec(t);
    if (ordered) {
      flushPara();
      if (list?.kind !== "ol") flushList(), (list = { kind: "ol", items: [] });
      list.items.push(ordered[1]!);
      continue;
    }
    flushList();
    para.push(t);
  }
  flushPara();
  flushList();
  return blocks;
}

/**
 * Renders lightweight Markdown (headings, bullet/numbered lists, paragraphs, and
 * inline **bold** / _italic_ / `code`) with inline [Tn] citation anchors. Used by
 * the Q&A answers and anywhere the pipeline emits Markdown prose.
 */
export function Markdown({ text, onNavigate, knownIds, className }: MarkdownProps) {
  const blocks = parseBlocks(text);
  return (
    <div className={cn("flex flex-col gap-2", className)}>
      {blocks.map((block, i) => {
        if (block.kind === "heading") {
          return (
            <p key={i} className="font-semibold">
              <Inline text={block.text} onNavigate={onNavigate} knownIds={knownIds} />
            </p>
          );
        }
        if (block.kind === "ul" || block.kind === "ol") {
          const List = block.kind === "ul" ? "ul" : "ol";
          return (
            <List
              key={i}
              className={cn(
                "flex flex-col gap-1 pl-5",
                block.kind === "ul" ? "list-disc" : "list-decimal",
              )}
            >
              {block.items.map((item, j) => (
                <li key={j}>
                  <Inline text={item} onNavigate={onNavigate} knownIds={knownIds} />
                </li>
              ))}
            </List>
          );
        }
        return (
          <p key={i} className="whitespace-pre-wrap">
            <Inline text={block.text} onNavigate={onNavigate} knownIds={knownIds} />
          </p>
        );
      })}
    </div>
  );
}
