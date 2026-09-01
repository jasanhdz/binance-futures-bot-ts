"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.forEachJsonlLine = forEachJsonlLine;
const node_fs_1 = require("node:fs");
const node_string_decoder_1 = require("node:string_decoder");
const READ_BUFFER_BYTES = 64 * 1024;
const MAX_LINE_BYTES = 16 * 1024 * 1024;
function forEachJsonlLine(path, consume) {
    const descriptor = (0, node_fs_1.openSync)(path, 'r');
    const buffer = Buffer.allocUnsafe(READ_BUFFER_BYTES);
    const decoder = new node_string_decoder_1.StringDecoder('utf8');
    let pending = '';
    try {
        let bytesRead;
        do {
            bytesRead = (0, node_fs_1.readSync)(descriptor, buffer, 0, buffer.length, null);
            pending += decoder.write(buffer.subarray(0, bytesRead));
            let newline = pending.indexOf('\n');
            while (newline >= 0) {
                const line = pending.slice(0, newline);
                if (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES)
                    throw new Error('PROSPECTIVE_JOURNAL_LINE_TOO_LARGE');
                if (line)
                    consume(line);
                pending = pending.slice(newline + 1);
                newline = pending.indexOf('\n');
            }
            if (Buffer.byteLength(pending, 'utf8') > MAX_LINE_BYTES)
                throw new Error('PROSPECTIVE_JOURNAL_LINE_TOO_LARGE');
        } while (bytesRead > 0);
        pending += decoder.end();
        if (Buffer.byteLength(pending, 'utf8') > MAX_LINE_BYTES)
            throw new Error('PROSPECTIVE_JOURNAL_LINE_TOO_LARGE');
        if (pending)
            consume(pending);
    }
    finally {
        (0, node_fs_1.closeSync)(descriptor);
    }
}
