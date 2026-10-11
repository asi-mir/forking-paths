import type { QuestView, QuestViewLine } from "./api";
import { citedFacts } from "./bridge";
import { isFork, placeById, routesOf } from "./routes";
import type { Quest } from "./schema";

/**
 * A saved quest as the desk demo shows it: the mystery, every clue, look line, hint and reveal,
 * the forks with their cues and reasons, the finale, and every fact with its source, query and
 * link. Places are listed in walk order (start first, answer last). Each line carries the key
 * that `lineText` and POST /api/quests/[questId]/line take.
 */

const line = (key: string, text: string, facts?: string[]): QuestViewLine => (facts ? { key, text, facts } : { key, text });

/** Places in walk order: the order they first appear on the quest's routes. */
function walkOrder(quest: Quest): string[] {
  const seen: string[] = [];
  for (const route of routesOf(quest)) for (const id of route) if (!seen.includes(id) && placeById(quest, id)) seen.push(id);
  for (const p of quest.places) if (!seen.includes(p.id)) seen.push(p.id);
  // Keep the answer last, so the page reads like the walk.
  return [...seen.filter((id) => id !== quest.answerPlaceId), quest.answerPlaceId].filter((id) => placeById(quest, id));
}

export function questView(quest: Quest & { id: string }): QuestView {
  return {
    questId: quest.id,
    title: quest.title,
    lang: quest.lang,
    minutes: quest.minutes,
    stopsPerRun: quest.stopsPerRun,
    center: quest.center,
    demo: quest.demo === true,
    mystery: { question: quest.mystery.question, answer: quest.mystery.answer, facts: quest.mystery.factIds },
    briefing: line("briefing", quest.briefing.text),
    places: walkOrder(quest).map((id) => {
      const p = placeById(quest, id)!;
      return {
        id: p.id,
        name: p.name,
        role: p.id === quest.startPlaceId ? "start" : p.id === quest.answerPlaceId ? "answer" : "stop",
        fork: isFork(p),
        clue: line(`${p.id}.clue`, p.clue.text),
        look: line(`${p.id}.look`, p.look.text),
        hint: line(`${p.id}.hint`, p.hint.text),
        reveal: line(`${p.id}.reveal`, p.reveal.text, p.reveal.factIds),
        links: p.links.map((l) => ({
          to: l.to,
          toName: placeById(quest, l.to)?.name ?? l.to,
          cue: l.cue ?? null,
          reason: line(`${p.id}.to.${l.to}`, l.reason, l.factIds),
        })),
      };
    }),
    finale: line("finale", quest.finale.text, quest.finale.factIds),
    facts: citedFacts(
      quest,
      quest.facts.map((f) => f.id),
    ),
    writer: quest.model ? `${quest.model.provider}/${quest.model.writer}` : null,
    editedByHand: quest.editedByHand ?? [],
  };
}

const LINE_KEY = /^(briefing|finale|(P\d+)\.(clue|look|hint|reveal)|(P\d+)\.to\.(P\d+))$/;

/** The text behind a line key, or null when the quest has no such line. */
export function lineText(quest: Quest, key: string): string | null {
  const m = LINE_KEY.exec(key);
  if (!m) return null;
  if (m[1] === "briefing") return quest.briefing.text;
  if (m[1] === "finale") return quest.finale.text;
  if (m[2]) {
    const p = placeById(quest, m[2]);
    return p ? p[m[3] as "clue" | "look" | "hint" | "reveal"].text : null;
  }
  const from = placeById(quest, m[4]);
  return from?.links.find((l) => l.to === m[5])?.reason ?? null;
}
