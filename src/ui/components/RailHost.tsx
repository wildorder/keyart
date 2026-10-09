/**
 * The layout slot for the studio's right-hand rail.
 *
 * The rail must be a SIBLING of `<main>` — a real third column of the app shell —
 * so it spans the full viewport height beside both the header and the scrolling
 * workspace, and scrolls independently of them (the Cursor-style rail). But the
 * rail's content is owned deep inside the workspace, where the focused direction
 * and viewed version live.
 *
 * Rather than lifting all of that focus state up through the view switcher just to
 * hand it back down, {@link AppShell} renders the empty slot here and publishes the
 * host element on this context; the workspace portals its rail into it. The DOM
 * ends up in the correct place for the grid while the state stays where it belongs.
 *
 * The slot is `auto`-width in the shell grid, so with nothing portalled in it
 * collapses to zero and the shell is a plain two-column layout.
 */
import React, { createContext, useContext, useState } from "react";

const RailHostContext = createContext<HTMLElement | null>(null);

/**
 * The rail's host element, or null before the slot mounts (and on views that
 * render no rail). Callers portal into it and must handle the null case.
 */
export function useRailHost(): HTMLElement | null {
  return useContext(RailHostContext);
}

/**
 * Owns the host element and provides it to descendants. Wraps the whole shell so
 * that both `<main>`'s subtree (the portal source) and {@link RailSlot } (the
 * portal target) sit underneath one provider.
 */
export function RailHostProvider({ children }: { children: React.ReactNode }) {
  const [host, setHost] = useState<HTMLElement | null>(null);
  return (
    <RailHostContext.Provider value={host}>
      <RailHostSetter.Provider value={setHost}>{children}</RailHostSetter.Provider>
    </RailHostContext.Provider>
  );
}

const RailHostSetter = createContext<(el: HTMLElement | null) => void>(() => {});

/** The slot itself — renders the column the rail is portalled into. */
export function RailSlot() {
  const setHost = useContext(RailHostSetter);
  return <div className="app-rail" ref={setHost} />;
}
