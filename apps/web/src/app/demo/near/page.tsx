import type { Metadata } from "next";
import { NearScreen } from "@/components/near-screen";
import { APP_NAME } from "@/lib/app";

export const metadata: Metadata = { title: `Generate a quest near me · ${APP_NAME}` };

/** "Generate a quest near me": near the visitor, or in a city they pick when location is not available. */
export default function NearPage() {
  return <NearScreen />;
}
