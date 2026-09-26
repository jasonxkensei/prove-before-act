import * as React from "react";
import { Badge, type BadgeProps } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

type Status = "verified" | "pending" | "warning" | "failed";

const statusClasses: Record<Status, string> = {
  verified: "status-verified",
  pending: "status-pending",
  warning: "status-warning",
  failed: "status-failed",
};

interface StatusIndicatorProps extends React.HTMLAttributes<HTMLElement> {
  status: Status;
  as?: "span" | "div" | "p";
  badgeVariant?: BadgeProps["variant"];
}

/** Uses the shared semantic status treatment without changing the caller's label or markup. */
export function StatusIndicator({
  status,
  as: Element = "span",
  badgeVariant,
  className,
  ...props
}: StatusIndicatorProps) {
  const classes = cn(statusClasses[status], className);
  if (badgeVariant) {
    return <Badge variant={badgeVariant} className={classes} {...props as BadgeProps} />;
  }
  return <Element className={classes} {...props} />;
}