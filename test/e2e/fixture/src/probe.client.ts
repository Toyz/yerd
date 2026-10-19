import type { IslandMount } from "@toyz/yerd/client";

export interface ProbeProps {
  name: string;
  n?: number;
}

/** What the islands did, for the tests to read: mounts and cleanups, in order. */
interface ProbeLog {
  mounts: string[];
  cleanups: string[];
}

function log(): ProbeLog {
  const w = window as unknown as { __probe?: ProbeLog };
  return (w.__probe ??= { mounts: [], cleanups: [] });
}

/** A test island: says it mounted (with its props) and records its mount and cleanup. */
const mount: IslandMount<ProbeProps> = (el, { name, n }) => {
  const label = n === undefined ? name : `${name} ${n}`;
  log().mounts.push(label);
  el.textContent = `Mounted ${label}`;
  el.setAttribute("data-mounted", label);
  return () => {
    log().cleanups.push(label);
  };
};

export default mount;
