"use strict";
// License: MIT

import { VirtualTable } from "../../uikit/lib/table";
import {
  ContextMenu,
  MenuItem,
  // eslint-disable-next-line no-unused-vars
  SubMenuItem
} from "../../uikit/lib/contextmenu";
import { iconForPath } from "../../lib/windowutils";
import { formatSpeed, formatSize, formatTimeDelta } from "../../lib/formatters";
import { filters } from "../../lib/filters";
import { _, localize } from "../../lib/i18n";
import { EventEmitter } from "../../lib/events";
import { Prefs, PrefWatcher } from "../../lib/prefs";
// eslint-disable-next-line no-unused-vars
import { debounce, URLd } from "../../lib/util";
import { Keys } from "../keys";
import { Broadcaster } from "../broadcaster";
import { Icons } from "../icons";
import { Buttons } from "./buttons";
import {
  TextFilter, UrlMenuFilter, StateMenuFilter, SizeMenuFilter,
  // eslint-disable-next-line no-unused-vars
  MenuFilter
} from "./itemfilters";
import { FilteredCollection } from "./itemfilters";
import RemovalModalDialog from "./removaldlg";
import { Stats } from "./stats";
import PORT from "./port";
import { DownloadState, StateTexts, StateClasses, StateIcons } from "./state";
import { Tooltip } from "./tooltip";
import "../../lib/util";
import { CellTypes } from "../../uikit/lib/constants";
import { downloads } from "../../lib/browser";

const TREE_CONFIG_VERSION = 2;
const RUNNING_TIMEOUT = 1000;

const COL_URL = 0;
const COL_DOMAIN = 1;
const COL_PROGRESS = 2;
const COL_PER = 3;
const COL_SIZE = 4;
const COL_ETA = 5;
const COL_SPEED = 6;
const COL_MASK = 7;
const COL_SEGS = 8;

const ICON_BASE_SIZE = 16;

const TEXT_SIZE_UNKNOWM = _("size-unknown");

const $ = document.querySelector.bind(document);

const prettyNumber = (function() {
const rv = new Intl.NumberFormat(undefined, {
  style: "decimal",
  useGrouping: true,
  minimumFractionDigits: 0,
  maximumFractionDigits: 0
});
return rv.format.bind(rv);
})();

class ShowUrlsWatcher extends PrefWatcher {
  private readonly table: DownloadTable;

  constructor(table: DownloadTable) {
    super("show-urls", false);
    this.table = table;
  }

  changed(prefs: any, name: string, value: any) {
    const rv = super.changed(prefs, name, value);
    this.table.invalidate();
    return rv;
  }
}

export class DownloadItem extends EventEmitter {
  public readonly stats: Stats;

  public readonly owner: DownloadTable;

  private lastWritten: number;

  public state: number;

  public totalSize: number;

  public written: number;

  public domain: string;

  public usable: string;

  public description: string;

  public error: string;

  public finalName: string;

  public position: number;

  public filteredPosition: number;

  public manId: number;

  public url: string;

  public uURL: URLd;

  public destFull: string;

  public startDate: number;

  public sessionId: number;

  public batch: number;

  public mask: string;

  constructor(owner: DownloadTable, raw: any, stats?: Stats) {
    super();
    Object.assign(this, raw);
    this.updateURL();
    this.stats = stats || new Stats();
    this.owner = owner;
    this.owner.updatedState(this, undefined, this.state);
    this.lastWritten = 0;
  }

  get eta() {
    const {avg} = this.stats;
    if (!this.totalSize || !avg) {
      return TEXT_SIZE_UNKNOWM;
    }
    const remain = this.totalSize - this.written;
    return formatTimeDelta(remain / avg);
  }

  get isFiltered() {
    return typeof this.filteredPosition !== "undefined";
  }

  get percent() {
    if (this.state === DownloadState.DONE) {
      return 1;
    }
    if (!this.totalSize) {
      return 0;
    }
    return this.written / this.totalSize;
  }

  get fmtName() {
    if (this.owner.showUrls.value) {
      return this.usable;
    }
    return this.finalName;
  }

  get fmtSize() {
    if (this.state & (DownloadState.RUNNING | DownloadState.PAUSED)) {
      if (!this.written) {
        return TEXT_SIZE_UNKNOWM;
      }
      if (!this.totalSize) {
        return formatSize(this.written);
      }
      return _("size-progress",
        formatSize(this.written), formatSize(this.totalSize));
    }
    if (!this.totalSize) {
      return TEXT_SIZE_UNKNOWM;
    }
    return formatSize(this.totalSize);
  }

  get fmtPercent() {
    return `${(this.percent * 100).toFixed(0)}%`;
  }

  get fmtETA() {
    if (this.state === DownloadState.RUNNING) {
      return this.eta;
    }
    if (this.error) {
      return this.error;
    }
    return StateTexts.get(this.state);
  }

  get fmtSpeed() {
    return this.state === DownloadState.RUNNING ?
      formatSpeed(this.stats.avg) :
      "";
  }

  get fmtDomain() {
    return this.domain;
  }

  updateDownload(raw: any) {
    if (("position" in raw) && raw.position !== this.position) {
      console.warn("position mismatch", raw.position, this.position);
      PORT.post("all");
      return;
    }
    delete raw.position;
    delete raw.owner;
    const oldState = this.state;
    Object.assign(this, raw);
    if (raw.url) {
      this.updateURL();
    }
    if (this.state !== oldState) {
      this.stats.clear();
      this.owner.updatedState(this, oldState, this.state);
    }
    this.owner.updatedDownload(this);
    this.emit("update");
  }

  adoptSize(state: any) {
    const {
      bytesReceived,
      totalBytes,
      fileSize
    } = state;
    this.written = Math.max(0, bytesReceived);
    this.totalSize = Math.max(0, fileSize >= 0 ? fileSize : totalBytes);
  }

  async updateStats() {
    if (this.state !== DownloadState.RUNNING) {
      return -1;
    }
    let v = 0;
    try {
      if (this.manId) {
        this.adoptSize((await downloads.search({id: this.manId})).pop());
        if (!this.lastWritten) {
          this.lastWritten = Math.max(0, this.written);
          return -1;
        }
        v = Math.max(0, this.written - this.lastWritten);
        this.lastWritten = Math.max(0, this.written);
      }
    }
    catch (ex) {
      console.error("failed to stat", ex);
    }
    this.stats.add(v);
    if (this.isFiltered) {
      this.owner.invalidateRow(this.filteredPosition);
    }
    this.emit("stats");
    return this.stats.avg;
  }

  updateURL() {
    this.uURL = new URL(this.url) as URLd;
    this.domain = this.uURL.domain;
    this.emit("url");
  }
}


export class DownloadTable extends VirtualTable {
  private finished: number;

  private readonly resumeAction: Broadcaster;

  private readonly pauseAction: Broadcaster;

  private readonly cancelAction: Broadcaster;

  private readonly running: Set<DownloadItem>;

  public readonly showUrls: ShowUrlsWatcher;

  private runningTimer: any;

  private readonly globalStats: Stats;

  private readonly downloads: FilteredCollection;

  private readonly sids: Map<number, DownloadItem>;

  private readonly icons: Icons;

  private readonly contextMenu: ContextMenu;

  private readonly forceAction: Broadcaster;

  private readonly openFileAction: Broadcaster;

  private readonly openDirectoryAction: any;

  private readonly moveTopAction: Broadcaster;

  private readonly moveUpAction: Broadcaster;

  private readonly moveDownAction: Broadcaster;

  private readonly moveBottomAction: Broadcaster;

  private readonly disableSet: Set<any>;

  private tooltip: Tooltip | null;

  constructor(treeConfig: any) {
    super("#items", treeConfig, TREE_CONFIG_VERSION);

    this.finished = 0;
    this.running = new Set();
    this.runningTimer = null;
    this.globalStats = new Stats();
    this.showUrls = new ShowUrlsWatcher(this);

    this.updateCounts = debounce(this.updateCounts.bind(this), 100);

    this.downloads = new FilteredCollection(this);
    this.downloads.on("changed", () => this.updateCounts());
    this.downloads.on("added", () => this.updateCounts());
    this.downloads.on("sorted", () => {
      PORT.post("sorted", {sids: this.downloads.items.map(i => i.sessionId)});
    });

    this.updateCounts();

    new TextFilter(this.downloads);
    const menufilters = new Map<string, MenuFilter>([
      ["colURL", new UrlMenuFilter(this.downloads)],
      ["colETA", new StateMenuFilter(this.downloads)],
      ["colSize", new SizeMenuFilter(this.downloads)],
    ]);
    this.on("column-clicked", (id, evt, col) => {
      const mf = menufilters.get(id);
      const {left, bottom} = col.elem.getBoundingClientRect();
      if (!mf) {
        return undefined;
      }
      mf.show({clientX: left, clientY: bottom});
      return true;
    });
    const filterforColumn = new Map(Array.from(
      menufilters.entries()).map(([col, f]) => [f.id, col]));
    this.downloads.on("filter-active", filter => {
      const name = filterforColumn.get(filter);
      if (!name) {
        return;
      }
      const col = this.getColumnByName(name);
      if (!col) {
        return;
      }
      col.iconElem.classList.add("icon-filter");
    });
    this.downloads.on("filter-inactive", filter => {
      const name = filterforColumn.get(filter);
      if (!name) {
        return;
      }
      const col = this.getColumnByName(name);
      if (!col) {
        return;
      }
      col.iconElem.classList.remove("icon-filter");
    });

    this.sids = new Map<number, DownloadItem>();
    this.icons = new Icons($("#icons"));

    localize($("#table-context").content);
    const ctx = this.contextMenu = new ContextMenu("#table-context");
    Keys.adoptContext(ctx);
    Keys.adoptButtons($("#toolbar"));

    this.on("config-changed", () => {
      Prefs.set("tree-config-manager", JSON.stringify(this));
    });

    Keys.on("ACCEL-KeyA", (event: Event) => {
      const target = event.target as HTMLElement;
      if (target.localName === "input") {
        return false;
      }
      this.selectAll();
      return true;
    });

    Keys.on("ACCEL-KeyI", () => {
      this.selectToggle();
      return true;
    });

    Keys.on("Delete", (event: Event) => {
      const target = event.target as HTMLElement;
      if (target.localName === "input") {
        return false;
      }
      this.removeDownloads();
      return true;
    });

    Keys.on("ALT-Delete", (event: Event) => {
      const target = event.target as HTMLElement;
      if (target.localName === "input") {
        return false;
      }
      this.removeMissingDownloads();
      return true;
    });

    ctx.on("ctx-remove-all", () => this.removeAllDownloads());
    ctx.on("ctx-remove-complete", () => this.removeCompleteDownloads(false));
    ctx.on("ctx-remove-complete-all",
      () => this.removeCompleteDownloads(false));
    ctx.on("ctx-remove-complete-selected",
      () => this.removeCompleteDownloads(true));
    ctx.on("ctx-remove-domain",
      () => this.removeDomainDownloads(false));
    ctx.on("ctx-remove-complete-domain",
      () => this.removeDomainDownloads(true));
    ctx.on("ctx-remove-failed", () => this.removeFailedDownloads());
    ctx.on("ctx-remove-paused", () => this.removePausedDownloads());
    ctx.on("ctx-remove-batch", () => this.removeBatchDownloads());

    ctx.on("dismissed", () => this.table.focus());

    this.on("contextmenu", (tree, event) => {
      if (!this.selection.empty) {
        this.showContextMenu(event);
      }
      return true;
    });

    ctx.on("clicked", e => this.handleFilterRemove(e));

    const toolbar = new Buttons("#toolbar");
    toolbar.on("btn-add", () => PORT.post("showSingle"));

    this.resumeAction = new Broadcaster("btn-resume", "ctx-resume");
    this.resumeAction.onaction = this.resumeDownloads.bind(this, false);

    this.forceAction = new Broadcaster("ctx-force-download");
    this.forceAction.onaction = this.resumeDownloads.bind(this, true);

    this.pauseAction = new Broadcaster("btn-pause", "ctx-pause");
    this.pauseAction.onaction = this.pauseDownloads.bind(this);

    this.cancelAction = new Broadcaster("btn-cancel", "ctx-cancel");
    this.cancelAction.onaction = this.cancelDownloads.bind(this);

    this.openFileAction = new Broadcaster("ctx-open-file");
    this.openFileAction.onaction = this.openFile.bind(this);
    this.on("dblclick", () => this.openFile());

    this.openDirectoryAction = new Broadcaster("ctx-open-directory");
    this.openDirectoryAction.onaction = this.openDirectory.bind(this);

    const moveAction = (method: string) => {
      if (this.selection.empty) {
        return;
      }
      const d: any = this.downloads;
      d[method](Array.from(this.selection));
    };

    this.moveTopAction = new Broadcaster("btn-top", "ctx-move-top");
    this.moveTopAction.onaction = moveAction.bind(this, "moveTop");

    this.moveUpAction = new Broadcaster("btn-up", "ctx-move-up");
    this.moveUpAction.onaction = moveAction.bind(this, "moveUp");

    this.moveDownAction = new Broadcaster("btn-down", "ctx-move-down");
    this.moveDownAction.onaction = moveAction.bind(this, "moveDown");

    this.moveBottomAction = new Broadcaster("btn-bottom", "ctx-move-bottom");
    this.moveBottomAction.onaction = moveAction.bind(this, "moveBottom");

    this.disableSet = new Set([
      this.resumeAction,
      this.forceAction,
      this.pauseAction,
      this.cancelAction,
      this.moveTopAction,
      this.moveUpAction,
      this.moveDownAction,
      this.moveBottomAction,
      this.openFileAction,
      this.openDirectoryAction,
    ]);

    this.on(
      "selection-changed", debounce(this.selectionChanged.bind(this), 10));
    this.selection.clear();

    this.tooltip = null;
    this.on("hover", async info => {
      if (!(await Prefs.get("tooltip"))) {
        return;
      }
      const item = this.downloads.filtered[info.rowid];
      if (!item) {
        return;
      }
      if (this.tooltip) {
        this.tooltip.dismiss();
      }
      this.tooltip = new Tooltip(item, info);
    });
    this.on("hover-change", info => {
      if (!this.tooltip) {
        return;
      }
      this.tooltip.adjust(info);
    });
    this.on("hover-done", () => this.dismissTooltip());
    this.downloads.on("changed", () => this.dismissTooltip());
    this.contextMenu.on("showing", () => this.dismissTooltip());
    addEventListener("scroll", () => this.dismissTooltip(), {passive: true});
    addEventListener("wheel", () => this.dismissTooltip(), {passive: true});
    addEventListener("keydown", () => this.dismissTooltip(), {passive: true});
  }

  get rowCount() {
    return this.downloads.filtered.length;
  }

  updateCounts() {
    const {length: total} = this.downloads.items;
    const fTotal = prettyNumber(total);
    const fFin = prettyNumber(this.finished);
    const fDisp = prettyNumber(this.rowCount);
    const fRunning = prettyNumber(this.running.size);
    $("#statusItems").textContent = _(
      "manager-status-items",
      fFin,
      fTotal,
      fDisp,
      fRunning);
    if (total) {
      document.title = `[${fFin}/${fTotal}] - ${_("manager.title")}`;
    }
    else {
      document.title = _("manager.title");
    }
  }

  async updateRunning() {
    let sum = 0;
    for (const r of this.running) {
      const v = await r.updateStats();
      if (v >= 0) {
        sum += v;
      }
    }
    this.globalStats.add(sum);
    $("#statusSpeed").textContent = formatSpeed(this.globalStats.avg);
  }

  dismissTooltip() {
    if (!this.tooltip) {
      return;
    }
    this.tooltip.dismiss();
    this.tooltip = null;
  }

  async showContextMenu(event: MouseEvent) {
    const {contextMenu: ctx} = this;
    const filts = await filters();

    const prepareMenu = (prefix: string) => {
      const rem = (ctx.get(prefix) as SubMenuItem).menu;
      prefix += "-filter-";
      Array.from(rem).
        filter(e => e.startsWith(prefix)).
        forEach(e => rem.remove(e));
      for (const filt of filts.all) {
        if (filt.id === "deffilter-all") {
          continue;
        }
        const mi = new MenuItem(rem, `${prefix}-${filt.id}`, filt.label, {
          icon: this.icons.get(iconForPath(`file.${filt.icon || "bin"}`, ICON_BASE_SIZE))
        });
        rem.add(mi);
      }
    };

    prepareMenu("ctx-remove-complete");
    prepareMenu("ctx-remove");

    ctx.show(event);
  }

  setItems(items: any[]) {
    const savedStats = new Map(
      Array.from(this.running).map(item => [item.sessionId, item.stats]));
    this.running.clear();
    this.sids.clear();
    this.downloads.set(items.map(item => {
      const rv = new DownloadItem(this, item, savedStats.get(item.sessionId));
      this.sids.set(rv.sessionId, rv);
      return rv;
    }));
  }

  getSelectedItems() {
    const {filtered} = this.downloads;
    return Array.from(this.selection).map(e => filtered[e]);
  }

  getSelectedSids(allowedStates: number) {
    const {filtered} = this.downloads;
    const selected = Array.from(this.selection);
    const allowedItems = selected.filter(
      i => allowedStates & filtered[i].state);
    return allowedItems.map(i => filtered[i].sessionId);
  }

  selectionChanged() {
    const {empty} = this.selection;
    if (empty) {
      for (const d of this.disableSet) {
        d.disabled = true;
      }
      return;
    }

    for (const d of this.disableSet) {
      d.disabled = false;
    }

    const items = this.getSelectedItems();
    const states = items.reduce((p, c) => p |= c.state, 0);

    if (!(states & DownloadState.PAUSABLE)) {
      this.pauseAction.disabled = true;
    }

    if (!(states & DownloadState.RESUMABLE)) {
      this.resumeAction.disabled = true;
    }
    if (!(states & DownloadState.FORCABLE)) {
      this.forceAction.disabled = true;
    }

    if (!(states & DownloadState.CANCELABLE)) {
      this.cancelAction.disabled = true;
    }

    const item = this.focusRow >= 0 ?
      this.downloads.filtered[this.focusRow] :
      null;
    const canOpen = item && item.manId && item.state === DownloadState.DONE;
    const canOpenDirectory = item && item.manId;
    this.openFileAction.disabled = !canOpen;
    this.openDirectoryAction.disabled = !canOpenDirectory;
  }

  resumeDownloads(forced = false) {
    const sids = this.getSelectedSids(DownloadState.RESUMABLE);
    if (!sids.length) {
      return;
    }
    PORT.post("resume", {sids, forced});
  }

  pauseDownloads() {
    const sids = this.getSelectedSids(DownloadState.PAUSABLE);
    if (!sids.length) {
      return;
    }
    PORT.post("pause", {sids});
  }

  cancelDownloads() {
    const sids = this.getSelectedSids(DownloadState.CANCELABLE);
    if (!sids.length) {
      return;
    }
    PORT.post("cancel", {sids});
  }

  async openFile() {
    if (this.focusRow < 0) {
      return;
    }
    const item = this.downloads.filtered[this.focusRow];
    if (!item || !item.manId || item.state !== DownloadState.DONE) {
      return;
    }
    try {
      await downloads.open(item.manId);
    }
    catch (ex) {
      console.error(ex, ex.toString(), ex);
      PORT.post("missing", {sid: item.sessionId});
    }
  }

  async openDirectory() {
    if (this.focusRow < 0) {
      return;
    }
    const item = this.downloads.filtered[this.focusRow];
    if (!item || !item.manId) {
      return;
    }
    try {
      await downloads.show(item.manId);
    }
    catch (ex) {
      console.error(ex, ex.toString(), ex);
      PORT.post("missing", {sid: item.sessionId});
    }
  }

  removeDownloadsInternal(sids?: number[]) {
    if (!sids) {
      sids = [];
      for (const rowid of this.selection) {
        sids.push(this.downloads.filtered[rowid].sessionId);
      }
    }
    if (!sids.length) {
      return;
    }
    PORT.post("removeSids", {sids});
  }

  removeDownloadsByState(state: number, selectionOnly = false) {
    const branch = selectionOnly ? "filtered" : "items";
    const items = this.downloads[branch].filter(item => {
      if (selectionOnly && !this.selection.contains(item.filteredPosition)) {
        return false;
      }
      return item.state === state;
    }).map(i => i.sessionId);
    if (!items.length) {
      return;
    }
    this.removeDownloadsInternal(items);
  }

  async removeDownloads() {
    await new RemovalModalDialog(
      _("remove-download.question"), "remove-selected").show();
    this.removeDownloadsInternal();
  }

  async removeAllDownloads() {
    await new RemovalModalDialog(
      _("remove-all-downloads.question"), "remove-selected-all").show();
    this.removeDownloadsInternal(this.downloads.items.map(e => e.sessionId));
  }

  async removeCompleteDownloads(selected = false) {
    await new RemovalModalDialog(
      selected ?
        _("remove-selected-complete-downloads.question") :
        _("remove-complete-downloads.question"),
      selected ?
        "remove-selected-complete" :
        "remove-complete"
    ).show();
    this.removeDownloadsByState(DownloadState.DONE, selected);
  }

  async removeFailedDownloads() {
    await new RemovalModalDialog(
      _("remove-failed-downloads.question"),
      "remove-failed"
    ).show();
    this.removeDownloadsByState(DownloadState.CANCELED, false);
  }

  async removePausedDownloads() {
    await new RemovalModalDialog(
      _("remove-paused-downloads.question"),
      "remove-paused"
    ).show();
    this.removeDownloadsByState(DownloadState.PAUSED, false);
  }

  async removeMissingDownloads() {
    await new RemovalModalDialog(
      _("remove-missing-downloads.question"),
      "remove-missing"
    ).show();
    this.removeDownloadsByState(DownloadState.MISSING, false);
  }

  async removeDomainDownloads(complete = false) {
    if (this.focusRow < 0) {
      return;
    }
    const item = this.downloads.filtered[this.focusRow];
    if (!item) {
      return;
    }
    const {domain} = item;
    await new RemovalModalDialog(
      complete ?
        _("remove-domain-complete-downloads.question", domain) :
        _("remove-domain-downloads.question", domain),
      complete ?
        "remove-domain-complete" :
        "remove-domain"
    ).show();

    const items = this.downloads.items.filter(item => {
      if (complete && item.state !== DownloadState.DONE) {
        return false;
      }
      return item.domain === domain;
    }).map(i => i.sessionId);
    if (!items.length) {
      return;
    }
    this.removeDownloadsInternal(items);
  }

  async removeBatchDownloads(complete = false) {
    if (this.focusRow < 0) {
      return;
    }
    const item = this.downloads.filtered[this.focusRow];
    if (!item) {
      return;
    }
    const {batch} = item;
    await new RemovalModalDialog(
      complete ?
        _("remove-batch-complete-downloads.question", batch) :
        _("remove-batch-downloads.question", batch),
      complete ?
        "remove-batch-complete" :
        "remove-batch"
    ).show();

    const items = this.downloads.items.filter(item => {
      if (complete && item.state !== DownloadState.DONE) {
        return false;
      }
      return item.batch === batch;
    }).map(i => i.sessionId);
    if (!items.length) {
      return;
    }
    this.removeDownloadsInternal(items);
  }

  async handleFilterRemove(event: string) {
    const [prefix, id] = event.split("--", 2);
    if (!prefix || !id) {
      return;
    }
    let all = false;
    let branch;
    switch (prefix) {
    case "ctx-remove-filter":
      all = true;
      branch = "remove-filter-downloads";
      break;

    case "ctx-remove-complete-filter":
      all = false;
      branch = "remove-complete-filter-downloads";
      break;

    default:
      return;
    }

    const filter = (await filters()).get(id);
    if (!filter) {
      return;
    }
    await new RemovalModalDialog(
      _(`${branch}.question`, filter.label), `${branch}-${filter.id}`).show();

    const items = this.downloads.items.filter(item => {
      if (!all && item.state !== DownloadState.DONE) {
        return false;
      }
      return filter.match(item.usable);
    }).map(i => i.sessionId);
    if (!items.length) {
      return;
    }

    this.removeDownloadsInternal(items);
  }

  updateItems(items: any[]) {
    const newDownloads = [];
    for (const i of items) {
      const item = this.sids.get(i.sessionId);
      if (!item) {
        const rv = new DownloadItem(this, i);
        this.sids.set(rv.sessionId, rv);
        newDownloads.push(rv);
        continue;
      }
      item.updateDownload(i);
    }
    if (newDownloads) {
      this.downloads.add(newDownloads);
    }
  }

  updatedDownload(item: DownloadItem) {
    this.downloads.recalculateItem(item);
    if (item.isFiltered) {
      this.invalidateRow(item.filteredPosition);
    }
  }

  updatedState(
      item: DownloadItem, oldState: number | undefined, newState: number) {
    switch (oldState) {
    case DownloadState.RUNNING:
      this.running.delete(item);
      if (!this.running.size && this.runningTimer) {
        clearInterval(this.runningTimer);
        this.runningTimer = null;
        $("#statusSpeedContainer").classList.add("hidden");
      }
      break;

    case DownloadState.DONE:
      this.finished--;
      break;
    }
    switch (newState) {
    case DownloadState.RUNNING:
      this.running.add(item);
      if (!this.runningTimer) {
        this.runningTimer = setInterval(
          this.updateRunning.bind(this), RUNNING_TIMEOUT);
        this.updateRunning();
        $("#statusSpeedContainer").classList.remove("hidden");
      }
      break;

    case DownloadState.DONE:
      this.finished++;
      break;
    }
    this.selectionChanged();
    this.updateCounts();
  }


  removedItems(sids: number[]) {
    const ssids = new Set(sids);
    const items = this.downloads.items.filter(i => {
      if (!ssids.has(i.sessionId)) {
        return true;
      }
      this.running.delete(i);
      this.sids.delete(i.sessionId);
      if (i.state === DownloadState.DONE) {
        this.finished--;
      }
      return false;
    });
    this.downloads.set(items);
  }

  selectAll() {
    this.selection.add(0, this.rowCount - 1);
  }

  selectToggle() {
    this.selection.toggle(0, this.rowCount - 1);
  }

  getRowClasses(rowid: number) {
    const item = this.downloads.filtered[rowid];
    if (!item) {
      return null;
    }
    const cls = StateClasses.get(item.state);
    return cls && [cls] || null;
  }

  getCellIcon(rowid: number, colid: number) {
    if (!this.downloads.filtered.length) {
      return null;
    }
    const item = this.downloads.filtered[rowid];
    if (colid === COL_URL) {
      return this.icons.get(iconForPath(item.finalName, ICON_BASE_SIZE));
    }
    if (colid === COL_PROGRESS) {
      return StateIcons.get(item.state);
    }
    return null;
  }

  getCellType(rowid: number, colid: number) {
    if (colid === COL_PROGRESS) {
      return CellTypes.TYPE_PROGRESS;
    }
    return CellTypes.TYPE_TEXT;
  }

  getCellText(rowid: number, colid: number) {
    const item = this.downloads.filtered[rowid];
    if (!item) {
      return "";
    }
    switch (colid) {
    case COL_URL:
      return item.fmtName;

    case COL_DOMAIN:
      return item.fmtDomain;

    case COL_PER:
      return item.fmtPercent;

    case COL_SIZE:
      return item.fmtSize;

    case COL_ETA:
      return item.fmtETA;

    case COL_SPEED:
      return item.fmtSpeed;

    case COL_SEGS:
      return ""; // item.fmtSegments;

    case COL_MASK:
      return item.mask;
    }
    return "";
  }

  getCellProgress(rowid: number) {
    const item = this.downloads.filtered[rowid];
    if (!item) {
      return -1;
    }
    switch (item.state) {
    case DownloadState.QUEUED:
      return item.percent;

    case DownloadState.RUNNING:
      return item.percent || -1;

    case DownloadState.PAUSED:
      return item.percent || -1;

    case DownloadState.FINISHING:
      return 1;

    case DownloadState.DONE:
      return 1;

    case DownloadState.CANCELED:
      return 1;

    default:
      return -1;
    }
  }
}