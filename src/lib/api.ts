import type { Task, Operation } from "../core/schema";
import type { TaskList, CheckoutList } from "../core/service";
export type CheckoutView = CheckoutList[number] & { branch: string | null };
type TaskLink = {
  id: string;
  ref: string;
  title: string;
  status: string;
  stage: string;
};
export type TaskView = Task & {
  dependencies: TaskLink[];
  dependents: TaskLink[];
  ancestors: {
    id: string;
    ref: string;
    title: string;
    stage: string;
    status: string;
  }[];
  subtaskCount: number;
  activity: { running: boolean; agent?: string; seenAt?: string };
};
export type Op = typeof Operation.Type;
export type { TaskList };
export async function api<T>(
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(`/api/${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers:
      body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  const data = await response.json();
  if (!response.ok)
    throw new Error(
      data.error?.message ?? `Request failed (${response.status})`,
    );
  return data as T;
}
export const humanizeLabel = (value: string) =>
  value.charAt(0).toUpperCase() + value.slice(1);
export function formatRelativeTime(value: string) {
  const minutes = Math.max(
    0,
    Math.floor((Date.now() - new Date(value).getTime()) / 60_000),
  );
  return minutes < 1
    ? "just now"
    : minutes < 60
      ? `${minutes}m ago`
      : minutes < 1440
        ? `${Math.floor(minutes / 60)}h ago`
        : `${Math.floor(minutes / 1440)}d ago`;
}

const statusOrder: Record<string, number> = {
  active: 0,
  blocked: 1,
  queued: 2,
  done: 3,
  cancelled: 4,
};
export function compareTasksForBoard(
  a: { status: string; updatedAt: string; id: string },
  b: { status: string; updatedAt: string; id: string },
) {
  return (
    (statusOrder[a.status] ?? 5) - (statusOrder[b.status] ?? 5) ||
    b.updatedAt.localeCompare(a.updatedAt) ||
    a.id.localeCompare(b.id)
  );
}
