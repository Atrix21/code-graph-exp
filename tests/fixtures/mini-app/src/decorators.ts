// Tiny local decorator stubs (no @nestjs dependency).
export function Injectable(): ClassDecorator { return () => undefined; }
export function Controller(prefix?: string): ClassDecorator { void prefix; return () => undefined; }
export function Module(meta: object): ClassDecorator { void meta; return () => undefined; }
export function Get(path?: string): MethodDecorator { void path; return () => undefined; }
export function Post(path?: string): MethodDecorator { void path; return () => undefined; }
export function Entity(name?: string): ClassDecorator { void name; return () => undefined; }
