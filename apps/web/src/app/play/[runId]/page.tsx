import type { Metadata } from "next";
import { Suspense } from "react";
import { PlayScreen } from "@/components/play-screen";
import { APP_NAME } from "@/lib/app";

export const metadata: Metadata = { title: `The walk · ${APP_NAME}` };

/** The walk. Its state lives on the phone (localStorage), so the page itself is a client shell. */
export default function PlayPage({ params }: PageProps<"/play/[runId]">) {
  return (
    <Suspense fallback={<Shell />}>
      {params.then(({ runId }) => (
        <PlayScreen runId={runId} />
      ))}
    </Suspense>
  );
}

function Shell() {
  return <div className="min-h-dvh" />;
}
