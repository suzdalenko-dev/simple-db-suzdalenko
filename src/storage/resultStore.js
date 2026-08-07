'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { normalizeRows } = require('../core/valueNormalizer');

class ResultStore {
  constructor(rootPath, options = {}) {
    this.rootPath = rootPath;
    this.pageSize = Math.max(1, Math.trunc(Number(options.pageSize || 500)));
    this.maxCellCharacters = Math.max(
      1,
      Math.trunc(Number(options.maxCellCharacters || 10000)),
    );
    this.executions = new Map();
    this.setStates = new Map();
  }

  configure(options = {}) {
    if (Number(options.pageSize) > 0) {
      this.pageSize = Math.max(1, Math.trunc(Number(options.pageSize)));
    }
    if (Number(options.maxCellCharacters) > 0) {
      this.maxCellCharacters = Math.max(
        1,
        Math.trunc(Number(options.maxCellCharacters)),
      );
    }
  }

  async initialize() {
    await fs.mkdir(this.rootPath, { recursive: true });
    const entries = await fs.readdir(this.rootPath, { withFileTypes: true });
    await Promise.all(
      entries.map((entry) =>
        fs.rm(path.join(this.rootPath, entry.name), {
          recursive: true,
          force: true,
        }),
      ),
    );
  }

  _executionPath(executionId) {
    return path.join(this.rootPath, executionId);
  }

  _setKey(executionId, setIndex) {
    return `${executionId}:${setIndex}`;
  }

  _setPath(executionId, setIndex) {
    return path.join(this._executionPath(executionId), `set-${setIndex}`);
  }

  async createExecution(executionId, metadata) {
    const execution = {
      id: executionId,
      createdAt: new Date().toISOString(),
      status: 'running',
      durationMs: 0,
      error: '',
      ...metadata,
      sets: [],
    };
    this.executions.set(executionId, execution);
    await fs.mkdir(this._executionPath(executionId), { recursive: true });
    return execution;
  }

  async startSet(executionId, setIndex, metadata = {}) {
    const execution = this.executions.get(executionId);
    if (!execution) {
      throw new Error(`Unknown result: ${executionId}`);
    }

    const columns = (metadata.columns || []).map((column, index) => ({
      name: String(column.name || `Column ${index + 1}`),
      type: String(column.type || ''),
      nullable: column.nullable,
    }));
    const setMetadata = {
      index: setIndex,
      statementIndex: Number(metadata.statementIndex || 0),
      kind: metadata.kind || (columns.length > 0 ? 'rows' : 'message'),
      columns,
      rowCount: 0,
      affectedRows: 0,
      pages: 0,
      truncated: false,
      durationMs: 0,
      message: metadata.message || '',
      sql: metadata.sql || '',
    };

    execution.sets[setIndex] = setMetadata;
    const state = {
      metadata: setMetadata,
      buffer: [],
      nextPage: 0,
    };
    this.setStates.set(this._setKey(executionId, setIndex), state);
    await fs.mkdir(this._setPath(executionId, setIndex), { recursive: true });
    return setMetadata;
  }

  async _flushPage(executionId, setIndex, state) {
    if (state.buffer.length === 0) {
      return;
    }

    const pageIndex = state.nextPage;
    const filename = path.join(
      this._setPath(executionId, setIndex),
      `page-${String(pageIndex).padStart(6, '0')}.json`,
    );
    const rows = state.buffer;
    state.buffer = [];
    await fs.writeFile(filename, JSON.stringify(rows), 'utf8');
    state.nextPage += 1;
    state.metadata.pages = state.nextPage;
  }

  async appendRows(executionId, setIndex, rows) {
    if (!rows || rows.length === 0) {
      return;
    }
    const state = this.setStates.get(this._setKey(executionId, setIndex));
    if (!state) {
      throw new Error(`Unknown result set: ${setIndex}`);
    }

    const normalized = normalizeRows(
      rows,
      state.metadata.columns,
      this.maxCellCharacters,
    );
    for (const row of normalized) {
      state.buffer.push(row);
      state.metadata.rowCount += 1;
      if (state.buffer.length >= this.pageSize) {
        await this._flushPage(executionId, setIndex, state);
      }
    }
  }

  async finishSet(executionId, setIndex, metadata = {}) {
    const state = this.setStates.get(this._setKey(executionId, setIndex));
    if (!state) {
      return;
    }
    await this._flushPage(executionId, setIndex, state);
    Object.assign(state.metadata, {
      affectedRows: Number(metadata.affectedRows || state.metadata.affectedRows || 0),
      truncated: Boolean(metadata.truncated),
      durationMs: Number(metadata.durationMs || state.metadata.durationMs || 0),
      message: metadata.message || state.metadata.message || '',
    });
    this.setStates.delete(this._setKey(executionId, setIndex));
  }

  async addMessageSet(executionId, setIndex, metadata = {}) {
    await this.startSet(executionId, setIndex, {
      ...metadata,
      columns: [],
      kind: metadata.kind || 'message',
    });
    await this.finishSet(executionId, setIndex, metadata);
  }

  async finalizeExecution(executionId, metadata = {}) {
    const execution = this.executions.get(executionId);
    if (!execution) {
      return null;
    }

    const pending = [...this.setStates.entries()].filter(([key]) =>
      key.startsWith(`${executionId}:`),
    );
    for (const [key] of pending) {
      const setIndex = Number(key.slice(key.lastIndexOf(':') + 1));
      await this.finishSet(executionId, setIndex);
    }

    Object.assign(execution, metadata);
    await fs.writeFile(
      path.join(this._executionPath(executionId), 'metadata.json'),
      JSON.stringify(execution, null, 2),
      'utf8',
    );
    return execution;
  }

  getMetadata(executionId) {
    const execution = this.executions.get(executionId);
    return execution ? JSON.parse(JSON.stringify(execution)) : null;
  }

  async getPage(executionId, setIndex, pageIndex) {
    const execution = this.executions.get(executionId);
    const set = execution?.sets?.[setIndex];
    if (!set || pageIndex < 0 || pageIndex >= set.pages) {
      return [];
    }
    const filename = path.join(
      this._setPath(executionId, setIndex),
      `page-${String(pageIndex).padStart(6, '0')}.json`,
    );
    return JSON.parse(await fs.readFile(filename, 'utf8'));
  }

  async *iterateRows(executionId, setIndex) {
    const execution = this.executions.get(executionId);
    const set = execution?.sets?.[setIndex];
    if (!set) {
      return;
    }
    for (let pageIndex = 0; pageIndex < set.pages; pageIndex += 1) {
      const rows = await this.getPage(executionId, setIndex, pageIndex);
      for (const row of rows) {
        yield row;
      }
    }
  }

  async deleteExecution(executionId) {
    this.executions.delete(executionId);
    for (const key of [...this.setStates.keys()]) {
      if (key.startsWith(`${executionId}:`)) {
        this.setStates.delete(key);
      }
    }
    await fs.rm(this._executionPath(executionId), { recursive: true, force: true });
  }

  async dispose() {
    for (const executionId of [...this.executions.keys()]) {
      await this.deleteExecution(executionId);
    }
  }
}

module.exports = {
  ResultStore,
};
