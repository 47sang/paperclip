import { useLayoutEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { CurrentBoardAccess } from "@/api/access";
import type { HealthStatus } from "@/api/health";
import { Boxes, CircleCheck, CirclePlus, FolderOpen, History, LayoutDashboard, ListChecks, MessageCircle, Package, Repeat, Search, SearchX, Unplug, Users } from "lucide-react";
import { CommandPalette } from "@/components/CommandPalette";
import { DesignPageShell } from "@/components/DesignPageShell";
import { EmptyState } from "@/components/EmptyState";
import { KanbanBoard } from "@/components/KanbanBoard";
import { NewIssueDialog } from "@/components/NewIssueDialog";
import { SidebarAccountMenu } from "@/components/SidebarAccountMenu";
import { SidebarCompanyMenu } from "@/components/SidebarCompanyMenu";
import { SidebarNavExpandedProvider, SidebarNavItem } from "@/components/SidebarNavItem";
import { SidebarSection } from "@/components/SidebarSection";
import { TaskList, includeTaskListAncestors, type TaskListItem } from "@/components/TaskList";
import { TaskListToolbar, type TaskListView } from "@/components/TaskListToolbar";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { TruncatedTextMarqueeProvider } from "@/components/TruncatedText";
import { useCompany } from "@/context/CompanyContext";
import { useDialogActions } from "@/context/DialogContext";
import { applyIssueFilters, countActiveIssueFilters, defaultIssueFilterState, type IssueFilterState } from "@/lib/issue-filters";
import { allTaskListColumns, defaultTaskListColumns } from "@/lib/task-list";
import { queryKeys } from "@/lib/queryKeys";
import { storybookAgents, storybookAuthSession, storybookCompanies, storybookIssueLabels, storybookProjects } from "../../fixtures/paperclipData";
import { installFixtureApi } from "../capability-gaps/api";
import { columnData, reviewTaskItems, task } from "./task-list-data";

const extraTasks: TaskListItem[] = [
  task(458, "Simplify the first company setup", "in_progress"),
  task(459, "Review budget notifications", "in_review"),
  task(460, "Collect feedback on the refreshed task list", "todo"),
].map((issue, index) => {
  const data = columnData(issue, index === 2 ? "Design" : "Codex");
  return { issue: data.issue, createdBy: data.creator, assignee: data.assignee, unread: index === 0 };
});
const initialItems = [...reviewTaskItems, ...extraTasks];
const recentTasks = [...initialItems]
  .filter(item => !item.issue.parentId)
  .sort((left, right) => new Date(right.issue.updatedAt).getTime() - new Date(left.issue.updatedAt).getTime())
  .slice(0, 5);

function ProposalSidebar({ onNewTask }: { onNewTask: () => void }) {
  const { selectedCompany } = useCompany();
  const root = `/${selectedCompany?.issuePrefix ?? "PAP"}`;
  return (
    <SidebarNavExpandedProvider>
      <div className="design-sidebar">
        <div className="design-sidebar-brand">
          <SidebarCompanyMenu showChevron={false} />
          <Tooltip><TooltipTrigger asChild><Button variant="ghost" size="icon-sm" className="design-sidebar-search" aria-label="Global search" onClick={() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true, cancelable: true }))}><Search aria-hidden /></Button></TooltipTrigger><TooltipContent side="right">Search tasks, agents, projects</TooltipContent></Tooltip>
        </div>
        <nav className="design-sidebar-navigation" aria-label="Main navigation">
          <div className="design-sidebar-primary">
            <Button variant="ghost" className="design-sidebar-new-task" onClick={onNewTask}><CirclePlus aria-hidden />New Task</Button>
            <SidebarNavItem className="design-sidebar-item" to={`${root}/dashboard`} label="Dashboard" icon={LayoutDashboard} />
            <SidebarNavItem className="design-sidebar-item" to={`${root}/chats`} label="Chat" icon={MessageCircle} />
          </div>
          <SidebarSection label="Work">
            <SidebarNavItem className="design-sidebar-item" to={`${root}/issues`} label="Tasks" icon={CircleCheck} active />
            <SidebarNavItem className="design-sidebar-item" to={`${root}/projects`} label="Projects" icon={FolderOpen} />
            <SidebarNavItem className="design-sidebar-item" to={`${root}/routines`} label="Routines" icon={Repeat} />
            <SidebarNavItem className="design-sidebar-item" to={`${root}/artifacts`} label="Artifacts" icon={Package} />
          </SidebarSection>
          <SidebarSection label="Org">
            <SidebarNavItem className="design-sidebar-item" to={`${root}/agents`} label="Agents" icon={Users} />
            <SidebarNavItem className="design-sidebar-item" to={`${root}/skills`} label="Skills" icon={Boxes} />
            <SidebarNavItem className="design-sidebar-item" to={`${root}/apps`} label="Connectors" icon={Unplug} />
            <SidebarNavItem className="design-sidebar-item" to={`${root}/activity`} label="Audit" icon={History} />
          </SidebarSection>
          {selectedCompany?.id === "company-storybook" ? <div className="design-sidebar-recents">
            <SidebarSection label="Recent Tasks">
              {recentTasks.map(({ issue }) => <SidebarNavItem key={issue.id} className="design-sidebar-item" to={`${root}/issues/${issue.identifier}`} label={issue.title} />)}
            </SidebarSection>
          </div> : null}
        </nav>
        <div className="design-sidebar-account"><SidebarAccountMenu forceExpanded /></div>
      </div>
    </SidebarNavExpandedProvider>
  );
}

type PreviewProps = { allColumns?: boolean; initialQuery?: string };

/** Supply the same owner access and loaded operator policy that production
 * menus require. This preview never bypasses their invitation gates. */
export function TaskListPagePreview(props: PreviewProps) {
  const client = useQueryClient();
  const [ready, setReady] = useState(false);
  useLayoutEffect(() => {
    const access: CurrentBoardAccess = {
      user: storybookAuthSession.user, userId: "user-board", isInstanceAdmin: false,
      companyIds: storybookCompanies.map(company => company.id), source: "authenticated", keyId: null,
      memberships: storybookCompanies.map(company => ({ companyId: company.id, membershipRole: "owner", status: "active" })),
    };
    const fixtures = installFixtureApi([{ path: "/api/cli-auth/me", read: () => access }]);
    client.setQueryData<HealthStatus>(queryKeys.health, { status: "ok", deploymentMode: "authenticated", hiddenSettings: [] });
    client.setQueryData<CurrentBoardAccess>(queryKeys.access.currentBoardAccess, access);
    setReady(true);
    return () => fixtures.cleanup();
  }, [client]);
  return ready ? <TaskListPageContent {...props} /> : null;
}

/** Fixture controller only; the page consumes shared production components. */
function TaskListPageContent({ allColumns = false, initialQuery = "" }: PreviewProps) {
  const [items, setItems] = useState(initialItems);
  const [query, setQuery] = useState(initialQuery);
  const [view, setView] = useState<TaskListView>("all");
  const [layout, setLayout] = useState<"list" | "board">("list");
  const [filters, setFilters] = useState<IssueFilterState>(defaultIssueFilterState);
  const [collapsedIds, setCollapsedIds] = useState<ReadonlySet<string>>(new Set());
  const { selectedCompanyId } = useCompany();
  const { openNewIssue } = useDialogActions();
  const companyItems = items.filter(item => item.issue.companyId === selectedCompanyId);
  const parentIds = new Set(companyItems.flatMap(item => item.issue.parentId ? [item.issue.parentId] : []));
  const allExpanded = ![...parentIds].some(id => collapsedIds.has(id));
  const filteredIds = new Set(applyIssueFilters(companyItems.map(item => item.issue), filters, "user-board").map(issue => issue.id));
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const matchingItems = companyItems.filter(item => {
    if (!filteredIds.has(item.issue.id)) return false;
    if (view === "unread" && !item.unread) return false;
    if (view === "completed" && item.issue.status !== "done") return false;
    return [item.issue.title, item.issue.identifier, item.createdBy, item.assignee, item.issue.project?.name, ...(item.issue.labels ?? []).map(label => label.name)].some(value => value?.toLocaleLowerCase().includes(normalizedQuery));
  });
  const visibleItems = includeTaskListAncestors(companyItems, matchingItems);
  const activeFilterCount = countActiveIssueFilters(filters);
  const narrowed = Boolean(normalizedQuery || activeFilterCount || view !== "all");
  const emptyState = companyItems.length === 0
    ? <EmptyState icon={ListChecks} message="No tasks in this organization" description="This preview has task fixtures for Paperclip Storybook." />
    : <EmptyState icon={SearchX} message="No tasks match this view" description="Try another search or clear your filters." action="Clear filters" hideActionIcon onAction={() => { setQuery(""); setView("all"); setFilters(defaultIssueFilterState); }} />;
  const resetExpansion = () => setCollapsedIds(new Set());
  return (
    <TruncatedTextMarqueeProvider>
      <DesignPageShell title="Tasks" sidebar={<ProposalSidebar onNewTask={() => openNewIssue()} />}>
        <TaskListToolbar
          view={view} onViewChange={value => { setView(value); resetExpansion(); }}
          query={query} onQueryChange={value => { setQuery(value); resetExpansion(); }}
          layout={layout} onLayoutChange={setLayout}
          allExpanded={allExpanded} onToggleExpanded={() => setCollapsedIds(allExpanded ? parentIds : new Set())}
          onNewTask={() => openNewIssue()}
          filters={{ state: filters, onChange: patch => { setFilters(current => ({ ...current, ...patch })); resetExpansion(); }, activeFilterCount, agents: storybookAgents, projects: storybookProjects, labels: storybookIssueLabels, currentUserId: "user-board", creators: [{ id: "user:user-board", label: "Scott", kind: "user" }, { id: "agent:agent-codex", label: "CodexCoder", kind: "agent" }] }}
        />
        {narrowed ? <p className="design-task-results" role="status">{matchingItems.length} matching {matchingItems.length === 1 ? "task" : "tasks"}{visibleItems.length > matchingItems.length ? " · Parent tasks included for context" : ""}</p> : null}
        <div hidden={layout !== "list"} className="design-task-list-panel">
          <TaskList key={selectedCompanyId} items={visibleItems} allItems={companyItems} initialColumns={allColumns ? allTaskListColumns : defaultTaskListColumns} collapsedIds={collapsedIds} onCollapsedIdsChange={setCollapsedIds} emptyState={emptyState} />
        </div>
        {layout === "board" ? <div className="design-task-board">{matchingItems.length ? <KanbanBoard issues={matchingItems.map(item => item.issue)} agents={storybookAgents} onUpdateIssue={(id, data) => setItems(current => current.map(item => item.issue.id === id ? { ...item, issue: { ...item.issue, ...data } } : item))} /> : emptyState}</div> : null}
      </DesignPageShell>
      <NewIssueDialog />
      <CommandPalette />
    </TruncatedTextMarqueeProvider>
  );
}
