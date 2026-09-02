/** A pill badge for a direction status. Shared across views. */
import React from "react";
import type { DirectionStatus } from "../types";

/** Display label per status — the `archived` arm renders its own muted pill
 * (R-5: archive is the reversible CLI verb; the studio only displays it). */
const STATUS_LABELS: Record<DirectionStatus, string> = {
  active: "active",
  parked: "parked",
  rejected: "rejected",
  approved: "approved",
  archived: "archived",
};

export function StatusBadge({ status }: { status: DirectionStatus }) {
  return <span className={`badge badge-${status}`}>{STATUS_LABELS[status]}</span>;
}
