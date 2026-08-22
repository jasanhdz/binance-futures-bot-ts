import { closeSync, openSync, readSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';

const READ_BUFFER_BYTES = 64 * 1024;
const MAX_LINE_BYTES = 16 * 1024 * 1024;

export function forEachJsonlLine(path: string, consume: (line: string) => void): void {
  const descriptor = openSync(path, 'r');
  const buffer = Buffer.allocUnsafe(READ_BUFFER_BYTES);
  const decoder = new StringDecoder('utf8');
  let pending = '';
  try {
    let bytesRead: number;
    do {
      bytesRead = readSync(descriptor, buffer, 0, buffer.length, null);
      pending += decoder.write(buffer.subarray(0, bytesRead));
      let newline = pending.indexOf('\n');
      while (newline >= 0) {
        const line = pending.slice(0, newline);
        if (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES)
          throw new Error('PROSPECTIVE_JOURNAL_LINE_TOO_LARGE');
        if (line) consume(line);
        pending = pending.slice(newline + 1);
        newline = pending.indexOf('\n');
      }
      if (Buffer.byteLength(pending, 'utf8') > MAX_LINE_BYTES)
        throw new Error('PROSPECTIVE_JOURNAL_LINE_TOO_LARGE');
    } while (bytesRead > 0);
    pending += decoder.end();
    if (Buffer.byteLength(pending, 'utf8') > MAX_LINE_BYTES)
      throw new Error('PROSPECTIVE_JOURNAL_LINE_TOO_LARGE');
    if (pending) consume(pending);
  } finally {
    closeSync(descriptor);
  }
}
