import type { Meta, StoryObj } from "@storybook/react-vite";
import { TaskListPagePreview } from "../../support/design-proposals/TaskListPagePreview";

const meta = {
  id: "tasks-list-page-design",
  title: "Design proposals/Task list page",
  component: TaskListPagePreview,
  globals: { theme: "dark" },
  parameters: {
    layout: "fullscreen",
    initialEntries: ["/PAP/issues"],
    docs: { description: { component: "Full-page design proposal composed from the reviewed task rows and columns, production sidebar organization/account menus, task filters, Kanban board and task composer. Default opens with Task, Task ID and Last updated; headers remain inactive until the user sorts. Search, filters, views, expand/collapse, sorting and column configuration run against local fixture state. Sidebar labels use sm and icons match Paper. Organization selection uses the production switcher with company-scoped task fixtures. Navigation, task creation, persistence and backend behavior require app integration; they are not established by this preview." } },
    paperclip: {
      capabilities: ["tasks/organize", "inbox-search/search"],
      status: "proposed",
      home: "design-proposals",
      exception: "Full-page design refresh staged for visual approval before agent reproduction and production adoption.",
      implementation: "production",
      boundary: "fixtures",
      notes: "Composes DesignPageShell, TaskListToolbar and TaskList from shared components. SidebarCompanyMenu and SidebarAccountMenu preserve production behavior with the shared proposed flyout appearance. The organization, account, Views and Columns menus share background, highlight, text and shadow tokens. The account menu fits its contents and shows Invite using owner-access and loaded-policy fixtures; production invitation gates remain intact. The sidebar uses muted and border; the task search field uses background-alt. The organization control omits its caret and has a separate global-search button that opens the production CommandPalette. Truncated sidebar and menu labels opt into the same CellMarquee motion and fade as table cells. Navigation labels use sm and icons match Paper. The grouping icon is omitted. Headers have no active sort until the user chooses one. Organization selection scopes the fixture tasks and recent links. Search and filters keep ancestors for context. List/board, views and expansion use local fixture state. Board and New Task reuse existing components; their appearance is not a new approved design. Sidebar links are router fixtures, not destination-page coverage. No production route, API or saved preferences change. Visual review is required before this becomes the reference for a fresh-agent reproduction test.",
    },
  },
} satisfies Meta<typeof TaskListPagePreview>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const AllColumns: Story = { args: { allColumns: true } };
export const NoResults: Story = { args: { initialQuery: "unmatched search" } };
