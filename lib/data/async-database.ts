import { createClient, type Client, type InStatement, type ResultSet } from "@libsql/client";

/** Both root clients and transaction handles expose this same query boundary. */
export type DatabaseQueries = { execute(statement: InStatement): Promise<ResultSet> };

/** Pass the supplied handle to every helper; never use the root client inside work. */
export async function transaction<T>(client: Client, work: (queries: DatabaseQueries) => Promise<T>): Promise<T> {
  const tx = await client.transaction("write");
  try {
    const result = await work(tx);
    await tx.commit();
    return result;
  } catch (error) {
    try { await tx.rollback(); } catch { /* Preserve the operation's original error. */ }
    throw error;
  } finally { tx.close(); }
}

export { createClient };
