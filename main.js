'use strict';

const {
  Plugin,
  PluginSettingTab,
  Setting,
  FuzzySuggestModal,
  Notice,
} = require('obsidian');

const DEFAULT_SETTINGS = {
  timezone: '', // '' = system timezone
  recent: [],
  statusBar: true,
  dateFormat: '', // moment format for the `L` token; '' = locale default
  timeFormat: '', // moment format for the `LT` token; '' = locale default
};

const RECENT_LIMIT = 6;
const MOMENT_DOCS = 'https://momentjs.com/docs/#/displaying/format/';

function electronRemote() {
  try {
    return (window.electron && window.electron.remote) || require('electron').remote;
  } catch (e) {
    return null;
  }
}

function isValidZone(tz) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch (e) {
    return false;
  }
}

function zoneOffset(tz, date = new Date()) {
  try {
    const part = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'shortOffset' })
      .formatToParts(date)
      .find((p) => p.type === 'timeZoneName');
    return part ? part.value : '';
  } catch (e) {
    return '';
  }
}

function zoneCity(tz) {
  const parts = tz.split('/');
  return parts[parts.length - 1].replace(/_/g, ' ');
}

function allZones() {
  let list = [];
  try {
    list = Intl.supportedValuesOf('timeZone');
  } catch (e) {
    // very old runtime: the picker still offers system, UTC and recent zones
  }
  return list.includes('UTC') ? list : ['UTC', ...list];
}

module.exports = class TzFormatPlugin extends Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.unloading = false;
    this.weAttached = false;
    this.overrideActive = false;

    const remote = electronRemote();
    this.dbg = remote ? remote.getCurrentWebContents().debugger : null;

    // Anyone detaching the debugger (e.g. `obsidian dev:debug off`) drops the override with it.
    this.onDetach = () => {
      this.weAttached = false;
      this.overrideActive = false;
      if (this.unloading || !this.settings.timezone) return;
      window.setTimeout(async () => {
        if (this.unloading) return;
        await this.applyTimezone();
        this.refreshViews(false);
      }, 250);
    };
    if (this.dbg) this.dbg.on('detach', this.onDetach);

    this.systemZone = await this.detectSystemZone();

    this.captureLocale();
    this.applyFormats();
    await this.applyTimezone();

    this.statusEl = this.addStatusBarItem();
    this.statusEl.addClass('mod-clickable', 'tzf-status');
    this.statusEl.setAttr('data-tooltip-position', 'top');
    this.registerDomEvent(this.statusEl, 'click', () => new ZoneModal(this).open());
    this.updateStatusBar();

    this.addCommand({
      id: 'choose-timezone',
      name: 'Choose working timezone',
      callback: () => new ZoneModal(this).open(),
    });
    this.addCommand({
      id: 'reset-timezone',
      name: 'Use system timezone',
      callback: () => this.setZone(''),
    });

    this.addSettingTab(new TzFormatSettingTab(this.app, this));

    // Views restored before the plugin loaded were drawn in the system timezone.
    this.app.workspace.onLayoutReady(() => this.refreshViews(false));
  }

  onunload() {
    this.unloading = true;
    if (this.dbg) this.dbg.removeListener('detach', this.onDetach);
    this.clearTimezone();
    this.restoreFormats();
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  // ---------- timezone ----------

  async detectSystemZone() {
    // After a window reload the debugger may still carry an old override.
    if (this.dbg && this.dbg.isAttached()) {
      await this.dbg
        .sendCommand('Emulation.setTimezoneOverride', { timezoneId: '' })
        .catch(() => {});
    }
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  }

  async applyTimezone() {
    const tz = this.settings.timezone;
    try {
      if (!tz) {
        await this.clearTimezone();
      } else if (!this.dbg) {
        new Notice('Timezone override is available in the desktop app only.');
      } else if (!isValidZone(tz)) {
        new Notice(`Unknown timezone: ${tz}`);
      } else {
        if (!this.dbg.isAttached()) {
          this.dbg.attach('1.3');
          this.weAttached = true;
        }
        await this.dbg.sendCommand('Emulation.setTimezoneOverride', { timezoneId: tz });
        this.overrideActive = true;
      }
    } catch (e) {
      console.error('[tz-format] timezone override failed', e);
      new Notice(`Could not switch timezone: ${e.message || e}`);
    }
    this.updateStatusBar();
  }

  async clearTimezone() {
    if (!this.dbg || !this.dbg.isAttached()) {
      this.overrideActive = false;
      return;
    }
    if (this.overrideActive) {
      await this.dbg
        .sendCommand('Emulation.setTimezoneOverride', { timezoneId: '' })
        .catch(() => {});
    }
    this.overrideActive = false;
    if (this.weAttached) {
      this.weAttached = false;
      try {
        this.dbg.detach();
      } catch (e) {
        // already detached
      }
    }
  }

  async setZone(tz) {
    this.settings.timezone = tz;
    if (tz) {
      this.settings.recent = [tz, ...this.settings.recent.filter((z) => z !== tz)].slice(
        0,
        RECENT_LIMIT
      );
    }
    await this.saveSettings();
    await this.applyTimezone();
    this.refreshViews(true);
    const shown = tz || this.systemZone;
    new Notice(`Working timezone: ${tz ? '' : 'system, '}${shown} (${zoneOffset(shown)})`);
  }

  updateStatusBar() {
    if (!this.statusEl) return;
    this.statusEl.toggle(this.settings.statusBar);
    const tz = this.settings.timezone || this.systemZone;
    this.statusEl.setText(`${zoneCity(tz)} ${zoneOffset(tz)}`);
    this.statusEl.toggleClass('tzf-system', !this.settings.timezone);
    this.statusEl.setAttr(
      'aria-label',
      `${this.settings.timezone ? 'Working' : 'System'} timezone: ${tz}\nClick to change`
    );
  }

  // ---------- date formats ----------

  captureLocale() {
    const m = window.moment;
    this.localeName = m.locale();
    const ld = m.localeData(this.localeName);
    this.origFormats = { L: ld.longDateFormat('L'), LT: ld.longDateFormat('LT') };
  }

  setLocaleFormats(L, LT) {
    const m = window.moment;
    const ld = m.localeData(this.localeName);
    if (ld.longDateFormat('L') === L && ld.longDateFormat('LT') === LT) return;
    // `l` is cached from `L` inside the locale; drop it so it is derived again.
    m.updateLocale(this.localeName, { longDateFormat: { L, LT, l: undefined } });
  }

  applyFormats() {
    this.setLocaleFormats(
      this.settings.dateFormat.trim() || this.origFormats.L,
      this.settings.timeFormat.trim() || this.origFormats.LT
    );
  }

  restoreFormats() {
    if (this.origFormats) this.setLocaleFormats(this.origFormats.L, this.origFormats.LT);
  }

  // ---------- views ----------

  // full = also rebuild editing-mode notes, so embedded bases and Tasks queries redraw
  // (this drops the undo history of those tabs; used only on an explicit switch).
  refreshViews(full) {
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (leaf.isDeferred) return;
      const view = leaf.view;
      const type = view && view.getViewType();
      try {
        if (type === 'bases') {
          leaf.rebuildView();
        } else if (type === 'markdown') {
          if (view.getMode() === 'preview') view.previewMode.rerender(true);
          else if (full) leaf.rebuildView();
        }
      } catch (e) {
        console.warn('[tz-format] could not refresh view', type, e);
      }
    });
  }
};

class ZoneModal extends FuzzySuggestModal {
  constructor(plugin, onDone) {
    super(plugin.app);
    this.plugin = plugin;
    this.onDone = onDone;
    this.setPlaceholder('Working timezone: type a city, region or GMT offset');
    this.items = this.buildItems();
  }

  buildItems() {
    const { settings, systemZone } = this.plugin;
    const now = new Date();
    const recent = settings.recent.filter(isValidZone);
    const items = [
      { id: '', label: `System (${systemZone.replace(/_/g, ' ')})`, offset: zoneOffset(systemZone, now) },
    ];
    const seen = new Set();
    for (const z of [...recent, ...allZones()]) {
      if (seen.has(z)) continue;
      seen.add(z);
      items.push({
        id: z,
        label: z.replace(/_/g, ' '),
        offset: zoneOffset(z, now),
        recent: recent.includes(z),
      });
    }
    return items;
  }

  getItems() {
    return this.items;
  }

  getItemText(item) {
    return `${item.label}  ${item.offset}`;
  }

  renderSuggestion(match, el) {
    super.renderSuggestion(match, el);
    const item = match.item;
    let flair = '';
    if (item.id === this.plugin.settings.timezone) flair = 'current';
    else if (item.recent) flair = 'recent';
    if (flair) el.createSpan({ cls: 'tzf-flair', text: flair });
  }

  onChooseItem(item) {
    this.plugin.setZone(item.id).then(() => this.onDone && this.onDone());
  }
}

class TzFormatSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
    this.formatsChanged = false;
  }

  display() {
    const { containerEl, plugin } = this;
    const { settings } = plugin;
    containerEl.empty();

    // ----- timezone -----
    new Setting(containerEl).setName('Timezone').setHeading();

    const tz = settings.timezone;
    new Setting(containerEl)
      .setName('Working timezone')
      .setDesc(
        'Obsidian treats this as local time: Bases, Tasks, daily notes, templates, Dataview. ' +
          'File timestamps on disk stay as they are; only how they are read changes.'
      )
      .addButton((b) =>
        b
          .setButtonText(
            tz ? `${tz.replace(/_/g, ' ')}  ${zoneOffset(tz)}` : `System: ${plugin.systemZone.replace(/_/g, ' ')}`
          )
          .onClick(() => new ZoneModal(plugin, () => this.display()).open())
      )
      .addExtraButton((b) =>
        b
          .setIcon('rotate-ccw')
          .setTooltip('Use system timezone')
          .setDisabled(!tz)
          .onClick(async () => {
            await plugin.setZone('');
            this.display();
          })
      );

    new Setting(containerEl)
      .setName('Show in status bar')
      .setDesc('City and GMT offset; click it to switch.')
      .addToggle((t) =>
        t.setValue(settings.statusBar).onChange(async (v) => {
          settings.statusBar = v;
          plugin.updateStatusBar();
          await plugin.saveSettings();
        })
      );

    // ----- formats -----
    new Setting(containerEl)
      .setName('Date display')
      .setDesc(
        createFragment((f) => {
          f.appendText('Formats for the locale tokens L and LT, used by Bases and other places that show dates "the system way". ');
          f.createEl('a', { text: 'Moment format syntax', href: MOMENT_DOCS });
          f.appendText('. Leave empty for the locale default.');
        })
      )
      .setHeading();

    const preview = new Setting(containerEl).setName('Preview');
    const renderPreview = () => {
      const m = window.moment;
      preview.setDesc(`Date: ${m().format('L')}    Date and time: ${m().format('L LT')}`);
    };

    const formatSetting = (name, key, token) =>
      new Setting(containerEl)
        .setName(name)
        .setDesc(`Token ${token}. Locale default: ${plugin.origFormats[token]}`)
        .addText((t) =>
          t
            .setPlaceholder(plugin.origFormats[token])
            .setValue(settings[key])
            .onChange(async (v) => {
              settings[key] = v;
              plugin.applyFormats();
              this.formatsChanged = true;
              renderPreview();
              await plugin.saveSettings();
            })
        );

    formatSetting('Date', 'dateFormat', 'L');
    formatSetting('Time', 'timeFormat', 'LT');
    containerEl.appendChild(preview.settingEl); // keep preview under the inputs
    renderPreview();
  }

  hide() {
    if (this.formatsChanged) {
      this.formatsChanged = false;
      this.plugin.refreshViews(false);
    }
  }
}
