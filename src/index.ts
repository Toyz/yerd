// Must stay the first import: decorated classes read Symbol.metadata when they're defined.
import "./polyfill.js";

export { yerd, YerdApp, BootError, type YerdOptions, type RunningServer, type ErrorPageProps, type Middleware, type LoggingOptions } from "./server/app.js";
export { guard, guards, createGuard, resetGuardRegistry, type GuardRef, type GuardSpec, type GuardFn } from "./decorators/guards.js";
export { Session, CookieStore, MemoryStore, seal, unseal, type SessionData, type SessionFields, type SessionShape, type SessionStore, type SessionRecord, type SessionOptions, type MemoryStoreOptions } from "./session/session.js";
export { parseCookies, serializeCookie, type CookieOptions } from "./server/cookies.js";
export { currentContext, setMeta, type YerdContext, type RouteInfo } from "./server/context.js";

export {
  route, group, get, post, put, patch, del, head, options, all, layout, noLayout, accepts, prerender, resetRouteRegistry, varies,
  type When, type WhenTest, type VerbDecorator,
} from "./decorators/route.js";
export type { Verb, RouteOptions, GroupOptions, PageMeta, LayoutProps, PrerenderOptions } from "./decorators/route.js";
export { createAccessor, args, type AccessorDecorator, type AccessorOptions, type Resolver, type Resolves } from "./decorators/kit.js";
export { readBody, readNdjson, type ParsedBody, type FormFields } from "./server/body.js";
export { YerdKey, createKey, localKey, registeredKeys, findLocalStore, metadataOf } from "./decorators/keys.js";
export { is, parse, dto, type Issue, type Spec, type IsDecorator, type IsOptions, type DtoClass } from "./decorators/dto.js";
export {
  param, params, query, header, request, body, field, file, files, signal, ndjsonBody, session, cookie,
  toInt, toNumber, toBool, trim, lower, oneOf, between, length, matches,
  type Transform, type Validator, type Pipe, type PipeOutput, type PipeError, type IsValidPipe,
  type FieldOptions, type FileOptions, type OptionalFieldOptions, type BodyOptions, type FieldOutput, type FieldDecorator,
} from "./decorators/request.js";

export { res, redirect, bare, HttpError, YerdResponse, type ResponseInit } from "./respond/response.js";
export { negotiate, parseAccept, type Negotiated, type Variants } from "./respond/negotiate.js";
export { Channels, ChannelBackend, MemoryBackend, channel, type ChannelRef, type SubscribeOptions } from "./live/channels.js";
export { sse, ndjson, event, type SseEvent, type SseEventInit, type SseOptions, type NdjsonOptions } from "./respond/stream.js";
export { Container, Scope, ServiceCollection, token, resolve, type Token, type ServiceKey, type Lifetime } from "./di/container.js";
export {
  service, singleton, scoped, transient, inject, maybe, onBoot, onShutdown, every, hosted, parseDuration, resetServiceRegistry,
  type ServiceOptions, type HostedService, type EveryOptions,
} from "./di/decorators.js";
export { renderToString, renderToStream, type RenderOptions } from "./render/render.js";
export { action, bind, ActionForm, type Action, type BoundAction } from "./actions/action.js";
export { assetUrl, useManifest, resetManifest, Stylesheet } from "./assets.js";
export { mimeType, type StaticOptions } from "./server/static.js";
export type { FormFiles } from "./server/body.js";
export { Form, Region, Scripts, RUNTIME_PATH, type FormProps, type RegionProps } from "./actions/components.js";
export { raw, escapeHtml, json, type RawHtml } from "./render/escape.js";
export { Dynamic, type DynamicProps } from "./render/dynamic.js";
export { Local, not, type LocalProps } from "./render/local.js";
export { Fragment, createElement, type Child, type Component, type YerdNode } from "./jsx/jsx-runtime.js";
export { status, setHeader, catches } from "./decorators/response.js";
export { isBot } from "./server/bots.js";
export { ILogger, teeLogger, type Level, type LogRecord, type SpanRecord } from "./log/ilogger.js";
export { Logger, log, logger } from "./log/logger.js";
export { ConsoleLogger, type ConsoleLoggerOptions } from "./log/console.js";
export { LogFilter } from "./log/filter.js";
export { instrument, type InstrumentOptions } from "./log/instrument.js";
export {
  attribute, resetAttributeRegistry,
  type AttributeDef, type AttributeOptions, type AttributeHandle, type ClientSetup, type RenderAttribute,
  type YerdClient, type PrefetchValue, type PrefetchMode,
} from "./attributes/attribute.js";
export type {
  CustomAttributes, GlobalAttributes, VoidAttributes, CSSProperties, EventHandler, FormActionValue, InputType, Nullable,
  HTMLElements, SVGElements, SVGAttributes, CustomElementAttributes, IntrinsicElements,
  AnchorAttributes, ButtonAttributes, FormAttributes, ImgAttributes, InputAttributes, LabelAttributes,
  LinkAttributes, MetaAttributes, OptionAttributes, ScriptAttributes, SelectAttributes, TextareaAttributes,
} from "./jsx/elements.js";
