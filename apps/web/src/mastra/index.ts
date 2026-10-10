import { Mastra } from "@mastra/core/mastra";
import { MongoDBStore } from "@mastra/mongodb";
import { MastraStorageExporter, Observability } from "@mastra/observability";
import { APP_SLUG } from "../lib/app";

const uri = process.env.MONGODB_URI;

/**
 * The one Mastra instance. Route handlers import it, and `pnpm mastra:dev` opens Studio on it.
 * Agents, tools and workflows are registered here.
 * Storage is required for suspended workflow runs; without MONGODB_URI it runs in memory.
 */
export const mastra = new Mastra({
  agents: {},
  workflows: {},
  storage: uri
    ? new MongoDBStore({ id: APP_SLUG, uri, dbName: process.env.MONGODB_DB ?? APP_SLUG })
    : undefined,
  observability: new Observability({
    configs: {
      default: { serviceName: APP_SLUG, exporters: [new MastraStorageExporter()] },
    },
  }),
});
