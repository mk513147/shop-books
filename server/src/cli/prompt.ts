import { createInterface } from 'node:readline';

/**
 * Line-based prompter over stdin. Hidden prompts switch an interactive terminal to raw mode so
 * the typed characters are never echoed. When stdin is not a terminal (piped input) nothing is
 * echoed either, since the input never reaches the screen.
 */
export class Prompter {
  private readonly lines: string[] = [];
  private readonly waiters: ((line: string | null) => void)[] = [];
  private closed = false;
  private readonly rl;

  constructor(private readonly input: NodeJS.ReadStream = process.stdin) {
    this.rl = input.isTTY ? null : createInterface({ input, terminal: false });
    this.rl?.on('line', (line) => this.push(line));
    this.rl?.on('close', () => {
      this.closed = true;
      while (this.waiters.length) this.waiters.shift()!(null);
    });
  }

  private push(line: string): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter(line);
    else this.lines.push(line);
  }

  private nextPipedLine(): Promise<string | null> {
    if (this.lines.length) return Promise.resolve(this.lines.shift()!);
    if (this.closed) return Promise.resolve(null);
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  async ask(question: string, hidden = false): Promise<string> {
    process.stdout.write(question);
    if (!this.input.isTTY) {
      const line = await this.nextPipedLine();
      process.stdout.write('\n');
      if (line === null) throw new Error('Input ended before all answers were given');
      return line;
    }
    return hidden ? this.readHidden() : this.readVisible();
  }

  private readVisible(): Promise<string> {
    return new Promise((resolve) => {
      const rl = createInterface({ input: this.input, output: process.stdout, terminal: true });
      rl.once('line', (line) => {
        rl.close();
        resolve(line);
      });
    });
  }

  private readHidden(): Promise<string> {
    const input = this.input;
    return new Promise((resolve, reject) => {
      let value = '';
      input.setRawMode(true);
      input.resume();
      input.setEncoding('utf8');
      const finish = (error?: Error) => {
        input.setRawMode(false);
        input.pause();
        input.removeListener('data', onData);
        process.stdout.write('\n');
        if (error) reject(error);
        else resolve(value);
      };
      const onData = (chunk: string) => {
        for (const char of chunk) {
          if (char === '\r' || char === '\n') return finish();
          if (char === '\u0003') return finish(new Error('Cancelled'));
          if (char === '\u0008' || char === '\u007f') value = value.slice(0, -1);
          else if (char >= ' ') value += char;
        }
      };
      input.on('data', onData);
    });
  }

  close(): void {
    this.rl?.close();
  }
}
