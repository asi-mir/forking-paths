"use client";

import type { Cue } from "@/quest/schema";
import { httpApi, type PlayApi } from "./client";
import { createMockApi, type MockControls } from "./mock";

/**
 * Picks the adapter in the browser. The real routes are the default; the mock plays the
 * fixture quests in this tab (see mock.ts). Mock controls for tests and screenshots live in
 * localStorage under fp:mock-controls, e.g. {"cue":"water"} or {"far":true}.
 */

export const MOCK_CONTROLS_KEY = "fp:mock-controls";

function controls(): MockControls {
  try {
    return JSON.parse(localStorage.getItem(MOCK_CONTROLS_KEY) ?? "{}") as MockControls;
  } catch {
    return {};
  }
}

/**
 * The mock reader looks at the photo's colours: a blue photo reads as water, a green one as
 * a tree; anything else as the fork's first other cue. Enough to take a fork both ways by
 * hand (photograph the sky or the sea for "water").
 */
async function colourReader(image: Blob, cues: Cue[]): Promise<Cue | null> {
  if (cues.length === 0) return null;
  let r = 0;
  let g = 0;
  let b = 0;
  try {
    const bmp = await createImageBitmap(image, { resizeWidth: 16, resizeHeight: 16 });
    const canvas = document.createElement("canvas");
    canvas.width = 16;
    canvas.height = 16;
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(bmp, 0, 0);
    bmp.close();
    const px = ctx.getImageData(0, 0, 16, 16).data;
    for (let i = 0; i < px.length; i += 4) {
      r += px[i];
      g += px[i + 1];
      b += px[i + 2];
    }
  } catch {
    return cues[0];
  }
  if (b > r * 1.1 && b > g && cues.includes("water")) return "water";
  if (g > r * 1.1 && g > b && cues.includes("plant-or-tree")) return "plant-or-tree";
  return cues.find((c) => c !== "water" && c !== "plant-or-tree") ?? cues[0];
}

let mockApi: PlayApi | null = null;

export function getApi(mock: boolean): PlayApi {
  if (!mock) return httpApi;
  mockApi ??= createMockApi({ storage: localStorage, reader: colourReader, controls });
  return mockApi;
}
