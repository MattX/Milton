import { Firestore } from "@google-cloud/firestore";
import { executeRebuild, inspectRebuild, type RebuildPlan } from "./rebuild-index.js";

interface Arguments {
  execute: boolean;
  confirmation: string | null;
}

export function parseRebuildArguments(values: string[]): Arguments {
  let execute = false;
  let confirmation: string | null = null;
  for (const value of values) {
    if (value === "--execute") execute = true;
    else if (value.startsWith("--confirm-project=")) confirmation = value.slice("--confirm-project=".length);
    else throw new Error(`Unknown argument: ${value}`);
  }
  if (confirmation !== null && !execute) throw new Error("--confirm-project requires --execute");
  return { execute, confirmation };
}

function printPlan(projectId: string, databaseId: string, plan: RebuildPlan, executed: boolean): void {
  console.log(`${executed ? "Rebuild complete" : "Dry run"} for ${projectId}/${databaseId}`);
  console.log(`articles: ${plan.articles}`);
  console.log(`extractionJobs: ${plan.extractionJobs} (${plan.pendingJobs} pending, ${plan.processingJobs} processing)`);
  console.log(`discordCursors: ${plan.discordCursors}`);
}

async function main(): Promise<void> {
  const args = parseRebuildArguments(process.argv.slice(2));
  const projectId = process.env.GOOGLE_CLOUD_PROJECT?.trim();
  if (!projectId) throw new Error("Missing required environment variable GOOGLE_CLOUD_PROJECT");
  const databaseId = process.env.FIRESTORE_DATABASE_ID?.trim() || "milton";
  const db = new Firestore({ projectId, databaseId });
  try {
    const plan = args.execute
      ? await executeRebuild(db, projectId, args.confirmation || "")
      : await inspectRebuild(db);
    printPlan(projectId, databaseId, plan, args.execute);
    if (!args.execute) {
      console.log(`No changes made. Execute with: npm run rebuild-index -- --execute --confirm-project=${projectId}`);
    }
  } finally {
    await db.terminate();
  }
}

await main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
