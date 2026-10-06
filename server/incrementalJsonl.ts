import fsp from "node:fs/promises";

type Entry<T> = {
  inode: number;
  device: number;
  size: number;
  mtimeMs: number;
  offset: number;
  recordIndex: number;
  state: T;
  prefix: Buffer;
  anchor: Buffer;
};

/** Fold append-only transcripts once, retaining only the consumer's bounded state. */
export class IncrementalJsonl<T> {
  private entries = new Map<string, Entry<T>>();
  private inFlight = new Map<string, Promise<T>>();

  constructor(
    private readonly create: () => T,
    private readonly consume: (state: T, record: Record<string, unknown>, index: number) => void,
    private readonly maxEntries = 128
  ) {}

  read(file: string): Promise<T> {
    const pending = this.inFlight.get(file);
    if (pending) return pending;
    const operation = this.readNow(file).finally(() => this.inFlight.delete(file));
    this.inFlight.set(file, operation);
    return operation;
  }

  private async readNow(file: string): Promise<T> {
    const handle = await fsp.open(file, "r");
    try {
      const stat = await handle.stat();
      let entry = this.entries.get(file);
      if (entry && entry.inode === stat.ino && entry.device === stat.dev && entry.size === stat.size && entry.mtimeMs === stat.mtimeMs) {
        this.entries.delete(file);
        this.entries.set(file, entry);
        return entry.state;
      }
      const sample = async (length: number, position: number) => {
        const bytes = Buffer.alloc(length);
        const { bytesRead } = await handle.read(bytes, 0, length, position);
        return bytes.subarray(0, bytesRead);
      };
      const replaced = entry && stat.size > entry.size && (
        !(await sample(entry.prefix.length, 0)).equals(entry.prefix)
        || !(await sample(entry.anchor.length, Math.max(0, entry.offset - entry.anchor.length))).equals(entry.anchor)
      );
      if (!entry || entry.inode !== stat.ino || entry.device !== stat.dev || stat.size < entry.size || replaced || (stat.size === entry.size && stat.mtimeMs !== entry.mtimeMs)) {
        entry = { inode: stat.ino, device: stat.dev, size: 0, mtimeMs: 0, offset: 0, recordIndex: 0, state: this.create(), prefix: Buffer.alloc(0), anchor: Buffer.alloc(0) };
      }
      this.entries.delete(file);
      this.entries.set(file, entry);
      while (this.entries.size > this.maxEntries) this.entries.delete(this.entries.keys().next().value!);

      let position = entry.offset;
      let pending = Buffer.alloc(0);
      const parse = (line: Buffer) => {
        if (!line.length) return true;
        let record: unknown;
        try { record = JSON.parse(line.toString("utf8")); }
        catch { return false; }
        if (record && typeof record === "object" && !Array.isArray(record)) {
          this.consume(entry!.state, record as Record<string, unknown>, entry!.recordIndex++);
        }
        return true;
      };
      // Limit each read and yield through async I/O so long transcripts cannot
      // monopolize the event loop. The final partial JSON record is retried.
      while (position < stat.size) {
        const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, stat.size - position));
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
        if (!bytesRead) break;
        position += bytesRead;
        const data = pending.length ? Buffer.concat([pending, chunk.subarray(0, bytesRead)]) : chunk.subarray(0, bytesRead);
        let start = 0;
        for (let end = data.indexOf(10); end !== -1; end = data.indexOf(10, start)) {
          const line = data.subarray(start, end);
          // A newline-delimited record is committed even when malformed: it
          // cannot become valid later and must not block the append cursor.
          parse(line);
          entry.offset += end - start + 1;
          start = end + 1;
        }
        pending = data.subarray(start);
      }
      // Providers occasionally finish a transcript without a trailing newline.
      // Only a complete JSON object may advance the committed byte offset.
      // Keep an unterminated partial record out of the committed size. A
      // provider may still be writing it; the next read must retry it.
      if (pending.length && parse(pending)) entry.offset += pending.length;
      entry.size = entry.offset;
      entry.mtimeMs = stat.mtimeMs;
      entry.prefix = await sample(Math.min(256, entry.offset), 0);
      entry.anchor = await sample(Math.min(128, entry.offset), Math.max(0, entry.offset - 128));
      return entry.state;
    } finally {
      await handle.close();
    }
  }
}
