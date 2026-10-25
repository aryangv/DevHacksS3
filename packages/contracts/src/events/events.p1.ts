// Event names owned by P1 (internal bus / queue). Additive only.
export const EVENTS_P1 = {
  inboundReceived: "inbound.received",
  turnCompleted: "turn.completed",
  coordinationRequested: "coordination.requested",
  coordinationAnswered: "coordination.answered",
  taskUpdated: "task.updated",
} as const;
