import { createStep, createWorkflow } from "@mastra/core/workflows";
import {
  CheckedSchema,
  DraftedSchema,
  GenerateInputSchema,
  GenerateOutputSchema,
  ResearchedSchema,
  researchStep,
  saveStep,
  validateStep,
  writeStep,
} from "@/quest/generate";

/**
 * generate-quest: research (code: SerpApi Maps + Search and Wikipedia, ≤ 6 SerpApi searches)
 * → write (one Gemma call, thinking on) → validate (code; one repair with the error list)
 * → save (MongoDB, or memory without MONGODB_URI). No voice: a quest is voiced when a run starts.
 *
 * The steps' logic lives in `src/quest/generate.ts`, so it can be tested without Mastra.
 */

const research = createStep({
  id: "research",
  description: "Places and cited facts near the point, in code (≤ 6 SerpApi searches), plus route options that fit the distance rules.",
  inputSchema: GenerateInputSchema,
  outputSchema: ResearchedSchema,
  execute: async ({ inputData }) => researchStep(inputData),
});

const write = createStep({
  id: "write",
  description: "One Gemma call (thinking on) writes the mystery, clues, look lines, reveals, fork links and finale as JSON citing fact IDs.",
  inputSchema: ResearchedSchema,
  outputSchema: DraftedSchema,
  execute: async ({ inputData }) => writeStep(inputData),
});

const validate = createStep({
  id: "validate",
  description: "Grounding, safety, route and distance rules; on rejection, one repair call with the error list.",
  inputSchema: DraftedSchema,
  outputSchema: CheckedSchema,
  execute: async ({ inputData }) => validateStep(inputData),
});

const save = createStep({
  id: "save",
  description: "Saves the validated quest with its validation record, model, timings and SerpApi count.",
  inputSchema: CheckedSchema,
  outputSchema: GenerateOutputSchema,
  execute: async ({ inputData }) => saveStep(inputData),
});

export const generateQuestWorkflow = createWorkflow({
  id: "generate-quest",
  description: "Research → write (Gemma) → validate (one repair) → save.",
  inputSchema: GenerateInputSchema,
  outputSchema: GenerateOutputSchema,
})
  .then(research)
  .then(write)
  .then(validate)
  .then(save)
  .commit();
