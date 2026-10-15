import type { ReactNode } from "react";
import { SidebarShell } from "./SidebarShell";
import { FlyoutAppearanceProvider } from "./ui/flyout";

/** Staged page layout: shared sidebar shell, fixed header and scrolling content. */
export function DesignPageShell({ sidebar, title, children }: { sidebar: ReactNode; title: string; children: ReactNode }) {
  return (
    <FlyoutAppearanceProvider><div className="task-row-design-preview design-page-shell" data-testid="design-page-shell">
      <a href="#design-page-content" className="design-page-skip-link">Skip to tasks</a>
      <SidebarShell open resizable storageKey="paperclip.design-proposal.sidebar-width">{sidebar}</SidebarShell>
      <div className="design-page-main">
        <header className="design-page-header"><h1>{title}</h1></header>
        <main id="design-page-content" className="design-page-content" tabIndex={-1}>{children}</main>
      </div>
    </div></FlyoutAppearanceProvider>
  );
}
