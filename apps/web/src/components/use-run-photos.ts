"use client";

import { useCallback, useEffect, useState } from "react";
import { photosOf } from "@/play/photo-store";

export type PhotoView = { placeId: string; url: string; at: number };

/** The walk's photos from IndexedDB (this phone only), as object URLs. */
export function useRunPhotos(runId: string) {
  const [version, setVersion] = useState(0);
  const [photos, setPhotos] = useState<PhotoView[]>([]);

  useEffect(() => {
    let live = true;
    const made: string[] = [];
    photosOf(runId).then((rows) => {
      if (!live) return;
      const views = rows.map((r) => {
        const url = URL.createObjectURL(r.blob);
        made.push(url);
        return { placeId: r.placeId, url, at: r.at };
      });
      setPhotos(views);
    });
    return () => {
      live = false;
      made.forEach((u) => URL.revokeObjectURL(u));
    };
  }, [runId, version]);

  const refresh = useCallback(() => setVersion((v) => v + 1), []);
  return { photos, refresh };
}
