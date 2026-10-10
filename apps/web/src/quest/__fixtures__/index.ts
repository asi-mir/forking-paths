import { CandidateSchema, FactSchema, type Candidate, type Fact } from "../schema";
import type { ValidateOptions } from "../validate";
import fourStopJson from "./four-stop.json";
import threeStopJson from "./three-stop.json";

/**
 * Synthetic validator fixtures: made-up places and facts with example.org links.
 * Each call returns a fresh deep copy, so a test can break it freely.
 */
export type QuestFixture = {
  facts: Fact[];
  candidates: Candidate[];
  // The writer's JSON, loosely typed so tests can break it in any way.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  writer: any;
  opts: ValidateOptions;
};

function load(json: typeof threeStopJson | typeof fourStopJson): QuestFixture {
  const copy = structuredClone(json);
  return {
    facts: FactSchema.array().parse(copy.facts),
    candidates: CandidateSchema.array().parse(copy.candidates),
    writer: copy.writer,
    opts: copy.opts as ValidateOptions,
  };
}

/** A valid 15-minute quest: start (fork: writing or water) → one of two places → answer. */
export const threeStop = () => load(threeStopJson);

/** A valid 25-minute quest: two forks, six places, four routes that meet at the answer. */
export const fourStop = () => load(fourStopJson);
