import { readLatestSnapshot } from "../lib/snapshot.ts";
import ConsoleClient from "../components/ConsoleClient";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function Page() {
  const initial = await readLatestSnapshot();
  return <ConsoleClient initial={initial} />;
}
