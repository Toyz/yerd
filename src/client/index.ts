// Browser twin of @toyz/yerd/client. Selected by the import map in the browser
// (and by the "default" exports condition). M0 stub: proves twin selection; M6
// fills in hydration, @state and the rest.

export const side = "browser" as const;

const islands = new Map<string, Function>();

export function island(value: Function, context: ClassDecoratorContext): void {
  islands.set(String(context.name), value);
}

export function registeredIslands(): ReadonlyMap<string, Function> {
  return islands;
}
