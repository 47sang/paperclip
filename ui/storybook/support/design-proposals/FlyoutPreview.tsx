import { useState, type CSSProperties } from "react";
import { BookOpen, Check, Settings, Sun, UserPlus } from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Flyout, FlyoutAppearanceProvider, FlyoutContent, FlyoutHeader, FlyoutOptions, FlyoutTrigger } from "@/components/ui/flyout";
import { allTaskListColumns, defaultTaskListColumns, taskListColumns, type TaskListColumnId } from "@/lib/task-list";

export type FlyoutPreviewProps = { mode: "columns" | "views" | "profile"; shadow?: string };

/** Isolated reference for the same composition used by the page's flyouts.
 * Shadow overrides stay local to this preview; the saved default is a token. */
export function FlyoutPreview({ mode, shadow }: FlyoutPreviewProps) {
  const [columns, setColumns] = useState<readonly TaskListColumnId[]>(defaultTaskListColumns);
  const [view, setView] = useState("All tasks");
  const [lastAction, setLastAction] = useState("");
  const title = mode === "profile" ? "Account" : mode === "views" ? "Views" : "Columns";
  const profileActions = [{ label: "Settings", icon: Settings }, { label: "Invite", icon: UserPlus }, { label: "Documentation", icon: BookOpen }, { label: "Switch to light mode", icon: Sun }];
  return (
    <main className="task-row-design-preview min-h-screen p-12 text-foreground" data-testid="flyout-design-preview">
      <div className="mx-auto flex max-w-3xl flex-col gap-4">
        <h1 className="text-2xl font-semibold">Flyout</h1>
        <p className="text-sm text-muted-foreground">Shared title block, options, selection marks and shadow. Hover or focus an option to inspect its highlight.</p>
        <p className="text-sm text-muted-foreground">The Shadow control previews a CSS box-shadow. Clear it to inherit the shared --shadow-flyout token.</p>
        <div className="mt-6 flex justify-center">
          {mode === "views" ? (
            <FlyoutAppearanceProvider><DropdownMenu defaultOpen>
              <DropdownMenuTrigger asChild><Button variant="outline">Views</Button></DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-(--flyout-width)" style={shadow ? { "--shadow-flyout": shadow } as CSSProperties : undefined}>
                <DropdownMenuLabel asChild><FlyoutHeader>Views</FlyoutHeader></DropdownMenuLabel>
                <DropdownMenuRadioGroup asChild value={view} onValueChange={setView}><FlyoutOptions>
                  {["All tasks", "Unread", "Completed"].map(label => <DropdownMenuRadioItem key={label} value={label}>{label}</DropdownMenuRadioItem>)}
                </FlyoutOptions></DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu></FlyoutAppearanceProvider>
          ) : (
            <Flyout defaultOpen>
              <FlyoutTrigger asChild><Button variant="outline">{title}</Button></FlyoutTrigger>
              <FlyoutContent align="start" aria-label={title} shadow={shadow} className={mode === "profile" ? "w-(--profile-popover-width)" : undefined}>
                {mode === "profile" ? (
                  <FlyoutHeader data-flyout-profile className="flex items-center gap-2.5">
                    <Avatar className="size-9"><AvatarFallback>RB</AvatarFallback></Avatar>
                    <div className="min-w-0"><h2 className="text-sm font-semibold text-foreground">Riley Board</h2><p className="text-xs text-muted-foreground">riley@paperclip.local</p></div>
                  </FlyoutHeader>
                ) : <FlyoutHeader>Columns</FlyoutHeader>}
                <FlyoutOptions>
                  {mode === "profile" ? profileActions.map(({ label, icon: Icon }) => <Button key={label} variant="ghost" className="justify-start" onClick={() => setLastAction(label)}><Icon className="size-4" />{label}</Button>) : <>
                    {allTaskListColumns.map(id => <Button key={id} variant="ghost" className="justify-start" aria-pressed={columns.includes(id)} onClick={() => setColumns(current => current.includes(id) ? current.filter(value => value !== id) : [...current, id])}>{taskListColumns.find(column => column.id === id)!.label}{columns.includes(id) ? <Check className="ml-auto size-3.5" aria-hidden /> : null}</Button>)}
                    <Button variant="ghost" className="task-list-options-reset" onClick={() => setColumns(defaultTaskListColumns)}>Reset defaults</Button>
                  </>}
                </FlyoutOptions>
              </FlyoutContent>
            </Flyout>
          )}
        </div>
        {lastAction ? <output className="text-sm text-muted-foreground">{lastAction} selected in this preview.</output> : null}
      </div>
    </main>
  );
}
