/**
 * Driven over CDP with Runtime.evaluate. Every helper resolves to a plain object so it
 * survives JSON serialisation. Installed in both the service worker and the control
 * page: the worker is invisible but goes dormant, the page stays alive.
 */
export function installApi(context) {
  globalThis.multiCdpMcp = {
    context,

    async listExtensions() {
      const all = await chrome.management.getAll();
      return all.map((item) => ({
        id: item.id,
        name: item.name,
        version: item.version,
        enabled: item.enabled,
        installType: item.installType,
        type: item.type,
        mayDisable: item.mayDisable,
      }));
    },

    async setEnabled(id, enabled) {
      try {
        await chrome.management.setEnabled(id, enabled);
        const info = await chrome.management.get(id);
        return { ok: true, id, enabled: info.enabled };
      } catch (error) {
        return { ok: false, id, error: String(error?.message ?? error) };
      }
    },

    async get(id) {
      try {
        const info = await chrome.management.get(id);
        return { ok: true, id, enabled: info.enabled, name: info.name };
      } catch (error) {
        return { ok: false, id, error: String(error?.message ?? error) };
      }
    },

    /** Disable then re-enable: the only in-place reload for a Web Store extension. */
    async reload(id) {
      const off = await this.setEnabled(id, false);
      if (!off.ok) return off;
      return await this.setEnabled(id, true);
    },
  };
}
