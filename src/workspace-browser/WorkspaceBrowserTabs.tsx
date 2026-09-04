import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent
} from "react";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  FileText,
  History,
  ListFilter,
  LoaderCircle,
  Pin,
  PinOff,
  Route,
  Search,
  Wrench,
  X
} from "lucide-react";
import { ProductLogo } from "../branding/ProductLogo";
import { ProviderIcon } from "../branding/ProviderIcon";
import type { WorkspaceBrowserTab } from "./browserTabState";
import "./WorkspaceBrowserTabs.css";

export type WorkspaceBrowserConversationProvider = {
  providerId: string;
  icon?: string;
  accent?: string;
};

export type WorkspaceBrowserTabsProps = {
  tabs: readonly WorkspaceBrowserTab[];
  conversationProviders?: Readonly<Record<string, WorkspaceBrowserConversationProvider>>;
  activeTabId: string | null;
  maxTabs: number;
  motion?: "system" | "full" | "reduced";
  recentlyClosedCount: number;
  onActivate: (tabId: string) => void;
  onClose: (tabId: string) => void;
  onCloseOthers: (tabId: string) => void;
  onCloseRight: (tabId: string) => void;
  onMove: (tabId: string, targetIndex: number) => void;
  onPinnedChange: (tabId: string, pinned: boolean) => void;
  onReopenLastClosed: () => void;
  ariaControlsId?: string;
  ariaLabel?: string;
  className?: string;
};

type DropTarget = { tabId: string; side: "before" | "after" };
type ContextMenuState = { tabId: string; x: number; y: number };
type PointerDragState = {
  sourceId: string;
  pointerId: number;
  originX: number;
  originY: number;
  grabOffsetX: number;
  grabOffsetY: number;
  dragging: boolean;
};

const POINTER_DRAG_THRESHOLD = 5;

function ResourceIcon({ tab, conversationProviders }: { tab: WorkspaceBrowserTab; conversationProviders?: WorkspaceBrowserTabsProps["conversationProviders"] }) {
  if (tab.resource.kind === "conversation") {
    const provider = conversationProviders?.[tab.resource.conversationId];
    return provider
      ? <ProviderIcon provider={provider.providerId} icon={provider.icon} accent={provider.accent} size={15} className="workspace-browser-tab__provider-icon" />
      : <ProductLogo variant="mark" className="workspace-browser-tab__product-logo" />;
  }
  if (tab.resource.kind === "file") return <FileText size={15} />;
  if (tab.resource.kind === "workflow") return <Route size={15} />;
  return <Wrench size={15} />;
}

function moveTargetIndex(sourceIndex: number, targetIndex: number, side: DropTarget["side"]) {
  if (sourceIndex < targetIndex) return side === "before" ? targetIndex - 1 : targetIndex;
  if (sourceIndex > targetIndex) return side === "before" ? targetIndex : targetIndex + 1;
  return sourceIndex;
}

function focusTab(buttons: Map<string, HTMLButtonElement>, tabId: string | undefined) {
  if (!tabId) return;
  window.requestAnimationFrame(() => buttons.get(tabId)?.focus());
}

export function WorkspaceBrowserTabs({
  tabs,
  conversationProviders,
  activeTabId,
  maxTabs,
  motion = "system",
  recentlyClosedCount,
  onActivate,
  onClose,
  onCloseOthers,
  onCloseRight,
  onMove,
  onPinnedChange,
  onReopenLastClosed,
  ariaControlsId,
  ariaLabel = "工作区页面",
  className = ""
}: WorkspaceBrowserTabsProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const tabButtonsRef = useRef(new Map<string, HTMLButtonElement>());
  const tabElementsRef = useRef(new Map<string, HTMLDivElement>());
  const allTabsButtonRef = useRef<HTMLButtonElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const pointerDragRef = useRef<PointerDragState | null>(null);
  const dropTargetRef = useRef<DropTarget | null>(null);
  const dragElementRef = useRef<HTMLElement | null>(null);
  const dropElementRef = useRef<HTMLElement | null>(null);
  const dragGhostRef = useRef<HTMLElement | null>(null);
  const pendingLayoutRef = useRef<Map<string, DOMRect> | null>(null);
  const suppressClickRef = useRef(false);
  const [overflow, setOverflow] = useState({ left: false, right: false, active: false });
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [allTabsOpen, setAllTabsOpen] = useState(false);
  const [tabQuery, setTabQuery] = useState("");
  const reduceMotion = motion === "reduced" || (motion === "system" && window.matchMedia("(prefers-reduced-motion: reduce)").matches);

  const updateOverflow = useCallback(() => {
    const track = trackRef.current;
    if (!track) return;
    const active = track.scrollWidth > track.clientWidth + 1;
    setOverflow({
      active,
      left: active && track.scrollLeft > 1,
      right: active && track.scrollLeft + track.clientWidth < track.scrollWidth - 1
    });
  }, []);

  useEffect(() => {
    const track = trackRef.current;
    if (!track) return;
    const observer = new ResizeObserver(updateOverflow);
    observer.observe(track);
    for (const child of track.children) observer.observe(child);
    track.addEventListener("scroll", updateOverflow, { passive: true });
    updateOverflow();
    return () => {
      observer.disconnect();
      track.removeEventListener("scroll", updateOverflow);
    };
  }, [tabs.length, updateOverflow]);

  useEffect(() => {
    const activeButton = activeTabId ? tabButtonsRef.current.get(activeTabId) : undefined;
    activeButton?.scrollIntoView({ block: "nearest", inline: "nearest" });
    updateOverflow();
  }, [activeTabId, updateOverflow]);

  useEffect(() => {
    if (!contextMenu && !allTabsOpen) return;
    const dismiss = (event: globalThis.MouseEvent) => {
      const target = event.target as Node;
      if (contextMenu && !(target instanceof Element && target.closest(".workspace-browser-tab-menu"))) setContextMenu(null);
      if (allTabsOpen && !(target instanceof Element && target.closest(".workspace-browser-tabs__all-wrap"))) setAllTabsOpen(false);
    };
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setContextMenu(null);
      setAllTabsOpen(false);
      allTabsButtonRef.current?.focus();
    };
    const dismissContextMenu = () => { setContextMenu(null); };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", escape);
    window.addEventListener("resize", dismissContextMenu);
    window.addEventListener("scroll", dismissContextMenu, true);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", escape);
      window.removeEventListener("resize", dismissContextMenu);
      window.removeEventListener("scroll", dismissContextMenu, true);
    };
  }, [allTabsOpen, contextMenu]);

  useEffect(() => () => { dragGhostRef.current?.remove(); }, []);

  useLayoutEffect(() => {
    const previous = pendingLayoutRef.current;
    if (!previous) return;
    pendingLayoutRef.current = null;
    if (reduceMotion) return;
    for (const [tabId, element] of tabElementsRef.current) {
      const oldRect = previous.get(tabId);
      if (!oldRect) continue;
      const newRect = element.getBoundingClientRect();
      const offsetX = oldRect.left - newRect.left;
      if (Math.abs(offsetX) < 1) continue;
      element.animate(
        [{ transform: `translate3d(${offsetX}px, 0, 0)` }, { transform: "translate3d(0, 0, 0)" }],
        { duration: 180, easing: "cubic-bezier(.2,.8,.2,1)" }
      );
    }
  }, [reduceMotion, tabs]);

  useEffect(() => {
    if (!allTabsOpen) return;
    setTabQuery("");
    window.requestAnimationFrame(() => searchInputRef.current?.focus());
  }, [allTabsOpen]);

  useEffect(() => {
    if (!contextMenu) return;
    window.requestAnimationFrame(() => {
      contextMenuRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    });
  }, [contextMenu]);

  const filteredTabs = useMemo(() => {
    const query = tabQuery.trim().toLocaleLowerCase();
    if (!query) return tabs;
    return tabs.filter((tab) => `${tab.title} ${tab.detail || ""} ${tab.resource.kind}`.toLocaleLowerCase().includes(query));
  }, [tabQuery, tabs]);

  const requestClose = useCallback((tabId: string) => {
    const index = tabs.findIndex((tab) => tab.id === tabId);
    const fallbackId = tabs[index + 1]?.id || tabs[index - 1]?.id;
    onClose(tabId);
    focusTab(tabButtonsRef.current, fallbackId);
  }, [onClose, tabs]);

  const activateAndFocus = useCallback((tabId: string) => {
    onActivate(tabId);
    focusTab(tabButtonsRef.current, tabId);
  }, [onActivate]);

  const openContextMenu = useCallback((tabId: string, x: number, y: number) => {
    setAllTabsOpen(false);
    setContextMenu({
      tabId,
      x: Math.max(8, Math.min(x, window.innerWidth - 206)),
      y: Math.max(8, Math.min(y, window.innerHeight - 300))
    });
  }, []);

  const handleTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number, tab: WorkspaceBrowserTab) => {
    let nextIndex: number | null = null;
    if (event.ctrlKey && event.key === "PageUp") nextIndex = (index - 1 + tabs.length) % tabs.length;
    else if (event.ctrlKey && event.key === "PageDown") nextIndex = (index + 1) % tabs.length;
    else if (event.key === "ArrowLeft") nextIndex = (index - 1 + tabs.length) % tabs.length;
    else if (event.key === "ArrowRight") nextIndex = (index + 1) % tabs.length;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = tabs.length - 1;
    else if (event.ctrlKey && event.key.toLocaleLowerCase() === "w") {
      event.preventDefault();
      requestClose(tab.id);
      return;
    } else if (event.ctrlKey && event.shiftKey && event.key.toLocaleLowerCase() === "t" && recentlyClosedCount > 0) {
      event.preventDefault();
      onReopenLastClosed();
      return;
    } else if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
      event.preventDefault();
      const rect = event.currentTarget.getBoundingClientRect();
      openContextMenu(tab.id, rect.left + 12, rect.bottom - 2);
      return;
    }
    if (nextIndex === null) return;
    event.preventDefault();
    activateAndFocus(tabs[nextIndex].id);
  };

  const clearPointerDragVisuals = () => {
    dragElementRef.current?.classList.remove("is-dragging");
    dropElementRef.current?.classList.remove("is-drop-before", "is-drop-after");
    dragElementRef.current = null;
    dropElementRef.current = null;
  };

  const removeDragGhost = () => {
    dragGhostRef.current?.remove();
    dragGhostRef.current = null;
  };

  const createDragGhost = (source: HTMLElement, drag: PointerDragState) => {
    removeDragGhost();
    const rect = source.getBoundingClientRect();
    const ghost = source.cloneNode(true) as HTMLElement;
    ghost.className = `workspace-browser-tab-drag-ghost motion-${motion}`;
    ghost.removeAttribute("data-tab-id");
    ghost.setAttribute("aria-hidden", "true");
    ghost.style.width = `${rect.width}px`;
    ghost.style.height = `${rect.height}px`;
    ghost.style.transform = `translate3d(${drag.originX - drag.grabOffsetX}px, ${drag.originY - drag.grabOffsetY}px, 0)`;
    document.body.appendChild(ghost);
    dragGhostRef.current = ghost;
  };

  const resetPointerDrag = (button?: HTMLButtonElement, pointerId?: number, removeGhost = true) => {
    if (button && pointerId !== undefined && button.hasPointerCapture(pointerId)) {
      button.releasePointerCapture(pointerId);
    }
    clearPointerDragVisuals();
    pointerDragRef.current = null;
    dropTargetRef.current = null;
    if (removeGhost) removeDragGhost();
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLButtonElement>, tabId: string) => {
    if (!event.isPrimary || event.button !== 0) return;
    const rect = event.currentTarget.closest<HTMLElement>(".workspace-browser-tab")?.getBoundingClientRect()
      || event.currentTarget.getBoundingClientRect();
    pointerDragRef.current = {
      sourceId: tabId,
      pointerId: event.pointerId,
      originX: event.clientX,
      originY: event.clientY,
      grabOffsetX: event.clientX - rect.left,
      grabOffsetY: event.clientY - rect.top,
      dragging: false
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = pointerDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (!drag.dragging) {
      const distance = Math.hypot(event.clientX - drag.originX, event.clientY - drag.originY);
      if (distance < POINTER_DRAG_THRESHOLD) return;
      drag.dragging = true;
      suppressClickRef.current = true;
      const sourceElement = event.currentTarget.closest<HTMLElement>(".workspace-browser-tab");
      sourceElement?.classList.add("is-dragging");
      dragElementRef.current = sourceElement;
      if (sourceElement) createDragGhost(sourceElement, drag);
    }
    event.preventDefault();

    if (dragGhostRef.current) {
      dragGhostRef.current.style.transform = `translate3d(${event.clientX - drag.grabOffsetX}px, ${event.clientY - drag.grabOffsetY}px, 0)`;
    }

    const targetElement = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>(".workspace-browser-tab[data-tab-id]");
    const targetTabId = targetElement?.dataset.tabId;
    dropElementRef.current?.classList.remove("is-drop-before", "is-drop-after");
    dropElementRef.current = null;
    dropTargetRef.current = null;
    if (targetElement && targetTabId && targetTabId !== drag.sourceId) {
      const rect = targetElement.getBoundingClientRect();
      const side = event.clientX < rect.left + rect.width / 2 ? "before" : "after";
      targetElement.classList.add(`is-drop-${side}`);
      dropElementRef.current = targetElement;
      dropTargetRef.current = { tabId: targetTabId, side };
    }

    const track = trackRef.current;
    if (!track) return;
    const trackRect = track.getBoundingClientRect();
    if (event.clientX < trackRect.left + 36) track.scrollBy({ left: -22 });
    else if (event.clientX > trackRect.right - 36) track.scrollBy({ left: 22 });
  };

  const handlePointerUp = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = pointerDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const sourceId = drag.sourceId;
    const target = dropTargetRef.current;
    const sourceIndex = tabs.findIndex((tab) => tab.id === sourceId);
    const targetIndex = target ? tabs.findIndex((tab) => tab.id === target.tabId) : -1;
    const sourceRect = dragElementRef.current?.getBoundingClientRect();
    const landingRect = dropElementRef.current?.getBoundingClientRect() || sourceRect;
    if (drag.dragging && target && sourceIndex >= 0 && targetIndex >= 0) {
      pendingLayoutRef.current = new Map(
        Array.from(tabElementsRef.current, ([tabId, element]) => [tabId, element.getBoundingClientRect()])
      );
      onMove(sourceId, moveTargetIndex(sourceIndex, targetIndex, target.side));
    }
    const ghost = dragGhostRef.current;
    resetPointerDrag(event.currentTarget, event.pointerId, false);
    if (ghost && landingRect && !reduceMotion) {
      ghost.classList.add("is-settling");
      ghost.style.transform = `translate3d(${landingRect.left}px, ${landingRect.top}px, 0)`;
      ghost.addEventListener("transitionend", () => ghost.remove(), { once: true });
      window.setTimeout(() => ghost.remove(), 220);
      dragGhostRef.current = null;
    } else {
      removeDragGhost();
    }
    if (drag.dragging) window.setTimeout(() => { suppressClickRef.current = false; }, 0);
  };

  const handleWheel = (event: WheelEvent<HTMLDivElement>) => {
    const track = trackRef.current;
    if (!track || !overflow.active || Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return;
    event.preventDefault();
    track.scrollBy({ left: event.deltaY });
  };

  const menuTabIndex = contextMenu ? tabs.findIndex((tab) => tab.id === contextMenu.tabId) : -1;
  const menuTab = menuTabIndex >= 0 ? tabs[menuTabIndex] : undefined;

  if (!tabs.length) return null;
  return (
    <nav className={`workspace-browser-tabs motion-${motion} ${className}`.trim()} aria-label={ariaLabel}>
      {overflow.active && (
        <button
          type="button"
          className="workspace-browser-tabs__scroll"
          aria-label="向左滚动标签"
          disabled={!overflow.left}
          onClick={() => trackRef.current?.scrollBy({ left: -Math.max(180, trackRef.current.clientWidth * 0.7), behavior: "smooth" })}
        >
          <ChevronLeft size={15} />
        </button>
      )}
      <div ref={trackRef} className="workspace-browser-tabs__track" role="tablist" aria-orientation="horizontal" onWheel={handleWheel}>
        {tabs.map((tab, index) => {
          const active = tab.id === activeTabId;
          return (
            <div
              ref={(node) => { if (node) tabElementsRef.current.set(tab.id, node); else tabElementsRef.current.delete(tab.id); }}
              className={`workspace-browser-tab ${active ? "is-active" : ""} ${tab.pinned ? "is-pinned" : ""} ${tab.transient ? "is-transient" : ""}`.trim()}
              data-resource-kind={tab.resource.kind}
              data-tab-id={tab.id}
              key={tab.id}
              onContextMenu={(event: ReactMouseEvent) => {
                event.preventDefault();
                openContextMenu(tab.id, event.clientX, event.clientY);
              }}
            >
              <button
                ref={(node) => { if (node) tabButtonsRef.current.set(tab.id, node); else tabButtonsRef.current.delete(tab.id); }}
                type="button"
                className="workspace-browser-tab__main"
                role="tab"
                aria-controls={ariaControlsId}
                aria-selected={active}
                tabIndex={active || (activeTabId === null && index === 0) ? 0 : -1}
                title={tab.detail ? `${tab.title}\n${tab.detail}` : tab.title}
                onClick={() => {
                  if (suppressClickRef.current) {
                    suppressClickRef.current = false;
                    return;
                  }
                  onActivate(tab.id);
                }}
                onAuxClick={(event) => {
                  if (event.button !== 1) return;
                  event.preventDefault();
                  requestClose(tab.id);
                }}
                onDoubleClick={() => { if (!tab.pinned) onPinnedChange(tab.id, true); }}
                onKeyDown={(event) => handleTabKeyDown(event, index, tab)}
                onPointerDown={(event) => handlePointerDown(event, tab.id)}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerUp}
                onPointerCancel={(event) => {
                  suppressClickRef.current = false;
                  resetPointerDrag(event.currentTarget, event.pointerId);
                }}
              >
                <span className="workspace-browser-tab__icon" aria-hidden="true"><ResourceIcon tab={tab} conversationProviders={conversationProviders} /></span>
                <span className="workspace-browser-tab__labels">
                  <span className="workspace-browser-tab__title">{tab.title}</span>
                  {tab.detail && <span className="workspace-browser-tab__detail">{tab.detail}</span>}
                </span>
                {tab.status === "loading" && <LoaderCircle className="workspace-browser-tab__status is-loading" size={13} aria-label="加载中" />}
                {tab.status === "error" && <CircleAlert className="workspace-browser-tab__status is-error" size={13} aria-label="加载失败" />}
                {tab.dirty && <span className="workspace-browser-tab__dirty" aria-label="内容已变化" />}
              </button>
              <span className="workspace-browser-tab__actions">
                <button
                  type="button"
                  className="workspace-browser-tab__action workspace-browser-tab__pin"
                  aria-label={tab.pinned ? `取消固定 ${tab.title}` : `固定 ${tab.title}`}
                  title={tab.pinned ? "取消固定" : "固定"}
                  onClick={() => onPinnedChange(tab.id, !tab.pinned)}
                >
                  {tab.pinned ? <PinOff size={13} /> : <Pin size={13} />}
                </button>
                <button
                  type="button"
                  className="workspace-browser-tab__action workspace-browser-tab__close"
                  aria-label={`关闭 ${tab.title}`}
                  title="关闭"
                  onClick={() => requestClose(tab.id)}
                >
                  <X size={14} />
                </button>
              </span>
            </div>
          );
        })}
      </div>
      {overflow.active && (
        <button
          type="button"
          className="workspace-browser-tabs__scroll"
          aria-label="向右滚动标签"
          disabled={!overflow.right}
          onClick={() => trackRef.current?.scrollBy({ left: Math.max(180, trackRef.current.clientWidth * 0.7), behavior: "smooth" })}
        >
          <ChevronRight size={15} />
        </button>
      )}
      <div className="workspace-browser-tabs__all-wrap">
        <button
          ref={allTabsButtonRef}
          type="button"
          className={`workspace-browser-tabs__all ${allTabsOpen ? "is-open" : ""}`}
          aria-expanded={allTabsOpen}
          aria-haspopup="dialog"
          aria-label={`全部标签，已打开 ${tabs.length} 个，最多 ${maxTabs} 个`}
          title="全部标签"
          onClick={() => { setContextMenu(null); setAllTabsOpen((open) => !open); }}
        >
          <ListFilter size={15} />
          <span>{tabs.length}/{maxTabs}</span>
        </button>
        {allTabsOpen && (
          <section className="workspace-browser-tabs__popover" role="dialog" aria-label="全部标签">
            <div className="workspace-browser-tabs__popover-head">
              <strong>全部标签</strong>
              <span>{tabs.length}/{maxTabs}</span>
            </div>
            <label className="workspace-browser-tabs__search">
              <Search size={14} aria-hidden="true" />
              <input
                ref={searchInputRef}
                value={tabQuery}
                onChange={(event) => setTabQuery(event.target.value)}
                placeholder="搜索标签"
                aria-label="搜索标签"
              />
            </label>
            <div className="workspace-browser-tabs__list">
              {filteredTabs.map((tab) => (
                <button
                  type="button"
                  className={tab.id === activeTabId ? "is-active" : ""}
                  key={tab.id}
                  onClick={() => { activateAndFocus(tab.id); setAllTabsOpen(false); }}
                >
                  <ResourceIcon tab={tab} conversationProviders={conversationProviders} />
                  <span><strong>{tab.title}</strong>{tab.detail && <small>{tab.detail}</small>}</span>
                  {tab.id === activeTabId && <Check size={14} aria-label="当前标签" />}
                </button>
              ))}
              {!filteredTabs.length && <p>没有匹配的标签</p>}
            </div>
            <button
              type="button"
              className="workspace-browser-tabs__restore"
              disabled={recentlyClosedCount === 0}
              onClick={() => { onReopenLastClosed(); setAllTabsOpen(false); }}
            >
              <History size={14} />
              <span>恢复最近关闭的标签</span>
              {recentlyClosedCount > 0 && <small>{recentlyClosedCount}</small>}
            </button>
          </section>
        )}
      </div>
      {contextMenu && menuTab && (
        <div
          ref={contextMenuRef}
          className="workspace-browser-tab-menu"
          role="menu"
          aria-label={`${menuTab.title} 标签操作`}
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onContextMenu={(event) => event.preventDefault()}
          onKeyDown={(event) => {
            const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
            const currentIndex = buttons.indexOf(document.activeElement as HTMLButtonElement);
            let nextIndex: number | null = null;
            if (event.key === "ArrowDown") nextIndex = (currentIndex + 1) % buttons.length;
            else if (event.key === "ArrowUp") nextIndex = (currentIndex - 1 + buttons.length) % buttons.length;
            else if (event.key === "Home") nextIndex = 0;
            else if (event.key === "End") nextIndex = buttons.length - 1;
            if (nextIndex === null || !buttons.length) return;
            event.preventDefault();
            buttons[nextIndex]?.focus();
          }}
        >
          <button type="button" role="menuitem" disabled={menuTabIndex === 0} onClick={() => { onMove(menuTab.id, menuTabIndex - 1); setContextMenu(null); }}>向左移动</button>
          <button type="button" role="menuitem" disabled={menuTabIndex === tabs.length - 1} onClick={() => { onMove(menuTab.id, menuTabIndex + 1); setContextMenu(null); }}>向右移动</button>
          <button type="button" role="menuitem" disabled={menuTabIndex === 0} onClick={() => { onMove(menuTab.id, 0); setContextMenu(null); }}>移到最前</button>
          <button type="button" role="menuitem" disabled={menuTabIndex === tabs.length - 1} onClick={() => { onMove(menuTab.id, tabs.length - 1); setContextMenu(null); }}>移到最后</button>
          <span className="workspace-browser-tab-menu__separator" role="separator" />
          <button type="button" role="menuitem" onClick={() => { requestClose(menuTab.id); setContextMenu(null); }}>关闭</button>
          <button type="button" role="menuitem" disabled={tabs.length <= 1} onClick={() => { onCloseOthers(menuTab.id); setContextMenu(null); focusTab(tabButtonsRef.current, menuTab.id); }}>关闭其他标签</button>
          <button type="button" role="menuitem" disabled={menuTabIndex === tabs.length - 1} onClick={() => { onCloseRight(menuTab.id); setContextMenu(null); focusTab(tabButtonsRef.current, menuTab.id); }}>关闭右侧标签</button>
        </div>
      )}
    </nav>
  );
}

export default WorkspaceBrowserTabs;
