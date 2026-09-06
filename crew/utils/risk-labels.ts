export function normalizeRiskLabels(labels: string[] | undefined): string[] | undefined {
  if (!labels) return undefined;
  const normalized = labels
    .map(label => label.trim().toLowerCase())
    .filter(Boolean);
  return normalized.length > 0 ? Array.from(new Set(normalized)) : undefined;
}
