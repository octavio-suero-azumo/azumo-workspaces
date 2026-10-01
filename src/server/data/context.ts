import { getDb, type AppDatabase } from "@/server/db/client";

/**
 * Requester context for every data-layer function (architecture §4.4).
 *
 * `userId` always comes from the server-side session (`requireSession()` /
 * `action()`), never from client input. `db` is injected so integration tests
 * can run the same functions against an isolated test database.
 *
 * `src/server/data/*` is the only app layer that touches the database (the
 * auth module is the other exception). Pages, layouts and server actions call
 * data functions with a `DataContext`; they never import the DB client.
 */
export interface DataContext {
  readonly db: AppDatabase;
  readonly userId: string;
}

/** Build the context for the current request from an authenticated session. */
export async function getDataContext(session: { userId: string }): Promise<DataContext> {
  return { db: await getDb(), userId: session.userId };
}
