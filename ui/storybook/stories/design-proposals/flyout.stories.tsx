import type { Meta, StoryObj } from "@storybook/react-vite";
import { FlyoutPreview } from "../../support/design-proposals/FlyoutPreview";

const meta = {
  id: "design-flyout",
  title: "Design proposals/Flyout",
  component: FlyoutPreview,
  globals: { theme: "dark" },
  args: { mode: "columns", shadow: "" },
  argTypes: {
    mode: { control: "select", options: ["columns", "views", "profile"] },
    shadow: { name: "Shadow", control: "text", description: "Local CSS box-shadow override. Clear to inherit --shadow-flyout. Save the approved default in ui/src/index.css to apply it to every refreshed flyout." },
  },
  parameters: {
    layout: "fullscreen",
    docs: { description: { component: "Reusable Flyout, FlyoutContent, FlyoutHeader and FlyoutOptions composed from the existing Popover and Button primitives. Dropdown menus share the same sections and appearance while preserving menu-specific keyboard behavior. Muted-foreground labels and checkmarks become foreground on muted-highlight during hover or focus. The Shadow control is a local preview; --shadow-flyout in the shared token layer owns the saved default." } },
    paperclip: {
      capabilities: ["tasks/organize"],
      status: "proposed",
      home: "design-proposals",
      exception: "Shared flyout component and shadow tuning reference staged with the task-list design refresh.",
      implementation: "production",
      boundary: "fixtures",
      notes: "Isolates the shared flyout composition used by the proposed page menus. Columns demonstrates toggle buttons and inherited-color checks; Views uses the existing radio-menu semantics with checkmarks; Profile demonstrates a rich header and compact actions including Invite. State and profile actions are local fixtures, not production navigation, invitation or permission evidence. Shadow controls affect this preview only; approved values belong in the shared --shadow-flyout token.",
    },
  },
} satisfies Meta<typeof FlyoutPreview>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Columns: Story = {};
export const Views: Story = { args: { mode: "views" } };
export const Profile: Story = { args: { mode: "profile" } };
