/**
 * Incremental newline-delimited JSON reader.
 *
 * Stream chunks can split a record anywhere (including inside a multi-byte
 * UTF-8 sequence), so bytes are decoded with a streaming TextDecoder and only
 * complete lines are parsed. A malformed line is reported through `onBadLine`
 * and skipped; it never aborts the rest of the stream.
 */
export class JsonlReader {
  private buffer = '';
  private readonly decoder = new TextDecoder('utf-8');

  constructor(
    private readonly onRecord: (record: unknown) => void,
    private readonly onBadLine: (line: string, error: Error) => void = () => {},
    private readonly maxLineBytes = 64 * 1024 * 1024,
  ) {}

  push(chunk: Buffer | Uint8Array | string): void {
    this.buffer += typeof chunk === 'string' ? chunk : this.decoder.decode(chunk, { stream: true });
    let newline = this.buffer.indexOf('\n');
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      this.handleLine(line);
      newline = this.buffer.indexOf('\n');
    }
    if (this.buffer.length > this.maxLineBytes) {
      const dropped = this.buffer;
      this.buffer = '';
      this.onBadLine(dropped.slice(0, 200), new Error(`Line exceeded ${this.maxLineBytes} bytes and was dropped`));
    }
  }

  /** Flush a trailing record that was not newline-terminated (e.g. at process exit). */
  end(): void {
    this.buffer += this.decoder.decode();
    const rest = this.buffer;
    this.buffer = '';
    if (rest.trim()) this.handleLine(rest);
  }

  private handleLine(raw: string): void {
    const line = raw.replace(/\r$/, '').trim();
    if (!line) return;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch (err) {
      this.onBadLine(line.slice(0, 500), err as Error);
      return;
    }
    this.onRecord(record);
  }
}
