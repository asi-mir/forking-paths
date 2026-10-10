import type { Metadata } from "next";
import { DeskDemoScreen } from "@/components/desk-demo-screen";
import { APP_NAME } from "@/lib/app";

export const metadata: Metadata = { title: `Try it from your desk · ${APP_NAME}` };

/** The desk demo: the saved Karaköy case with sample photos, GPS treated as missing. */
export default function DemoPage() {
  return <DeskDemoScreen />;
}
