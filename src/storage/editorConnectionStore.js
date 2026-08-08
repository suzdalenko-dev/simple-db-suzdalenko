'use strict';

const EDITOR_CONNECTIONS_KEY = 'simpleDb.editorConnections.v1';

class EditorConnectionStore {
  constructor(state) {
    this.state = state;
  }

  _all() {
    const stored = this.state.get(EDITOR_CONNECTIONS_KEY, {});
    return stored && typeof stored === 'object' && !Array.isArray(stored)
      ? { ...stored }
      : {};
  }

  get(documentUri) {
    const binding = this._all()[String(documentUri)];
    return binding && typeof binding === 'object' ? { ...binding } : undefined;
  }

  async set(documentUri, binding) {
    const key = String(documentUri);
    const all = this._all();
    all[key] = {
      profileId: String(binding.profileId),
      database: String(binding.database || ''),
      schema: String(binding.schema || ''),
    };
    await this.state.update(EDITOR_CONNECTIONS_KEY, all);
  }

  async delete(documentUri) {
    const key = String(documentUri);
    const all = this._all();
    if (!Object.hasOwn(all, key)) return;
    delete all[key];
    await this.state.update(EDITOR_CONNECTIONS_KEY, all);
  }

  async deleteProfile(profileId) {
    const all = this._all();
    let changed = false;
    for (const [key, binding] of Object.entries(all)) {
      if (binding?.profileId === profileId) {
        delete all[key];
        changed = true;
      }
    }
    if (changed) await this.state.update(EDITOR_CONNECTIONS_KEY, all);
  }
}

module.exports = {
  EDITOR_CONNECTIONS_KEY,
  EditorConnectionStore,
};
