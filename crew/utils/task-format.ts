import type { Task } from "../types.ts";

export function taskMetadataMarkers(task: Task): string {
  const markers = [
    task.role ? `[${task.role}]` : null,
    task.risk_labels && task.risk_labels.length > 0 ? `[risk: ${task.risk_labels.join(", ")}]` : null,
    task.approval?.required ? `[approval: ${task.approval.status}]` : null,
  ].filter(Boolean);
  return markers.length > 0 ? ` ${markers.join(" ")}` : "";
}

export function approvalTaskSummaries(tasks: Task[]): { id: string; title: string; approval: Task["approval"] }[] {
  return tasks.map(task => ({ id: task.id, title: task.title, approval: task.approval }));
}
