import { createContext, useContext, type ReactNode } from "react";
import { CellMarquee } from "./CellMarquee";

const MarqueeContext = createContext(false);

/** Opt-in overflow treatment; existing production layouts keep their current labels. */
export function TruncatedTextMarqueeProvider({ children }: { children: ReactNode }) {
  return <MarqueeContext.Provider value>{children}</MarqueeContext.Provider>;
}

export function TruncatedText({ children, className, title, as: Tag = "span" }: {
  children: ReactNode;
  className?: string;
  title?: string;
  as?: "span" | "h2" | "p";
}) {
  const marquee = useContext(MarqueeContext);
  return <Tag className={className} title={marquee ? undefined : title}>{marquee
    ? <CellMarquee cell="truncated-label" interactWithParent tabbable={false}>{children}</CellMarquee>
    : children}</Tag>;
}
