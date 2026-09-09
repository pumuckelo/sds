import {
  CircleDot,
  CircleCheck,
  CircleDashed,
  CircleX,
  CircleAlert,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { humanizeLabel } from "@/lib/api";

export function StatusBadge({ status }: { status: string }) {
  const Icon =
    status === "active"
      ? CircleDot
      : status === "done"
        ? CircleCheck
        : status === "blocked"
          ? CircleAlert
          : status === "cancelled"
            ? CircleX
            : CircleDashed;
  return (
    <Badge
      variant={
        status === "active"
          ? "default"
          : status === "blocked"
            ? "destructive"
            : "outline"
      }
      data-status={status}
    >
      <Icon data-icon="inline-start" />
      {humanizeLabel(status)}
    </Badge>
  );
}
