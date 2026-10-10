import { createMemoryStore } from "./memory";
import { storeContract } from "./store.contract";

storeContract("memory", (opts) => createMemoryStore(opts));
