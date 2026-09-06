import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { recoverTurnProcess } from "./process-history.ts";
import { TeamStore } from "./store.ts";

const { DatabaseSync, backup } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

export async function backfillProcesses(cwd: string, apply = false, threadId?: string) {
  const path = join(cwd, ".pi", "messenger", "team-runtime.sqlite");
  const directory = join(dirname(path), "process-backups");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = join(directory, `${apply ? "before" : "dry-run"}-${stamp}.sqlite`);
  const reader = new DatabaseSync(path, { readOnly: true });
  try { await backup(reader, backupPath); } finally { reader.close(); }
  chmodSync(backupPath, 0o600);
  // Dry runs modify only the consistent snapshot, never the live database.
  const store = new TeamStore(apply ? path : backupPath);
  const counts = { restored: 0, partial: 0, alreadySaved: 0, unavailable: 0, failed: 0 };
  const details: Array<{ messageId: string; threadId: string; agentId: string; status: string; thinkingChars?: number; tools?: number }> = [];
  try {
    for (const team of store.listTeams(true)) for (const thread of store.listThreads(team.id, true)) {
      if (threadId && thread.id !== threadId) continue;
      for (const message of store.listMessages(thread.id).filter(message => message.authorType === "agent")) {
        if (message.parentInvocationId && store.getInvocationProcess(message.parentInvocationId)?.data.status === "complete") { counts.alreadySaved++; continue; }
        const item = { messageId: message.id, threadId: message.threadId, agentId: message.authorId };
        try {
          const data = await recoverTurnProcess(store, message.id);
          if (data.status === "complete") counts.restored++;
          else if (data.status === "partial") counts.partial++;
          else counts.unavailable++;
          details.push({ ...item, status: data.status, thinkingChars: data.thinkingText.length, tools: data.tools.length });
        } catch { counts.failed++; details.push({ ...item, status: "read_failed" }); }
      }
    }
    const reportPath = `${backupPath}.report.json`;
    const report = { apply, threadId, backupPath, reportPath, counts, details };
    writeFileSync(reportPath, JSON.stringify(report, null, 2), { mode: 0o600 });
    return report;
  } finally { store.close(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.slice(2).some(arg => arg !== "--apply" && arg !== "--dry-run")) throw new Error("Usage: node --experimental-transform-types team-runtime/backfill-process.ts [--dry-run|--apply]");
  console.log(JSON.stringify(await backfillProcesses(process.cwd(), process.argv.includes("--apply")), null, 2));
}
