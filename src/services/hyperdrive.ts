import postgres from "postgres";
import type { Environment } from "../types";

export interface HyperdriveHealth {
  connected: true;
}

/** Fixed, read-only connectivity check. No request values enter the SQL. */
export async function checkHyperdrive(env: Environment): Promise<HyperdriveHealth> {
  if (!env.HYPERDRIVE) throw new Error("Hyperdrive is not configured");

  const sql = postgres(env.HYPERDRIVE.connectionString, {
    max: 1,
    fetch_types: false,
    prepare: true,
    connection: { application_name: "passing-place-hyperdrive-demo" },
  });

  const rows = await sql`SELECT 1 AS connected`;
  if (Number(rows[0]?.connected) !== 1) {
    throw new Error("Hyperdrive connectivity check failed");
  }

  return { connected: true };
}
