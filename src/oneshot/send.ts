import * as dao from "../storage/dao.js";
import { openDb } from "../storage/db.js";
import { notifyPeer } from "../notify/bus.js";
import { readStdinAll, resolveHandle } from "./common.js";
import { roomTargetRefusal, unknownPeerRefusal } from "../util/naming.js";
import { childHandleFor } from "../supervise/grant.js";

const MAX_BODY_BYTES = 64 * 1024;

export interface SendOpts {
  to: string;
  body?: string;
  from?: string;
  stdin?: boolean;
  json?: boolean;
}

export async function runSend(opts: SendOpts): Promise<void> {
  const from = resolveHandle(opts.from, "--from");
  if (opts.to === from) throw new Error("Cannot send to self");

  const readingStdin = opts.stdin === true || opts.body === undefined;
  const body = readingStdin ? await readStdinAll() : (opts.body ?? "");
  if (body.length === 0) throw new Error("Empty body — nothing to send");
  if (Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) {
    throw new Error(`Body exceeds ${MAX_BODY_BYTES}-byte cap`);
  }

  const db = openDb();
  try {
    const recipient = dao.getAgent(db, opts.to);
    if (!recipient) {
      if (opts.to.startsWith("#")) {
        throw new Error(
          roomTargetRefusal(
            opts.to,
            `There is no one-shot room send: run 'chat-mcp cli --handle ${from}', then '/join ${opts.to}', then type.`,
          ),
        );
      }
      const child = childHandleFor(opts.to);
      throw new Error(
        unknownPeerRefusal(
          opts.to,
          dao.getAgent(db, child) ? child : null,
          "Run 'chat-mcp list --all' to see registered handles.",
        ),
      );
    }
    const result = dao.insertMessage(db, { from, to: opts.to, body });
    notifyPeer(opts.to, {
      id: result.id,
      to: opts.to,
      from,
      ts: result.sent_at,
      body,
    });
    if (opts.json) {
      process.stdout.write(
        `${JSON.stringify({ message_id: result.id, sent_at: result.sent_at })}\n`,
      );
    } else {
      process.stdout.write(`sent id=${result.id} to=${opts.to}\n`);
    }
  } finally {
    db.close();
  }
}
