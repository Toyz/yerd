// Node twin of @toyz/yerd/client. Selected by the "node" exports condition. M0
// stub: proves twin selection; M6 makes @island register for SSR.

export const side = "server" as const;

const islands = new Map<string, Function>();

export function island(value: Function, context: ClassDecoratorContext): void {
  islands.set(String(context.name), value);
}

export function registeredIslands(): ReadonlyMap<string, Function> {
  return islands;
}
