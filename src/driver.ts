import makeWASocket, { DisconnectReason } from "@whiskeysockets/baileys";
import pino from "pino";
import { databaseAuth } from "./auth.js";
import type { Lease, Store } from "./store.js";
import type { Driver, DriverEvent } from "./service.js";
export async function driver(
  store: Store,
  lease: Lease,
  onEvent: (event: DriverEvent) => void,
): Promise<Driver> {
  const auth = await databaseAuth(store, lease);
  const socket = makeWASocket({
    auth: auth.state,
    logger: pino({ level: "silent" }),
    connectTimeoutMs: 30000,
    defaultQueryTimeoutMs: 30000,
    markOnlineOnConnect: false,
    syncFullHistory: false,
  });
  let stopped = false;
  const fail = () => {
    if (!stopped) {
      stopped = true;
      socket.end(new Error("Authentication persistence unavailable"));
      onEvent({ kind: "close", loggedOut: false });
    }
  };
  socket.ev.on("creds.update", () => {
    void auth.save().catch(fail);
  });
  socket.ev.on("connection.update", (update) => {
    if (stopped) return;
    if (update.qr) onEvent({ kind: "qr", qr: update.qr });
    if (update.connection === "open")
      void auth
        .flush()
        .then(() => {
          if (!stopped) {
            const phone = socket.user?.id.split(":")[0].split("@")[0];
            if (phone && /^[1-9]\d{6,14}$/.test(phone))
              onEvent({ kind: "open", phone });
            else fail();
          }
        })
        .catch(fail);
    if (update.connection === "close") {
      const code = (
        update.lastDisconnect?.error as { output?: { statusCode?: number } }
      )?.output?.statusCode;
      onEvent({
        kind: "close",
        loggedOut: code === DisconnectReason.loggedOut,
        terminal:
          code === DisconnectReason.connectionReplaced ||
          code === DisconnectReason.badSession ||
          code === DisconnectReason.multideviceMismatch,
      });
    }
  });
  return {
    close: async () => {
      stopped = true;
      socket.end(undefined);
      await auth.flush();
    },
    logout: async () => {
      stopped = true;
      await socket.logout();
      await auth.flush();
    },
    send: async (payload) => {
      await auth.flush();
      if (stopped) throw new Error("Socket stopped");
      const content =
        payload.kind === "text"
          ? { text: payload.message! }
          : payload.media!.mimetype === "image/png"
            ? {
                image: Buffer.from(payload.media!.data, "base64"),
                caption: payload.media!.caption,
              }
            : {
                document: Buffer.from(payload.media!.data, "base64"),
                mimetype: "application/pdf",
                fileName: payload.media!.filename,
                caption: payload.media!.caption,
              };
      const message = await socket.sendMessage(
        `${payload.phone}@s.whatsapp.net`,
        content,
      );
      await auth.flush();
      return message?.key.id ?? null;
    },
  };
}
