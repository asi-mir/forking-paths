import { Mastra } from "@mastra/core/mastra";
import { MongoDBStore } from "@mastra/mongodb";
import { MastraStorageExporter, Observability } from "@mastra/observability";
import { APP_SLUG } from "../lib/app";
import { dbName } from "../lib/db";
import { writerAgent } from "./agents/writer";
import { imageFilter } from "./image-filter";
import { generateQuestWorkflow } from "./workflows/generate-quest";

const uri = process.env.MONGODB_URI?.trim();

/**
 * The one Mastra instance. Route handlers import it, and `pnpm mastra:dev` opens Studio on it.
 * Agents, tools and workflows are registered here.
 * Storage is required for suspended workflow runs; without MONGODB_URI it runs in memory.
 * It shares the app's database (its collections are prefixed "mastra_"); `pnpm db:check` tests it.
 */
export const mastra = new Mastra({
  agents: { writer: writerAgent },
  workflows: { generateQuest: generateQuestWorkflow },
  storage: uri
    ? new MongoDBStore({ id: APP_SLUG, uri, dbName: dbName() })
    : undefined,
  observability: new Observability({
    configs: {
      default: {
        serviceName: APP_SLUG,
        exporters: [new MastraStorageExporter()],
        // Photos never reach stored spans or Sentry. Sentry's built-in Mastra integration adds
        // its exporter to this instance at startup (see sentry.server.config.ts).
        spanOutputProcessors: [imageFilter],
      },
    },
  }),
});
