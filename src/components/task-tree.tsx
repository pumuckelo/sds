import { StatusBadge } from "./status-badge";
import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Empty,
  EmptyHeader,
  EmptyTitle,
  EmptyDescription,
} from "@/components/ui/empty";
import { humanizeLabel, type TaskList } from "@/lib/api";

type Item = TaskList["items"][number];
export function TaskTree({
  tasks,
  matches,
  onOpen,
}: {
  tasks: Item[];
  matches: Item[];
  onOpen: (id: string) => void;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const shown = new Set(matches.map((task) => task.id));
  for (const task of matches) {
    let parent = task.parentId;
    const seen = new Set<string>();
    while (parent && !seen.has(parent)) {
      seen.add(parent);
      shown.add(parent);
      parent = byId.get(parent)?.parentId ?? null;
    }
  }
  const children = new Map<string | null, Item[]>();
  for (const task of tasks) {
    if (!shown.has(task.id)) continue;
    const parent =
      task.parentId && byId.has(task.parentId) ? task.parentId : null;
    const siblings = children.get(parent) ?? [];
    siblings.push(task);
    children.set(parent, siblings);
  }
  const filtering = matches.length !== tasks.length;
  const rows: { task: Item; depth: number }[] = [];
  const pending = (children.get(null) ?? [])
    .map((task) => ({ task, depth: 0 }))
    .reverse();
  while (pending.length) {
    const row = pending.pop()!;
    rows.push(row);
    if (filtering || !collapsed.has(row.task.id))
      for (const task of [...(children.get(row.task.id) ?? [])].reverse())
        pending.push({ task, depth: row.depth + 1 });
  }
  if (!rows.length)
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>No matching tasks</EmptyTitle>
          <EmptyDescription>
            Create a task or adjust your filters.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  return (
    <div aria-label="Task hierarchy" className="flex flex-col gap-2">
      {rows.map(({ task, depth }) => (
        <div
          key={task.id}
          className="flex items-center gap-2 rounded-lg border p-3"
          style={{ marginInlineStart: Math.min(depth, 12) * 20 }}
        >
          {(children.get(task.id)?.length ?? 0) > 0 ? (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Toggle subtasks of ${task.title}`}
              aria-expanded={filtering || !collapsed.has(task.id)}
              disabled={filtering}
              onClick={() =>
                setCollapsed((previous) => {
                  const next = new Set(previous);
                  if (next.has(task.id)) next.delete(task.id);
                  else next.add(task.id);
                  return next;
                })
              }
            >
              {collapsed.has(task.id) && !filtering ? (
                <ChevronRight />
              ) : (
                <ChevronDown />
              )}
            </Button>
          ) : (
            <span className="size-7 shrink-0" />
          )}
          <Button
            variant="ghost"
            className="min-w-0 flex-1 justify-start"
            onClick={() => onOpen(task.id)}
          >
            <span className="truncate">{task.title}</span>
          </Button>
          <code className="text-xs text-muted-foreground">{task.ref}</code>
          <Badge variant="outline">{humanizeLabel(task.stage)}</Badge>
          <StatusBadge status={task.status} />
          {task.subtaskCount > 0 && (
            <span className="text-xs text-muted-foreground">
              {task.subtaskCount} subtasks
            </span>
          )}
        </div>
      ))}
    </div>
  );
}
