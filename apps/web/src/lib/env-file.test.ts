import { describe, expect, it } from "vitest";
import { setEnvLine } from "./env-file";

describe("setEnvLine", () => {
  it("replaces only the named line", () => {
    const before = "A=1\nELEVENLABS_VOICE_ID=old\nB=two words\n";
    expect(setEnvLine(before, "ELEVENLABS_VOICE_ID", "abc123")).toBe("A=1\nELEVENLABS_VOICE_ID=abc123\nB=two words\n");
  });

  it("fills an empty line and keeps a similar name alone", () => {
    const before = "ELEVENLABS_VOICE_ID_OLD=x\nELEVENLABS_VOICE_ID=\n";
    expect(setEnvLine(before, "ELEVENLABS_VOICE_ID", "v")).toBe("ELEVENLABS_VOICE_ID_OLD=x\nELEVENLABS_VOICE_ID=v\n");
  });

  it("uses a commented line, else appends, and drops duplicates", () => {
    expect(setEnvLine("A=1\n# ELEVENLABS_VOICE_ID=\n", "ELEVENLABS_VOICE_ID", "v")).toBe("A=1\nELEVENLABS_VOICE_ID=v\n");
    expect(setEnvLine("A=1\n", "ELEVENLABS_VOICE_ID", "v")).toBe("A=1\nELEVENLABS_VOICE_ID=v\n");
    expect(setEnvLine("A=1", "ELEVENLABS_VOICE_ID", "v")).toBe("A=1\nELEVENLABS_VOICE_ID=v\n");
    expect(setEnvLine("", "ELEVENLABS_VOICE_ID", "v")).toBe("ELEVENLABS_VOICE_ID=v\n");
    expect(setEnvLine("X=a\nX=b\n", "X", "c")).toBe("X=c\n");
  });

  it("refuses odd values and names", () => {
    expect(() => setEnvLine("", "X", "a b")).toThrow();
    expect(() => setEnvLine("", "X", "a\nY=1")).toThrow();
    expect(() => setEnvLine("", "x-y", "a")).toThrow();
  });
});
