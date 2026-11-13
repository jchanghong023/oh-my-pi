import type { ProjectSidebarProps } from "@/project-sidebar/contract.js";
import { NewTaskButtonGroup } from "@/NewTaskButtonGroup.js";

export function ProjectSidebarNavigation({
  props,
  onCreate,
}: {
  props: Pick<ProjectSidebarProps, "isWebRemoteControl">;
  onCreate(): void;
}) {
  return (
    <div
      data-testid="sidebar-primary-navigation"
      className={`flex flex-col gap-1 px-2 py-3 ${props.isWebRemoteControl ? "max-md:pt-11" : ""}`}
    >
      <NewTaskButtonGroup onCreateTask={onCreate} />
    </div>
  );
}
