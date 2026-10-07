import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent
} from "react";
import { createPortal } from "react-dom";
import {
  ArrowLeft,
  ChevronDown,
  CircleAlert,
  FileText,
  History,
  PanelsTopLeft,
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
  onReturnToConversation?: () => void;
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
  onReturnToConversation,
  ariaControlsId,
  ariaLabel = "工作区页面",
  className = ""
}: WorkspaceBrowserTabsProps) {
  const rootRef = useRef<HTMLElement>(null);
  const popoverRef = useRef<HTMLElement>(null);
  const popoverId = useId();
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
  const hoveredRef = useRef(false);
  const clickOpenedRef = useRef(false);
  const focusSearchRef = useRef(false);
  const hoverTimerRef = useRef<number | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [allTabsOpen, setAllTabsOpen] = useState(false);
  const [tabQuery, setTabQuery] = useState("");
  const [popoverPosition, setPopoverPosition] = useState({ left: 0, top: 0, maxHeight: 480 });
  const reduceMotion = motion === "reduced" || (motion === "system" && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  const activeTab = tabs.find((tab) => tab.id === activeTabId);

  const containsNode = useCallback((node: Node | null) => Boolean(node && (
    rootRef.current?.contains(node) || popoverRef.current?.contains(node) || contextMenuRef.current?.contains(node)
  )), []);

  const clearHoverTimer = useCallback(() => {
    if (hoverTimerRef.current !== null) window.clearTimeout(hoverTimerRef.current);
    hoverTimerRef.current = null;
  }, []);

  const closePopover = useCallback(() => {
    clearHoverTimer();
    clickOpenedRef.current = false;
    setAllTabsOpen(false);
    setContextMenu(null);
  }, [clearHoverTimer]);

  const openPopover = (focusSearch: boolean) => {
    clearHoverTimer();
    if (focusSearch) clickOpenedRef.current = true;
    focusSearchRef.current = focusSearch;
    setAllTabsOpen(true);
    if (focusSearch) window.requestAnimationFrame(() => searchInputRef.current?.focus());
  };

  const scheduleClose = () => {
    clearHoverTimer();
    hoverTimerRef.current = window.setTimeout(() => {
      hoverTimerRef.current = null;
      if (hoveredRef.current || pointerDragRef.current || contextMenuRef.current || containsNode(document.activeElement)) return;
      closePopover();
    }, 300);
  };

  useLayoutEffect(() => {
    if (!allTabsOpen) return;
    const placePopover = () => {
      const rect = rootRef.current?.getBoundingClientRect();
      if (!rect) return;
      const width = Math.min(340, window.innerWidth - 20);
      const left = Math.max(10, Math.min(rect.right - width, window.innerWidth - width - 10));
      const top = Math.min(rect.bottom + 5, Math.max(10, window.innerHeight - 170));
      setPopoverPosition({ left, top, maxHeight: Math.min(480, window.innerHeight - top - 10) });
    };
    placePopover();
    window.addEventListener("resize", placePopover);
    return () => window.removeEventListener("resize", placePopover);
  }, [allTabsOpen]);

  useEffect(() => {
    if (!allTabsOpen) return;
    const activeButton = activeTabId ? tabButtonsRef.current.get(activeTabId) : undefined;
    activeButton?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeTabId, allTabsOpen]);

  useEffect(() => {
    if (!contextMenu && !allTabsOpen) return;
    const dismiss = (event: globalThis.MouseEvent) => {
      const target = event.target as Node;
      if (contextMenu && !(target instanceof Element && target.closest(".workspace-browser-tab-menu"))) setContextMenu(null);
      if (allTabsOpen && !containsNode(target)) closePopover();
    };
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (containsNode(document.activeElement)) event.preventDefault();
      if (contextMenu) {
        setContextMenu(null);
        focusTab(tabButtonsRef.current, contextMenu.tabId);
      } else {
        const restoreFocus = containsNode(document.activeElement);
        closePopover();
        if (restoreFocus) allTabsButtonRef.current?.focus();
      }
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
  }, [allTabsOpen, closePopover, containsNode, contextMenu]);

  useEffect(() => () => { clearHoverTimer(); dragGhostRef.current?.remove(); }, [clearHoverTimer]);

  useLayoutEffect(() => {
    const previous = pendingLayoutRef.current;
    if (!previous) return;
    pendingLayoutRef.current = null;
    if (reduceMotion) return;
    for (const [tabId, element] of tabElementsRef.current) {
      const oldRect = previous.get(tabId);
      if (!oldRect) continue;
      const newRect = element.getBoundingClientRect();
      const offsetY = oldRect.top - newRect.top;
      if (Math.abs(offsetY) < 1) continue;
      element.animate(
        [{ transform: `translate3d(0, ${offsetY}px, 0)` }, { transform: "translate3d(0, 0, 0)" }],
        { duration: 180, easing: "cubic-bezier(.2,.8,.2,1)" }
      );
    }
  }, [reduceMotion, tabs]);

  useEffect(() => {
    if (!allTabsOpen) return;
    if (focusSearchRef.current) window.requestAnimationFrame(() => searchInputRef.current?.focus());
    focusSearchRef.current = false;
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
    const index = filteredTabs.findIndex((tab) => tab.id === tabId);
    const fallbackId = filteredTabs[index + 1]?.id || filteredTabs[index - 1]?.id;
    onClose(tabId);
    window.requestAnimationFrame(() => {
      const fallback = fallbackId ? tabButtonsRef.current.get(fallbackId) : undefined;
      (fallback || searchInputRef.current || allTabsButtonRef.current)?.focus();
    });
  }, [filteredTabs, onClose]);

  const activateAndFocus = useCallback((tabId: string) => {
    onActivate(tabId);
    focusTab(tabButtonsRef.current, tabId);
  }, [onActivate]);

  const openContextMenu = useCallback((tabId: string, x: number, y: number) => {
    clearHoverTimer();
    setContextMenu({
      tabId,
      x: Math.max(8, Math.min(x, window.innerWidth - 206)),
      y: Math.max(8, Math.min(y, window.innerHeight - 300))
    });
  }, [clearHoverTimer]);

  const handleTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number, tab: WorkspaceBrowserTab) => {
    let nextIndex: number | null = null;
    if (event.ctrlKey && event.key === "PageUp") nextIndex = (index - 1 + filteredTabs.length) % filteredTabs.length;
    else if (event.ctrlKey && event.key === "PageDown") nextIndex = (index + 1) % filteredTabs.length;
    else if (event.key === "ArrowLeft") nextIndex = (index - 1 + filteredTabs.length) % filteredTabs.length;
    else if (event.key === "ArrowRight") nextIndex = (index + 1) % filteredTabs.length;
    else if (event.key === "ArrowUp") nextIndex = (index - 1 + filteredTabs.length) % filteredTabs.length;
    else if (event.key === "ArrowDown") nextIndex = (index + 1) % filteredTabs.length;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = filteredTabs.length - 1;
    else if ((event.ctrlKey || event.metaKey) && event.key.toLocaleLowerCase() === "w") {
      event.preventDefault();
      requestClose(tab.id);
      return;
    } else if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLocaleLowerCase() === "t" && recentlyClosedCount > 0) {
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
    activateAndFocus(filteredTabs[nextIndex].id);
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
      const side = event.clientY < rect.top + rect.height / 2 ? "before" : "after";
      targetElement.classList.add(`is-drop-${side}`);
      dropElementRef.current = targetElement;
      dropTargetRef.current = { tabId: targetTabId, side };
    }

    const track = trackRef.current;
    if (!track) return;
    const trackRect = track.getBoundingClientRect();
    if (event.clientY < trackRect.top + 24) track.scrollBy({ top: -18 });
    else if (event.clientY > trackRect.bottom - 24) track.scrollBy({ top: 18 });
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

  const menuTabIndex = contextMenu ? tabs.findIndex((tab) => tab.id === contextMenu.tabId) : -1;
  const menuTab = menuTabIndex >= 0 ? tabs[menuTabIndex] : undefined;

  if (!tabs.length) return null;
  return (
    <nav
      ref={rootRef}
      className={`workspace-browser-tabs motion-${motion} ${allTabsOpen ? "is-open" : ""} ${className}`.trim()}
      aria-label={ariaLabel}
      onPointerEnter={(event) => {
        if (event.pointerType !== "mouse") return;
        hoveredRef.current = true;
        clearHoverTimer();
        if (!allTabsOpen) hoverTimerRef.current = window.setTimeout(() => openPopover(false), 200);
      }}
      onPointerLeave={(event) => {
        if (event.pointerType !== "mouse") return;
        hoveredRef.current = false;
        scheduleClose();
      }}
      onBlur={(event) => {
        if (!containsNode(event.relatedTarget as Node | null)) scheduleClose();
      }}
    >
      {activeTab && activeTab.resource.kind !== "conversation" && onReturnToConversation && <button
        type="button"
        className="workspace-browser-tabs__return"
        aria-label="返回对话"
        title="返回对话"
        onClick={() => { closePopover(); onReturnToConversation(); }}
      ><ArrowLeft size={15} /></button>}
      <button
        ref={allTabsButtonRef}
        type="button"
        className="workspace-browser-tabs__current"
        aria-expanded={allTabsOpen}
        aria-haspopup="dialog"
        aria-controls={popoverId}
        aria-label="切换页面"
        title={activeTab?.detail ? `${activeTab.title}\n${activeTab.detail}` : activeTab?.title || "已打开页面"}
        onClick={() => {
          setContextMenu(null);
          if (allTabsOpen && clickOpenedRef.current) {
            closePopover();
          } else openPopover(true);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            openPopover(true);
          }
        }}
      >
        <span className="workspace-browser-tab__icon" aria-hidden="true">{activeTab ? <ResourceIcon tab={activeTab} conversationProviders={conversationProviders} /> : <PanelsTopLeft size={15} />}</span>
        <span className="workspace-browser-tabs__current-label">{activeTab?.resource.kind === "conversation" ? "页面" : activeTab?.title || "页面"}</span>
        {activeTab?.status === "loading" && <LoaderCircle className="workspace-browser-tab__status is-loading" size={13} aria-label="加载中" />}
        {activeTab?.status === "error" && <CircleAlert className="workspace-browser-tab__status is-error" size={13} aria-label="加载失败" />}
        <ChevronDown size={13} className="workspace-browser-tabs__chevron" aria-hidden="true" />
      </button>
      {allTabsOpen && createPortal(<section
        ref={popoverRef}
        id={popoverId}
        className={`workspace-browser-tabs__popover motion-${motion} ${reduceMotion ? "is-motion-reduced" : ""}`}
        role="dialog"
        aria-label="已打开页面"
        style={{ left: popoverPosition.left, top: popoverPosition.top, maxHeight: popoverPosition.maxHeight }}
        onPointerEnter={() => { hoveredRef.current = true; clearHoverTimer(); }}
        onPointerLeave={() => { hoveredRef.current = false; scheduleClose(); }}
        onBlur={(event) => { if (!containsNode(event.relatedTarget as Node | null)) scheduleClose(); }}
      >
        <div className="workspace-browser-tabs__popover-head"><strong>已打开页面</strong><span>{tabs.length}/{maxTabs}</span></div>
        <label className="workspace-browser-tabs__search">
          <Search size={14} aria-hidden="true" />
          <input
            ref={searchInputRef}
            value={tabQuery}
            onChange={(event) => setTabQuery(event.target.value)}
            placeholder="搜索页面"
            aria-label="搜索页面"
            onKeyDown={(event) => {
              if (event.key !== "ArrowDown" || !filteredTabs.length) return;
              event.preventDefault();
              focusTab(tabButtonsRef.current, filteredTabs[0].id);
            }}
          />
          {tabQuery && <button type="button" aria-label="清空页面搜索" onClick={() => { setTabQuery(""); searchInputRef.current?.focus(); }}><X size={13} /></button>}
        </label>
      <div ref={trackRef} className="workspace-browser-tabs__track" role="tablist" aria-orientation="vertical">
        {filteredTabs.map((tab, visibleIndex) => {
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
                tabIndex={active || (!filteredTabs.some((item) => item.id === activeTabId) && visibleIndex === 0) ? 0 : -1}
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
                onKeyDown={(event) => handleTabKeyDown(event, visibleIndex, tab)}
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
        {!filteredTabs.length && <p className="workspace-browser-tabs__empty">没有匹配的页面</p>}
      </div>
      <button
        type="button"
        className="workspace-browser-tabs__restore"
        disabled={recentlyClosedCount === 0}
        onClick={() => onReopenLastClosed()}
      ><History size={14} /><span>恢复最近关闭的页面</span>{recentlyClosedCount > 0 && <small>{recentlyClosedCount}</small>}</button>
      </section>, document.body)}
      {contextMenu && menuTab && (
        createPortal(<div
          ref={contextMenuRef}
          className="workspace-browser-tab-menu"
          role="menu"
          aria-label={`${menuTab.title} 标签操作`}
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onPointerEnter={() => clearHoverTimer()}
          onPointerLeave={scheduleClose}
          onBlur={(event) => { if (!containsNode(event.relatedTarget as Node | null)) scheduleClose(); }}
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
          <button type="button" role="menuitem" disabled={menuTabIndex === 0} onClick={() => { onMove(menuTab.id, menuTabIndex - 1); setContextMenu(null); }}>向上移动</button>
          <button type="button" role="menuitem" disabled={menuTabIndex === tabs.length - 1} onClick={() => { onMove(menuTab.id, menuTabIndex + 1); setContextMenu(null); }}>向下移动</button>
          <button type="button" role="menuitem" disabled={menuTabIndex === 0} onClick={() => { onMove(menuTab.id, 0); setContextMenu(null); }}>移到最前</button>
          <button type="button" role="menuitem" disabled={menuTabIndex === tabs.length - 1} onClick={() => { onMove(menuTab.id, tabs.length - 1); setContextMenu(null); }}>移到最后</button>
          <span className="workspace-browser-tab-menu__separator" role="separator" />
          <button type="button" role="menuitem" onClick={() => { requestClose(menuTab.id); setContextMenu(null); }}>关闭</button>
          <button type="button" role="menuitem" disabled={tabs.length <= 1} onClick={() => { onCloseOthers(menuTab.id); setContextMenu(null); focusTab(tabButtonsRef.current, menuTab.id); }}>关闭其他标签</button>
          <button type="button" role="menuitem" disabled={menuTabIndex === tabs.length - 1} onClick={() => { onCloseRight(menuTab.id); setContextMenu(null); focusTab(tabButtonsRef.current, menuTab.id); }}>关闭下方页面</button>
        </div>, document.body)
      )}
    </nav>
  );
}

export default WorkspaceBrowserTabs;
