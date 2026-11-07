import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { nowIso } from '../util.js';

/**
 * Tiny JSON-file store. Node runs request handlers on one thread, so state is
 * mutated in memory synchronously and persisted with serialized atomic writes
 * (write to a temp file, then rename). Good enough for a demo; swap for a real
 * database by re-implementing this module's small interface.
 */
class JsonStore {
  constructor(file) {
    this.file = file;
    this.data = null;
    this.writing = Promise.resolve();
    this.dirty = false;
  }

  async init() {
    try {
      this.data = JSON.parse(await fs.readFile(this.file, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') console.warn(`[store] Could not read ${this.file}, starting fresh: ${error.message}`);
      this.data = {};
    }
    this.data.version ??= 1;
    this.data.workspaces ??= {};
    this.data.index ??= {};
    await fs.mkdir(path.dirname(this.file), { recursive: true });
  }

  workspace(id) {
    const ws = (this.data.workspaces[id] ??= { createdAt: nowIso(), agreements: {} });
    ws.seenAt = nowIso();
    return ws;
  }

  /** Maps a PayPal object id (order, authorization, invoice) back to its milestone. */
  link(paypalId, ref) {
    if (paypalId) this.data.index[paypalId] = ref;
  }

  lookup(paypalId) {
    return paypalId ? this.data.index[paypalId] ?? null : null;
  }

  resolve(ref) {
    if (!ref) return null;
    const agreement = this.data.workspaces[ref.ws]?.agreements?.[ref.agreementId];
    const milestone = agreement?.milestones.find((m) => m.id === ref.milestoneId);
    return agreement && milestone ? { agreement, milestone } : null;
  }

  save() {
    if (this.dirty) return this.writing;
    this.dirty = true;
    this.writing = this.writing.then(async () => {
      this.dirty = false;
      const tmp = `${this.file}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(this.data));
      await fs.rename(tmp, this.file);
    }).catch((error) => console.error('[store] Write failed:', error.message));
    return this.writing;
  }
}

export const store = new JsonStore(config.dataFile);
