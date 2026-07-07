/**
 * No-op durable-log provider.
 *
 * Default-off / test provider — mirrors llm/mockProvider.js in spirit. Lets a
 * deployment opt out of durable persistence entirely (e.g. a read-only
 * filesystem) without any conditional in the shared factory.
 */
export class NoneDurableLogProvider {
  constructor() {
    this.name = 'none';
  }

  async write() {
    // Intentionally does nothing.
  }
}
