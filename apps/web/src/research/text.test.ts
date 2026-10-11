import { describe, expect, it } from "vitest";
import { isArea, isExcluded, isGated, isVisible } from "./kinds";
import { aboutPlace, factSentences, fold, sameName, sentences, snippetText } from "./text";

describe("names", () => {
  it("folds accents and Turkish letters", () => {
    expect(fold("Kılıç Ali Paşa Camii")).toBe("kilic ali pasa camii");
    expect(fold("İstanbul")).toBe("istanbul");
  });

  it("matches the same place across languages, never two kinds of place", () => {
    expect(sameName("Galata Tower", "Galata Kulesi")).toBe(true);
    expect(sameName("Arap Mosque", "Arap Camii")).toBe(true);
    expect(sameName("Kılıç Ali Paşa Mosque", "Kılıç Ali Paşa Hamamı")).toBe(false);
    expect(sameName("Galata Tower", "Neve Shalom Synagogue")).toBe(false);
    // Generic names have nothing distinctive to match on.
    expect(sameName("Tarihi Çeşme", "Tarihi Han")).toBe(false);
  });

  it("says whether a snippet is about the place: its words and its kind", () => {
    expect(aboutPlace("Galata Tower was first built by the Byzantine Emperor", "Galata Tower")).toBe(true);
    expect(aboutPlace("Galata was surrounded by walls constructed by the Genoese", "Galata Tower")).toBe(false);
    expect(aboutPlace("Arap Camii was a church", "Arap Mosque")).toBe(true);
    expect(aboutPlace("Hagia Sophia functions as a mosque", "Arap Mosque")).toBe(false);
  });
});

describe("sentences", () => {
  it("does not split after abbreviations, initials or inside brackets", () => {
    expect(sentences("St. George's church was rebuilt in 1303. It is now a school.")).toEqual([
      "St. George's church was rebuilt in 1303.",
      "It is now a school.",
    ]);
    expect(sentences("The Jewish Museum (Turkish: 500. Yıl Vakfı Müzesi) is a museum. It opened in 2001.")).toEqual([
      "The Jewish Museum (Turkish: 500. Yıl Vakfı Müzesi) is a museum.",
      "It opened in 2001.",
    ]);
  });

  it("keeps whole sentences of at most 300 characters", () => {
    const long = `${"A very long sentence ".repeat(20)}ends here.`;
    expect(factSentences(`${long} Short sentence that counts.`, 4)).toEqual(["Short sentence that counts."]);
  });

  it("cleans snippets: no leading date, no half sentence before the cut", () => {
    expect(snippetText("Oct 2, 2019 — The fountain was built in 1732. It has two taps and a ...")).toBe(
      "The fountain was built in 1732.",
    );
    expect(snippetText("The history of Galata Tower across 1500 years — from a Byzantine lighthouse to the ...")).toBeNull();
    expect(snippetText("The Camondo Stairs were built around 1870.")).toBe("The Camondo Stairs were built around 1870.");
  });
});

describe("kinds of place", () => {
  it("excludes schools, restaurants, streets, stations, events and businesses", () => {
    for (const t of [
      "Private coeducational gymnasium school in Istanbul, Turkey",
      "Michelin-starred restaurant in Istanbul, Turkey",
      "Street in Istanbul, Turkey",
      "Funicular station in Istanbul, Turkey",
      "1986 terrorist attack in Turkey",
      "Massage spa",
      "Bankalar Caddesi",
    ]) {
      expect(isExcluded(t), t).toBe(true);
    }
    for (const t of ["Synagogue in Istanbul, Turkey", "Historical landmark", "Tourist attraction", "Mosque in Istanbul"]) {
      expect(isExcluded(t), t).toBe(false);
    }
  });

  it("finds neighbourhood pages by their description", () => {
    expect(isArea("Quarter in Marmara, Turkey")).toBe(true);
    expect(isArea("Former neighbourhood opposite Constantinople")).toBe(true);
    expect(isArea("Ancient suburb of Byzantium")).toBe(true);
    expect(isArea("Church in Beyoğlu, Istanbul")).toBe(false);
    expect(isArea("Walls of the city of Galata")).toBe(false);
    expect(isArea("Church in arrondissement of Paris, France")).toBe(false);
  });

  it("marks courtyards, gardens and parks as gated, in English and Turkish", () => {
    expect(isGated("Gülhane Park")).toBe(true);
    expect(isGated("Gülhane Parkı")).toBe(true);
    expect(isGated("Botanical garden")).toBe(true);
    expect(isGated("Süleymaniye Camii avlusu")).toBe(true);
    expect(isGated("Karakoy PALACE Historical landmark")).toBe(false);
    expect(isGated("Galata Tower")).toBe(false);
  });

  it("knows visible things", () => {
    expect(isVisible("Matbah Emini Hasan Aga Fountain")).toBe(true);
    expect(isVisible("Tarihi Çeşme")).toBe(true);
    expect(isVisible("Kamondo Stairs Historical landmark")).toBe(true);
    expect(isVisible("Quincentennial Foundation")).toBe(false);
    // Wikipedia pages that share a building's pin but are not things to see.
    expect(isVisible("Lower house of the UK Parliament")).toBe(false);
    expect(isVisible("Women's suffrage protest in London, England")).toBe(false);
    expect(isVisible("Clock tower in London, England")).toBe(true);
    expect(isVisible("Sculptural group in Westminster, London")).toBe(true);
  });
});
