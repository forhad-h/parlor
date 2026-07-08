/**
 * File-based durable-log provider.
 *
 * Appends one JSON line per entry to a local file, rotating it once it
 * crosses `maxBytes` and keeping at most `maxFiles` rotated files (logrotate's
 * own convention: `maxFiles` counts rotated files only — `${file}.1` through
 * `${file}.${maxFiles}` — on top of the one active file).
 *
 * JSONL, not a JSON array: appendable without a rewrite, and crash-safe (one
 * bad line ≠ a corrupt file).
 *
 * Flat files don't survive a redeploy or restart on an ephemeral filesystem —
 * that's the concrete reason a future durable-store provider (e.g. object
 * storage) would get added later as an additive case in log/index.js; no
 * such dependency is added now.
 */
import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../logging/logger.js';

export class FileDurableLogProvider {
  constructor({ dir, file, maxBytes, maxFiles }) {
    this.name = 'file';
    this.filePath = path.join(dir, file);
    this.maxBytes = maxBytes;
    this.maxFiles = maxFiles;
    this.disabled = false;
    this._queue = Promise.resolve();

    try {
      fs.mkdirSync(dir, { recursive: true });
      this.currentBytes = fs.existsSync(this.filePath) ? fs.statSync(this.filePath).size : 0;
    } catch (err) {
      logger.error('durable log directory unwritable, disabling durable persistence', {
        dir,
        error: err.message,
      });
      this.disabled = true;
    }
  }

  async write(entry) {
    if (this.disabled) return;
    // Chained onto one queue so concurrent /converse requests can't both
    // decide "not yet over threshold" and race each other into a double
    // rotation — a single-process assumption already made by session/history.js.
    this._queue = this._queue.then(() => this._append(entry)).catch((err) => {
      logger.error('durable log write failed', { error: err.message });
    });
    return this._queue;
  }

  async _append(entry) {
    const line = `${JSON.stringify(entry)}\n`;
    const bytes = Buffer.byteLength(line);
    if (this.currentBytes + bytes > this.maxBytes) {
      this._rotate();
    }
    await fs.promises.appendFile(this.filePath, line);
    this.currentBytes += bytes;
  }

  _rotate() {
    const oldest = `${this.filePath}.${this.maxFiles}`;
    if (fs.existsSync(oldest)) fs.rmSync(oldest);
    for (let i = this.maxFiles - 1; i >= 1; i -= 1) {
      const src = `${this.filePath}.${i}`;
      if (fs.existsSync(src)) fs.renameSync(src, `${this.filePath}.${i + 1}`);
    }
    if (fs.existsSync(this.filePath)) fs.renameSync(this.filePath, `${this.filePath}.1`);
    this.currentBytes = 0;
  }
}
