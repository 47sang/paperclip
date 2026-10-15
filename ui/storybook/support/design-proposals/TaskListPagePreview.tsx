import { useState } from "react";
import { ListChecks, SearchX } from "lucide-react";
import { CommandPalette } from "@/components/CommandPalette";
import { DesignSidebar } from "@/components/DesignSidebar";
import { DesignProposalAccess } from "./DesignProposalAccess";
import { initialItems, recentTasks } from "./task-page-data";
import { DesignPageShell } from "@/components/DesignPageShell";
import { EmptyState } from "@/components/EmptyState";
import { KanbanBoard } from "@/components/KanbanBoard";
import { NewIssueDialog } from "@/components/NewIssueDialog";
import { TaskList, includeTaskListAncestors } from "@/components/TaskList";
import { TaskListToolbar } from "@/components/TaskListToolbar";
import { TruncatedTextMarqueeProvider } from "@/components/TruncatedText";
import { useCompany } from "@/context/CompanyContext";
import { useDialogActions } from "@/context/DialogContext";
import { applyIssueFilters, countActiveIssueFilters, defaultIssueFilterState, type IssueFilterState } from "@/lib/issue-filters";
import { allTaskListColumns, defaultTaskListColumns } from "@/lib/task-list";
import { loadTaskListView, matchesTaskListView, saveTaskListView, taskListViewStorageKey, type TaskListView } from "@/lib/task-list-views";
import { storybookAgents, storybookAuthSession, storybookIssueLabels, storybookProjects } from "../../fixtures/paperclipData";

const currentUserId = storybookAuthSession.user.id;
const viewStorageKey = taskListViewStorageKey("design-proposals", currentUserId);

type PreviewProps = { allColumns?: boolean; initialQuery?: string };

export function TaskListPagePreview(props: PreviewProps) {
  return <DesignProposalAccess><TaskListPageContent {...props} /></DesignProposalAccess>;
}

/** Fixture controller only; the page consumes shared production components. */
function TaskListPageContent({ allColumns = false, initialQuery = "" }: PreviewProps) {
  const [items, setItems] = useState(initialItems);
  const [query, setQuery] = useState(initialQuery);
  const [view, setViewState] = useState(() => loadTaskListView(viewStorageKey));
  const setView = (value: TaskListView) => {
    setViewState(value);
    saveTaskListView(viewStorageKey, value);
  };
  const [layout, setLayout] = useState<"list" | "board">("list");
  const [filters, setFilters] = useState<IssueFilterState>(defaultIssueFilterState);
  const [collapsedIds, setCollapsedIds] = useState<ReadonlySet<string>>(new Set());
  const { selectedCompanyId } = useCompany();
  const { openNewIssue } = useDialogActions();
  const companyItems = items.filter(item => item.issue.companyId === selectedCompanyId);
  const parentIds = new Set(companyItems.flatMap(item => item.issue.parentId ? [item.issue.parentId] : []));
  const allExpanded = ![...parentIds].some(id => collapsedIds.has(id));
  const filteredIds = new Set(applyIssueFilters(companyItems.map(item => item.issue), filters, currentUserId).map(issue => issue.id));
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const matchingItems = companyItems.filter(item => {
    if (!filteredIds.has(item.issue.id)) return false;
    if (!matchesTaskListView(view, item.issue, Boolean(item.unread), currentUserId)) return false;
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
      <DesignPageShell title="Tasks" sidebar={<DesignSidebar recentTasks={recentTasks.map(item => item.issue)} onNewTask={() => openNewIssue()} />}>
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
        {layout === "board" ? <div className="design-task-board">{matchingItems.length ? <KanbanBoard showOverflowFades issues={matchingItems.map(item => item.issue)} agents={storybookAgents} onUpdateIssue={(id, data) => setItems(current => current.map(item => item.issue.id === id ? { ...item, issue: { ...item.issue, ...data } } : item))} /> : emptyState}</div> : null}
      </DesignPageShell>
      <NewIssueDialog />
      <CommandPalette />
    </TruncatedTextMarqueeProvider>
  );
}
