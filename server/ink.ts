// Short MCP messages carry a single editable drawing. Readers see a complete
// revision even if the window closes halfway through uploading its replacement.
import { accepts, touchBoard, withBoard } from "./boards.ts";

export const CHUNK = 40_000;
export interface InkRequest {
  board_id: string; topic: number; view: string; part: number;
  revision?: number; total?: number; data?: string;
}
export function ink(req: InkRequest) {
  const { board_id: id, topic, view, part, revision, total, data } = req;
  return withBoard(id, (db, board) => {
    if (!accepts(id, topic, view, board)) return;
    db.exec(`CREATE TABLE IF NOT EXISTS ink(topic INTEGER, view TEXT, rev INTEGER, part INTEGER, data TEXT,
      PRIMARY KEY(topic,view,rev,part));
      CREATE TABLE IF NOT EXISTS ink_head(topic INTEGER PRIMARY KEY, view TEXT, rev INTEGER, total INTEGER)`);
    const head = db.prepare("SELECT view,rev,total FROM ink_head WHERE topic=?").get(topic);
    if (data === undefined) {
      if (!head) return { total: 0 };
      const row = db.prepare("SELECT data FROM ink WHERE topic=? AND view=? AND rev=? AND part=?").get(topic,head.view,head.rev,part);
      return { total: Number(head.total), key: String(head.view) + ":" + head.rev, data: row?.data };
    }
    if (!total || !revision || part >= total || (head?.view === view && Number(head.rev) >= revision)) return;
    if (!part) db.prepare("DELETE FROM ink WHERE topic=? AND NOT (view=? AND rev=?)").run(topic, head?.view ?? "", head?.rev ?? -1);
    db.prepare("INSERT OR REPLACE INTO ink VALUES(?,?,?,?,?)").run(topic,view,revision,part,data);
    if (part === total - 1) {
      const count = db.prepare("SELECT COUNT(*) AS n FROM ink WHERE topic=? AND view=? AND rev=?").get(topic,view,revision);
      if (Number(count?.n) !== total) return;
      db.prepare("INSERT OR REPLACE INTO ink_head VALUES(?,?,?,?)").run(topic,view,revision,total);
      db.prepare("DELETE FROM ink WHERE topic=? AND NOT (view=? AND rev=?)").run(topic,view,revision);
      touchBoard(id);
    }
    return { saved: true };
  });
}
