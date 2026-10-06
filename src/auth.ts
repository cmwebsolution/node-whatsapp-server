import {
  initAuthCreds,
  proto,
  BufferJSON,
  type AuthenticationState,
} from "@whiskeysockets/baileys";
import type { Lease, Store } from "./store.js";
export async function databaseAuth(store: Store, lease: Lease) {
  const existing = await store.auth(lease, "creds", ["main"]);
  const creds = existing.main ?? initAuthCreds();
  if (!existing.main)
    await store.writeAuth(lease, [{ type: "creds", id: "main", value: creds }]);
  let writes = Promise.resolve();
  const enqueue = (
    entries: { type: string; id: string; value: unknown | null }[],
  ) => {
    const snapshot = JSON.parse(
      JSON.stringify(entries, BufferJSON.replacer),
      BufferJSON.reviver,
    );
    const operation = writes.then(() => store.writeAuth(lease, snapshot));
    writes = operation;
    return operation;
  };
  const state: AuthenticationState = {
    creds,
    keys: {
      get: async (type, ids) => {
        await writes;
        const values = await store.auth(lease, type, ids);
        if (type === "app-state-sync-key")
          for (const id of Object.keys(values))
            values[id] = proto.Message.AppStateSyncKeyData.fromObject(
              values[id],
            );
        return values;
      },
      set: async (data) => {
        await enqueue(
          Object.entries(data).flatMap(([type, values]) =>
            Object.entries(values ?? {}).map(([id, value]) => ({
              type,
              id,
              value,
            })),
          ),
        );
      },
    },
  };
  return {
    state,
    save: () => enqueue([{ type: "creds", id: "main", value: creds }]),
    flush: () => writes,
  };
}
