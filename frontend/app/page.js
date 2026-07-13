"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

// Options Dashboard is the first (and so far only) page migrated to
// Next.js — land here until more pages exist and a real home page is
// worth building.
export default function Home() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/options-dashboard");
  }, [router]);
  return null;
}
