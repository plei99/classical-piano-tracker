/**
 * Line-oriented prompt input over an injectable stream: the equivalent of
 * Go's `bufio.Reader.ReadString('\n')`.
 */
import type { Readable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';

/** One line read, and whether input ended before a newline (Go's io.EOF). */
export interface Line {
  /** The text including its trailing newline, if any. */
  text: string;
  eof: boolean;
}

/**
 * Buffers input like bufio.Reader, but only pulls from the stream while a
 * read is pending. That leaves stdin alone between prompts, so an Ink picker
 * can take it over in raw mode and hand it back afterwards.
 */
export class LineReader {
  private buffer = '';
  private ended = false;
  private readonly decoder = new StringDecoder('utf8');

  constructor(private readonly input: Readable) {}

  async readLine(): Promise<Line> {
    for (;;) {
      const newline = this.buffer.indexOf('\n');
      if (newline !== -1) {
        const text = this.buffer.slice(0, newline + 1);
        this.buffer = this.buffer.slice(newline + 1);
        return { text, eof: false };
      }
      if (this.ended) {
        const text = this.buffer;
        this.buffer = '';
        return { text, eof: true };
      }
      await this.fill();
    }
  }

  /** Waits for at least one chunk, or the end of input. */
  private fill(): Promise<void> {
    const input = this.input;
    const chunk: unknown = input.read();
    if (chunk !== null) {
      this.append(chunk);
      return Promise.resolve();
    }
    if (input.readableEnded || input.destroyed) {
      this.finish();
      return Promise.resolve();
    }
    // An Ink picker unrefs stdin when it exits; a pending prompt must keep
    // the process alive until the user answers.
    (input as Readable & { ref?: () => void }).ref?.();
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        input.off('readable', onReadable);
        input.off('end', onEnd);
        input.off('close', onEnd);
        input.off('error', onError);
      };
      const onReadable = () => {
        cleanup();
        resolve();
      };
      const onEnd = () => {
        cleanup();
        this.finish();
        resolve();
      };
      const onError = (err: Error) => {
        cleanup();
        reject(err);
      };
      input.on('readable', onReadable);
      input.on('end', onEnd);
      input.on('close', onEnd);
      input.on('error', onError);
    });
  }

  private append(chunk: unknown): void {
    this.buffer += chunk instanceof Uint8Array ? this.decoder.write(chunk) : String(chunk);
  }

  private finish(): void {
    this.ended = true;
    this.buffer += this.decoder.end();
  }
}
