/**
 * Test Mocks — consolidated test utilities.
 *
 * Encapsulates: MockKV for consistent KV testing across test suites.
 */

export class MockKV {
  private store = new Map<string, string>();

  async get(key: string, type?: 'json' | 'text'): Promise<any> {
    const raw = this.store.get(key);
    if (raw == null) return null;
    if (type === 'json') {
      return JSON.parse(raw);
    }
    return raw;
  }

  async put(key: string, value: string, _opts?: { expirationTtl?: number }): Promise<void> {
    this.store.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  async list(_opts?: { prefix?: string; limit?: number; cursor?: string }): Promise<{
    keys: Array<{ name: string }>;
    list_complete: boolean;
    cursor: string;
  }> {
    return {
      keys: [],
      list_complete: true,
      cursor: '',
    };
  }
}
