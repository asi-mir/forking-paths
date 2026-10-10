import type { Metadata } from "next";
import { Suspense } from "react";
import { CaseFileScreen } from "@/components/case-file-screen";
import { APP_NAME } from "@/lib/app";

export const metadata: Metadata = { title: `Case file · ${APP_NAME}` };

/** The case file of a finished walk, read from this phone. */
export default function EndPage({ params }: PageProps<"/end/[runId]">) {
  return (
    <Suspense fallback={<div className="min-h-dvh" />}>
      {params.then(({ runId }) => (
        <CaseFileScreen runId={runId} />
      ))}
    </Suspense>
  );
}
