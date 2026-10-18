// Compile-only: is.* pipelines decide the field type and are checked step by step.
import { is, trim } from "@toyz/yerd";

type Uuid = string & { readonly __brand: "Uuid" };
declare function toUuid(value: string): Uuid;
declare function toNumber(value: string): number;

export class Ok {
  @is.string({ transform: [trim, toUuid] }) id!: Uuid;
  @is.string({ transform: toNumber, validate: (n: number) => n > 0 }) n!: number;
  @is.string({ transform: [trim, toUuid], optional: true }) maybe?: Uuid;
  @is.uuid() plain!: string;
  @is.date() at!: Date;
}

export class Wrong {
  // @ts-expect-error the pipeline makes a Uuid, not a number
  @is.string({ transform: [trim, toUuid] }) id!: number;
  // @ts-expect-error toUuid takes a string, but toNumber made a number
  @is.string({ transform: [toNumber, toUuid] }) bad!: Uuid;
  // @ts-expect-error optional fields must allow undefined
  @is.string({ transform: toUuid, optional: true }) required!: Uuid;
}
