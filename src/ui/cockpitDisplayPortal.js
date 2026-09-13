/** Move the existing Display groups between their two presentation surfaces. */
export class CockpitDisplayPortal {
  constructor({ standardPanel, cockpitPanel, groups, layout }) {
    this.standardPanel = standardPanel;
    this.cockpitPanel = cockpitPanel;
    this.layout = layout;
    this.active = false;
    this.destroyed = false;
    this.restoreOwner = null;
    this.generation = 0;
    this.frames = new Set();
    this.listeners = new AbortController();
    this.records = groups.flatMap(([name, group]) => {
      const slot = cockpitPanel?.querySelector(
        `[data-cockpit-display-slot="${name}"]`,
      );
      if (!group || !slot || !group.parentNode) return [];
      const anchor = document.createComment(`cockpit-display-home:${name}`);
      group.before(anchor);
      return [{ name, group, slot, anchor }];
    });
    this.standardScrollTop = standardPanel?.scrollTop || 0;
    this.cockpitScrollTop = cockpitPanel?.scrollTop || 0;
    const options = { passive: true, signal: this.listeners.signal };
    standardPanel?.addEventListener(
      'scroll',
      () => {
        if (!this.active) this.standardScrollTop = standardPanel.scrollTop;
      },
      options,
    );
    cockpitPanel?.addEventListener(
      'scroll',
      () => {
        if (this.active) this.cockpitScrollTop = cockpitPanel.scrollTop;
      },
      options,
    );
    window.addEventListener(
      'gev:cockpit-mode-changed',
      (event) => {
        this.setActive(event?.detail?.active === true);
      },
      { signal: this.listeners.signal },
    );
    this.setActive(document.body.classList.contains('cockpit-mode'));
  }

  _frame(generation, callback) {
    const frame = requestAnimationFrame(() => {
      this.frames.delete(frame);
      if (!this.destroyed && generation === this.generation) callback();
    });
    this.frames.add(frame);
  }

  _cancelFrames() {
    for (const frame of this.frames) cancelAnimationFrame(frame);
    this.frames.clear();
    this.generation += 1;
  }

  setActive(active, { settle = true } = {}) {
    if (this.destroyed) return;
    const nextActive = active === true;
    if (this.active === nextActive) return;
    this._cancelFrames();
    const generation = this.generation;
    const focusedRecord = this.records.find((record) =>
      record.group.contains(document.activeElement),
    );
    const focusedElement = focusedRecord ? document.activeElement : null;
    this.restoreOwner = nextActive ? 'cockpit' : 'standard';
    this.active = nextActive;
    for (const record of this.records) {
      if (nextActive) record.slot.append(record.group);
      else if (record.anchor.parentNode) record.anchor.after(record.group);
    }
    this.cockpitPanel?.classList.toggle(
      'uses-shared-display-controls',
      nextActive,
    );
    const restoreScroll = () => {
      if (nextActive && this.cockpitPanel)
        this.cockpitPanel.scrollTop = this.cockpitScrollTop;
      if (!nextActive && this.standardPanel)
        this.standardPanel.scrollTop = this.standardScrollTop;
    };
    if (!settle) {
      restoreScroll();
      this.restoreOwner = null;
      return;
    }
    this._frame(generation, () => {
      restoreScroll();
      focusedElement?.focus?.({ preventScroll: true });
      this._frame(generation, () => {
        restoreScroll();
        this.restoreOwner = null;
      });
    });
    this.layout();
  }

  destroy() {
    if (this.destroyed) return;
    this.setActive(false, { settle: false });
    this.destroyed = true;
    this._cancelFrames();
    this.listeners.abort();
    for (const record of this.records) record.anchor.remove();
    this.records = [];
    this.restoreOwner = null;
  }
}
